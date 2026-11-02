from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from ingest.store import Source

REPO = Path(__file__).resolve().parents[2]
LESSON_DOCS = REPO / "lesson-docs"


class FakeEmbedder:
    def __init__(self) -> None:
        self.calls = 0

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls += 1
        return [[float(len(t) % 7)] + [0.0] * 1023 for t in texts]


class FakeStore:
    """Mirrors insert_knowledge: duplicate content_hash inserts nothing."""

    def __init__(self) -> None:
        self.sources: list[Source] = []
        self.chunks: list[dict[str, Any]] = []

    def insert_knowledge(self, source: Source, chunks: list[dict[str, Any]]) -> int:
        if any(s.content_hash == source.content_hash for s in self.sources):
            return 0
        self.sources.append(source)
        self.chunks.extend(chunks)
        return len(chunks)

    def rpc(self, fn: str, args: dict[str, Any]) -> list[dict[str, Any]]:
        raise NotImplementedError


@pytest.fixture
def lesson_docs() -> Path:
    if not LESSON_DOCS.is_dir():
        pytest.skip("lesson-docs/ not present")
    return LESSON_DOCS
