"""Knowledge store. Production calls the insert_knowledge SQL function via Supabase PostgREST."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class Source:
    title: str
    source_type: str
    origin: str  # 'seed' | 'add_knowledge'
    content_hash: str
    added_by: int | None = None
    r2_key: str | None = None


class Store(Protocol):
    def insert_knowledge(self, source: Source, chunks: list[dict[str, Any]]) -> int:
        """Appends source + chunks. Returns chunks added (0 if the content hash already exists)."""
        ...

    def rpc(self, fn: str, args: dict[str, Any]) -> list[dict[str, Any]]: ...


class SupabaseStore:
    def __init__(self, url: str, service_key: str, timeout: float = 60.0) -> None:
        self._url = url.rstrip("/")
        self._key = service_key
        self._timeout = timeout

    def rpc(self, fn: str, args: dict[str, Any]) -> list[dict[str, Any]]:
        req = urllib.request.Request(
            f"{self._url}/rest/v1/rpc/{fn}",
            data=json.dumps(args).encode(),
            headers={"apikey": self._key, "Authorization": f"Bearer {self._key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as res:
                raw = res.read()
        except urllib.error.HTTPError as e:  # never include the key in the message
            raise RuntimeError(f"rpc {fn} failed ({e.code})") from None
        if not raw:
            return []
        body = json.loads(raw)
        if isinstance(body, list):
            return [b if isinstance(b, dict) else {fn: b} for b in body]
        return [body if isinstance(body, dict) else {fn: body}]

    def insert_knowledge(self, source: Source, chunks: list[dict[str, Any]]) -> int:
        rows = self.rpc(
            "insert_knowledge",
            {
                "p_title": source.title,
                "p_source_type": source.source_type,
                "p_origin": source.origin,
                "p_added_by": source.added_by,
                "p_r2_key": source.r2_key,
                "p_content_hash": source.content_hash,
                "p_chunks": chunks,
            },
        )
        return int(rows[0].get("chunks_added", 0)) if rows else 0
