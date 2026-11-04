"""Seed CLI: ingest every supported file in a lesson-docs folder. Idempotent (content hash).

    uv run --project ingest skilly-seed lesson-docs --dry-run     # parse + chunk only, no network
    uv run --project ingest skilly-seed lesson-docs               # needs the env vars below

Env for a real run: SUPABASE_URL, SUPABASE_SERVICE_KEY, CF_ACCOUNT_ID, CF_API_TOKEN.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .chunker import chunk
from .embedder import Embedder, WorkersAiEmbedder
from .parsers import parse_file
from .pipeline import ingest_doc
from .store import Store, SupabaseStore

REQUIRED_ENV = ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "CF_ACCOUNT_ID", "CF_API_TOKEN")


def main(argv: list[str] | None = None, *, embedder: Embedder | None = None, store: Store | None = None) -> int:
    ap = argparse.ArgumentParser(prog="skilly-seed", description=__doc__.splitlines()[0])
    ap.add_argument("folder", type=Path)
    ap.add_argument("--dry-run", action="store_true", help="parse and chunk only; no embedding, no database")
    args = ap.parse_args(argv)

    if not args.folder.is_dir():
        print(f"error: {args.folder} is not a folder", file=sys.stderr)
        return 2

    if not args.dry_run and (embedder is None or store is None):
        missing = [k for k in REQUIRED_ENV if not os.environ.get(k)]
        if missing:
            print(f"error: missing env vars: {', '.join(missing)} (or use --dry-run)", file=sys.stderr)
            return 2
        embedder = embedder or WorkersAiEmbedder(os.environ["CF_ACCOUNT_ID"], os.environ["CF_API_TOKEN"])
        store = store or SupabaseStore(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

    total_added = 0
    for path in sorted(p for p in args.folder.iterdir() if p.is_file()):
        doc = parse_file(path)
        if doc is None:
            print(f"skip     {path.name} (unsupported type)")
            continue
        if args.dry_run:
            print(f"dry-run  {path.name}: {len(doc.text)} chars, {len(chunk(doc.text))} chunks")
            continue
        assert embedder is not None and store is not None
        res = ingest_doc(doc, embedder, store, origin="seed")
        total_added += res.chunks_added
        status = "unchanged (already ingested)" if res.duplicate else f"added {res.chunks_added} chunks"
        print(f"ingest   {path.name}: {status}")
    if not args.dry_run:
        print(f"done: {total_added} chunks added")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
