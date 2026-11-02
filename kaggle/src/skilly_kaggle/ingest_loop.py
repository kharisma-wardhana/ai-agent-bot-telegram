"""PDF/HTML ingest loop: claims jobs created by /add_knowledge, parses, embeds, stores, notifies the mentor.

    python -m skilly_kaggle.ingest_loop
Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, CF_ACCOUNT_ID, CF_API_TOKEN (Workers AI embeddings),
     R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (default skilly-knowledge), TELEGRAM_BOT_TOKEN.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any, Protocol

from ingest.embedder import Embedder
from ingest.parsers import parse_file
from ingest.pipeline import ingest_doc
from ingest.store import Store


class BlobStore(Protocol):
    def get(self, key: str) -> bytes: ...


class Notifier(Protocol):
    def notify(self, chat_id: int, text: str) -> None: ...


class R2BlobStore:
    """R2 via its S3-compatible API (boto3 is preinstalled on Kaggle images)."""

    def __init__(self, account_id: str, key_id: str, secret: str, bucket: str) -> None:
        import boto3  # imported lazily: only available/needed on Kaggle

        self._bucket = bucket
        self._s3 = boto3.client("s3", endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
                                aws_access_key_id=key_id, aws_secret_access_key=secret, region_name="auto")

    def get(self, key: str) -> bytes:
        return self._s3.get_object(Bucket=self._bucket, Key=key)["Body"].read()


class TelegramNotifier:
    def __init__(self, token: str) -> None:
        self._url = f"https://api.telegram.org/bot{token}/sendMessage"

    def notify(self, chat_id: int, text: str) -> None:
        req = urllib.request.Request(self._url, data=json.dumps({"chat_id": chat_id, "text": text}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=30).close()


def done_message(chunks: int, title: str) -> str:
    # Same wording as worker/src/knowledge/add-knowledge.ts MSG.done
    return f'✅ Selesai: {chunks} potongan materi dari "{title}" ditambahkan ke lesson-docs.'


def duplicate_message(file_name: str) -> str:
    return f'ℹ️ "{file_name}" sudah ada di basis pengetahuan, tidak ada yang ditambahkan.'


def failed_message(file_name: str) -> str:
    return f'⚠️ Gagal memproses "{file_name}". Pastikan file tidak rusak/terkunci, lalu coba kirim ulang.'


def process_one(store: Store, blobs: BlobStore, embedder: Embedder, notifier: Notifier) -> str | None:
    """Claims and processes one job. Returns its final status, or None when the queue is empty."""
    rows = store.rpc("claim_ingest_job", {})
    if not rows:
        return None
    job: dict[str, Any] = rows[0]
    file_name = str(job["file_name"])
    try:
        data = blobs.get(str(job["r2_key"]))
        suffix = ".pdf" if job["source_type"] == "pdf" else ".html"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / f"upload{suffix}"
            path.write_bytes(data)
            doc = parse_file(path)
        if doc is None or not doc.text.strip():
            raise ValueError("no extractable text")
        if doc.title in ("upload", ""):
            doc = type(doc)(Path(file_name).stem, doc.source_type, doc.text)
        res = ingest_doc(doc, embedder, store, origin="add_knowledge", added_by=int(job["requested_by"]), r2_key=str(job["r2_key"]))
        store.rpc("finish_ingest_job", {"p_id": job["id"], "p_status": "done", "p_error": None, "p_chunks": res.chunks_added})
        msg = duplicate_message(file_name) if res.duplicate else done_message(res.chunks_added, doc.title)
        status = "done"
    except Exception as e:
        store.rpc("finish_ingest_job", {"p_id": job["id"], "p_status": "failed", "p_error": f"{type(e).__name__}: {e}"[:500], "p_chunks": 0})
        msg = failed_message(file_name)
        status = "failed"
    try:
        notifier.notify(int(job["requested_by"]), msg)
    except Exception as e:
        print(f"notify failed: {type(e).__name__}")
    return status


def main() -> None:
    from ingest.embedder import WorkersAiEmbedder
    from ingest.store import SupabaseStore

    store = SupabaseStore(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    blobs = R2BlobStore(os.environ["CF_ACCOUNT_ID"], os.environ["R2_ACCESS_KEY_ID"], os.environ["R2_SECRET_ACCESS_KEY"], os.environ.get("R2_BUCKET", "skilly-knowledge"))
    embedder = WorkersAiEmbedder(os.environ["CF_ACCOUNT_ID"], os.environ["CF_API_TOKEN"])
    notifier = TelegramNotifier(os.environ["TELEGRAM_BOT_TOKEN"])
    while True:
        try:
            if process_one(store, blobs, embedder, notifier) is None:
                time.sleep(20)
        except Exception as e:
            print(f"ingest loop error: {type(e).__name__}")
            time.sleep(30)


if __name__ == "__main__":
    main()
