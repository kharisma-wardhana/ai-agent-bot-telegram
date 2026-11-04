from pathlib import Path

import pytest

from ingest.store import Source
from skilly_kaggle.ingest_loop import done_message, failed_message, process_one

LESSON_DOCS = Path(__file__).resolve().parents[2] / "lesson-docs"
PDF = LESSON_DOCS / "Video transcript_How large language models work.pdf"


class FakeStore:
    def __init__(self, jobs):
        self.jobs = list(jobs)
        self.finished = []
        self.sources: list[Source] = []
        self.chunks = []

    def rpc(self, fn, args):
        if fn == "claim_ingest_job":
            return [self.jobs.pop(0)] if self.jobs else []
        if fn == "finish_ingest_job":
            self.finished.append(args)
            return [{"ok": True}]
        raise AssertionError(fn)

    def insert_knowledge(self, source, chunks):
        if any(s.content_hash == source.content_hash for s in self.sources):
            return 0
        self.sources.append(source)
        self.chunks.extend(chunks)
        return len(chunks)


class FakeBlobs:
    def __init__(self, files):
        self.files = files

    def get(self, key):
        return self.files[key]


class FakeEmbedder:
    def embed(self, texts):
        return [[0.1] * 1024 for _ in texts]


class FakeNotifier:
    def __init__(self):
        self.sent = []

    def notify(self, chat_id, text):
        self.sent.append((chat_id, text))


def job(key, name, kind, jid="j1"):
    return {"id": jid, "r2_key": key, "file_name": name, "source_type": kind, "requested_by": 111}


@pytest.mark.skipif(not PDF.exists(), reason="lesson-docs/ not present")
def test_pdf_job_is_parsed_stored_finished_and_mentor_notified():
    store = FakeStore([job("k/llm.pdf", "LLM.pdf", "pdf")])
    notifier = FakeNotifier()
    assert process_one(store, FakeBlobs({"k/llm.pdf": PDF.read_bytes()}), FakeEmbedder(), notifier) == "done"

    assert len(store.sources) == 1
    src = store.sources[0]
    assert (src.origin, src.added_by, src.r2_key, src.source_type) == ("add_knowledge", 111, "k/llm.pdf", "pdf")
    assert len(store.chunks) > 1
    assert store.finished == [{"p_id": "j1", "p_status": "done", "p_error": None, "p_chunks": len(store.chunks)}]
    assert src.title == "LLM"  # temp-file name replaced by the uploaded file's name
    assert notifier.sent == [(111, done_message(len(store.chunks), "LLM"))]


def test_html_job_and_duplicate_reupload():
    html = b"<html><head><title>Glosarium AI</title></head><body>" + b"<p>Embedding adalah representasi vektor dari teks. </p>" * 20 + b"</body></html>"
    store = FakeStore([job("k/a.html", "a.html", "html", "j1"), job("k/b.html", "b.html", "html", "j2")])
    notifier = FakeNotifier()
    blobs = FakeBlobs({"k/a.html": html, "k/b.html": html})
    assert process_one(store, blobs, FakeEmbedder(), notifier) == "done"
    assert process_one(store, blobs, FakeEmbedder(), notifier) == "done"
    assert store.sources[0].title == "Glosarium AI"
    assert len(store.sources) == 1  # same content → not appended twice
    assert notifier.sent[0][1] == done_message(len(store.chunks), "Glosarium AI")
    assert "sudah ada" in notifier.sent[1][1]


def test_unparseable_file_marks_job_failed_and_tells_the_mentor():
    store = FakeStore([job("k/bad.pdf", "rusak.pdf", "pdf")])
    notifier = FakeNotifier()
    assert process_one(store, FakeBlobs({"k/bad.pdf": b"not a pdf"}), FakeEmbedder(), notifier) == "failed"
    assert store.finished[0]["p_status"] == "failed"
    assert store.chunks == []
    assert notifier.sent == [(111, failed_message("rusak.pdf"))]


def test_empty_queue_returns_none():
    assert process_one(FakeStore([]), FakeBlobs({}), FakeEmbedder(), FakeNotifier()) is None
