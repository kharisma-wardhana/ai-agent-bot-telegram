import json
from pathlib import Path

from ingest.chunker import CHUNK_SIZE, chunk, content_hash, normalize

FIXTURE = Path(__file__).parent / "fixtures" / "chunk_case.json"


def test_normalize_collapses_whitespace_and_blank_lines():
    assert normalize("  a \t b \r\n\r\n\r\n\n c  ") == "a b\n\nc"


def test_chunks_respect_size_and_overlap():
    para = " ".join(f"kata{i}." for i in range(400))  # one long paragraph, many sentences
    out = chunk(para + "\n\nPenutup singkat.")
    assert len(out) > 1
    assert all(len(c) <= CHUNK_SIZE for c in out)
    # Each later chunk starts with text from the end of the previous one (overlap).
    for prev, nxt in zip(out, out[1:]):
        head = nxt.split("\n\n")[0]
        assert prev.endswith(head) or head in prev


def test_hard_splits_a_sentence_longer_than_the_chunk():
    out = chunk("x" * 2000)
    assert all(len(c) <= CHUNK_SIZE for c in out)
    assert "".join(c.split("\n\n")[-1] for c in out).count("x") >= 2000


def test_empty_text_gives_no_chunks():
    assert chunk(" \n\n ") == []


def test_content_hash_ignores_whitespace_noise():
    assert content_hash("a  b\n\n\n\nc") == content_hash("a b\n\nc")
    assert content_hash("a") != content_hash("b")


def test_shared_fixture_matches():
    """Same fixture is checked by worker/test/chunker.test.ts, keeping the two chunkers identical."""
    case = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert chunk(case["input"], case["size"], case["overlap"]) == case["expected"]
    assert content_hash(case["input"]) == case["hash"]
