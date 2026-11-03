"""vLLM launcher + shared-secret auth proxy + heartbeat.

Run inside the Kaggle notebook (GPU):
    python -m skilly_kaggle.serve
Env: SKILLY_SHARED_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY, optional SKILLY_MODEL / SKILLY_PROXY_PORT.
cloudflared then exposes http://localhost:$SKILLY_PROXY_PORT to the Worker's KAGGLE_BASE_URL.
"""

from __future__ import annotations

import hmac
import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Protocol

SECRET_HEADER = "X-Skilly-Secret"
SERVED_MODEL_NAME = "qwen3-vl-8b"  # must match worker/src/llm/kaggle.ts KAGGLE_MODEL
DEFAULT_MODEL = "Qwen/Qwen3-VL-8B-Instruct"
ALLOWED = {("POST", "/v1/chat/completions"), ("GET", "/health")}
MAX_BODY = 12 * 1024 * 1024  # an inline image as base64 plus the prompt


def vllm_command(model: str, port: int = 8000, gpus: int = 2) -> list[str]:
    """vLLM flags for Kaggle T4 x2: fp16 (T4 has no bf16), tool calling for the bot's tool loop, one image per prompt."""
    return [
        "vllm", "serve", model,
        "--served-model-name", SERVED_MODEL_NAME,
        "--host", "127.0.0.1", "--port", str(port),
        "--dtype", "half",
        "--tensor-parallel-size", str(gpus),
        "--max-model-len", "8192",
        "--gpu-memory-utilization", "0.90",
        "--limit-mm-per-prompt", '{"image": 1}',
        "--enable-auto-tool-choice", "--tool-call-parser", "hermes",
    ]


def make_handler(secret: str, upstream: str) -> type[BaseHTTPRequestHandler]:
    """Proxy handler: rejects anything without the shared secret; streams the upstream response through."""

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args: object) -> None:  # no request logging (prompts are personal data)
            pass

        def _reply(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self) -> bool:
            given = self.headers.get(SECRET_HEADER, "")
            return bool(secret) and hmac.compare_digest(given.encode(), secret.encode())

        def _proxy(self, method: str) -> None:
            path = self.path.split("?", 1)[0]
            if (method, path) not in ALLOWED:
                return self._reply(404, {"error": "not found"})
            if not self._authorized():
                return self._reply(401, {"error": "unauthorized"})
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self._reply(413, {"error": "too large"})
            body = self.rfile.read(length) if length else None
            req = urllib.request.Request(upstream + path, data=body, method=method, headers={"Content-Type": "application/json"})
            try:
                res = urllib.request.urlopen(req, timeout=120)
            except urllib.error.HTTPError as e:
                return self._reply(e.code, {"error": "upstream error"})
            except (urllib.error.URLError, TimeoutError):
                return self._reply(502, {"error": "upstream unavailable"})
            with res:
                self.send_response(res.status)
                self.send_header("Content-Type", res.headers.get("Content-Type", "application/json"))
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                while chunk := res.read1(8192) if hasattr(res, "read1") else res.read(8192):
                    self.wfile.write(f"{len(chunk):X}\r\n".encode() + chunk + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")

        def do_GET(self) -> None:  # noqa: N802
            self._proxy("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._proxy("POST")

    return Handler


class Rpc(Protocol):
    def rpc(self, fn: str, args: dict) -> list[dict]: ...


def upstream_healthy(upstream: str, timeout: float = 5.0) -> bool:
    try:
        with urllib.request.urlopen(upstream + "/health", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def heartbeat_once(store: Rpc, healthy: Callable[[], bool], model: str) -> bool:
    """Writes the heartbeat only when vLLM answers its health check, so the Worker never routes to a dead model."""
    if not healthy():
        return False
    store.rpc("record_heartbeat", {"p_backend": "kaggle", "p_model": model})
    return True


def heartbeat_loop(store: Rpc, healthy: Callable[[], bool], model: str, interval: float = 30.0, stop: threading.Event | None = None) -> None:
    stop = stop or threading.Event()
    while not stop.is_set():
        try:
            heartbeat_once(store, healthy, model)
        except Exception as e:  # never crash the loop; the Worker falls back after 90 s anyway
            print(f"heartbeat failed: {type(e).__name__}")
        stop.wait(interval)


def main() -> None:
    from ingest.store import SupabaseStore

    secret = os.environ["SKILLY_SHARED_SECRET"]
    model = os.environ.get("SKILLY_MODEL", DEFAULT_MODEL)
    proxy_port = int(os.environ.get("SKILLY_PROXY_PORT", "8080"))
    upstream = "http://127.0.0.1:8000"

    vllm = subprocess.Popen(vllm_command(model))
    print("waiting for vLLM…")
    while not upstream_healthy(upstream):
        if vllm.poll() is not None:
            raise SystemExit(f"vLLM exited with code {vllm.returncode}")
        time.sleep(5)

    store = SupabaseStore(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    threading.Thread(target=heartbeat_loop, args=(store, lambda: upstream_healthy(upstream), SERVED_MODEL_NAME), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", proxy_port), make_handler(secret, upstream))
    print(f"auth proxy on 127.0.0.1:{proxy_port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
