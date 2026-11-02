"""Embeddings. Production uses bge-m3 on Cloudflare Workers AI (same model as the Worker)."""

from __future__ import annotations

import json
import urllib.request
from typing import Protocol

EMBED_MODEL = "@cf/baai/bge-m3"
EMBED_DIM = 1024


class Embedder(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


class WorkersAiEmbedder:
    """Calls the Workers AI REST API. Only used when the owner runs the seed for real."""

    def __init__(self, account_id: str, api_token: str, timeout: float = 60.0) -> None:
        self._url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{EMBED_MODEL}"
        self._token = api_token
        self._timeout = timeout

    def embed(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for i in range(0, len(texts), 50):
            batch = texts[i : i + 50]
            req = urllib.request.Request(
                self._url,
                data=json.dumps({"text": batch}).encode(),
                headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=self._timeout) as res:
                body = json.loads(res.read())
            data = body.get("result", {}).get("data")
            if not isinstance(data, list) or len(data) != len(batch):
                raise RuntimeError("bge-m3 returned an unexpected shape")
            for v in data:
                if len(v) != EMBED_DIM:
                    raise RuntimeError(f"bge-m3 returned dim {len(v)}, expected {EMBED_DIM}")
            out.extend(data)
        return out
