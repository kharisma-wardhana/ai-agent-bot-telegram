import json
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from skilly_kaggle.serve import SECRET_HEADER, SERVED_MODEL_NAME, heartbeat_once, make_handler, vllm_command


class FakeVllm(BaseHTTPRequestHandler):
    """Stands in for vLLM: streams two SSE chunks for chat, 200 for /health."""
    seen: list[dict] = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        FakeVllm.seen.append({"path": self.path, "body": json.loads(body), "secret": self.headers.get(SECRET_HEADER)})
        payload = b'data: {"choices":[{"delta":{"content":"Ha"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def _serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


@pytest.fixture
def proxy():
    FakeVllm.seen = []
    up, up_url = _serve(FakeVllm)
    px, px_url = _serve(make_handler("s3cret", up_url))
    yield px_url
    px.shutdown()
    up.shutdown()


def _post(url, secret=None, path="/v1/chat/completions"):
    headers = {"Content-Type": "application/json"}
    if secret is not None:
        headers[SECRET_HEADER] = secret
    req = urllib.request.Request(url + path, data=b'{"model":"qwen3-vl-8b","stream":true}', headers=headers, method="POST")
    return urllib.request.urlopen(req, timeout=10)


def test_missing_or_wrong_secret_is_401_and_never_reaches_vllm(proxy):
    for secret in (None, "", "wrong"):
        with pytest.raises(urllib.error.HTTPError) as e:
            _post(proxy, secret)
        assert e.value.code == 401
    assert FakeVllm.seen == []


def test_valid_secret_is_forwarded_and_streamed_back(proxy):
    with _post(proxy, "s3cret") as res:
        body = res.read().decode()
    assert '"content":"Ha"' in body and "[DONE]" in body
    assert FakeVllm.seen[0]["path"] == "/v1/chat/completions"
    assert FakeVllm.seen[0]["secret"] is None  # the secret is not passed on to vLLM


def test_only_chat_and_health_are_exposed(proxy):
    with pytest.raises(urllib.error.HTTPError) as e:
        _post(proxy, "s3cret", path="/v1/models")
    assert e.value.code == 404


def test_heartbeat_only_when_vllm_is_healthy():
    calls = []

    class Store:
        def rpc(self, fn, args):
            calls.append((fn, args))
            return []

    assert heartbeat_once(Store(), lambda: False, SERVED_MODEL_NAME) is False
    assert calls == []
    assert heartbeat_once(Store(), lambda: True, SERVED_MODEL_NAME) is True
    assert calls == [("record_heartbeat", {"p_backend": "kaggle", "p_model": "qwen3-vl-8b"})]


def test_vllm_flags_match_the_worker_contract():
    cmd = vllm_command("Qwen/Qwen3-VL-8B-Instruct-AWQ")
    assert cmd[cmd.index("--served-model-name") + 1] == "qwen3-vl-8b"
    assert "--enable-auto-tool-choice" in cmd and "hermes" in cmd
    assert cmd[cmd.index("--dtype") + 1] == "half"
    assert cmd[cmd.index("--host") + 1] == "127.0.0.1"  # vLLM itself is never exposed; only the proxy is
