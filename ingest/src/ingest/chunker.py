"""Text normalisation and chunking. Must stay identical to worker/src/rag/chunker.ts
(both are checked against tests/fixtures/chunk_case.json)."""

from __future__ import annotations

import hashlib
import re

CHUNK_SIZE = 800
CHUNK_OVERLAP = 150


def normalize(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t\f\v]+", " ", line).strip() for line in text.split("\n")]
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def content_hash(text: str) -> str:
    return hashlib.sha256(normalize(text).encode("utf-8")).hexdigest()


def _pieces(paragraph: str, size: int) -> list[str]:
    """Split an over-long paragraph into sentences, then hard-split any sentence still too long."""
    if len(paragraph) <= size:
        return [paragraph]
    out: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+", paragraph):
        while len(sentence) > size:
            out.append(sentence[:size])
            sentence = sentence[size:]
        if sentence:
            out.append(sentence)
    return out


def _overlap_tail(prev: str, overlap: int) -> str:
    if overlap <= 0:
        return ""
    tail = prev[-overlap:]
    i = tail.find(" ")
    return tail[i + 1 :] if i >= 0 else tail


def chunk(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    text = normalize(text)
    if not text:
        return []
    pieces: list[str] = []
    for para in text.split("\n\n"):
        pieces.extend(_pieces(para, size))

    chunks: list[str] = []
    current = ""
    for piece in pieces:
        candidate = f"{current}\n\n{piece}" if current else piece
        if len(candidate) <= size:
            current = candidate
            continue
        if current:
            chunks.append(current)
            tail = _overlap_tail(current, overlap)
            current = f"{tail}\n\n{piece}" if tail and len(tail) + 2 + len(piece) <= size else piece
        else:
            current = piece
    if current:
        chunks.append(current)
    return chunks
