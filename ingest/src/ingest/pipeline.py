"""parse → chunk → embed → store, for one document."""

from __future__ import annotations

from dataclasses import dataclass

from .chunker import chunk, content_hash
from .embedder import Embedder
from .parsers import ParsedDoc
from .store import Source, Store


@dataclass(frozen=True)
class IngestResult:
    title: str
    chunks: int
    chunks_added: int

    @property
    def duplicate(self) -> bool:
        return self.chunks > 0 and self.chunks_added == 0


def ingest_doc(doc: ParsedDoc, embedder: Embedder, store: Store, *, origin: str,
               added_by: int | None = None, r2_key: str | None = None) -> IngestResult:
    pieces = chunk(doc.text)
    if not pieces:
        return IngestResult(doc.title, 0, 0)
    vectors = embedder.embed(pieces)
    if len(vectors) != len(pieces):
        raise RuntimeError("embedder returned a different number of vectors than chunks")
    source = Source(doc.title, doc.source_type, origin, content_hash(doc.text), added_by, r2_key)
    payload = [{"position": i, "content": c, "embedding": v} for i, (c, v) in enumerate(zip(pieces, vectors))]
    return IngestResult(doc.title, len(pieces), store.insert_knowledge(source, payload))
