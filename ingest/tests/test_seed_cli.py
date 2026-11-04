import shutil

from ingest.seed import main

from .conftest import FakeEmbedder, FakeStore


def _copy_corpus(lesson_docs, tmp_path):
    dst = tmp_path / "lesson-docs"
    shutil.copytree(lesson_docs, dst)
    return dst


def test_seed_ingests_every_supported_file_and_is_idempotent(lesson_docs, tmp_path, capsys):
    folder = _copy_corpus(lesson_docs, tmp_path)
    store, emb = FakeStore(), FakeEmbedder()

    assert main([str(folder)], embedder=emb, store=store) == 0
    first = capsys.readouterr().out
    titles = {s.title for s in store.sources}
    assert len(store.sources) == 6  # 2 md + 3 pdf + 1 html
    assert "Mastering the Art of Prompting" in titles
    assert all(s.origin == "seed" for s in store.sources)
    assert "skip     865bf7b6-bf0a-4072-9ed3-5eb68e89c183.jpg (unsupported type)" in first
    chunks_after_first = len(store.chunks)
    assert chunks_after_first > 6
    assert all(len(c["embedding"]) == 1024 for c in store.chunks)

    assert main([str(folder)], embedder=emb, store=store) == 0
    second = capsys.readouterr().out
    assert len(store.chunks) == chunks_after_first
    assert second.count("unchanged (already ingested)") == 6
    assert "done: 0 chunks added" in second


def test_dry_run_needs_no_network_or_env(lesson_docs, tmp_path, capsys, monkeypatch):
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "CF_ACCOUNT_ID", "CF_API_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    assert main([str(_copy_corpus(lesson_docs, tmp_path)), "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert out.count("dry-run ") == 6


def test_real_run_without_env_fails_cleanly(tmp_path, capsys, monkeypatch):
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "CF_ACCOUNT_ID", "CF_API_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    assert main([str(tmp_path)]) == 2
    assert "missing env vars" in capsys.readouterr().err


def test_missing_folder_is_an_error(tmp_path):
    assert main([str(tmp_path / "nope"), "--dry-run"]) == 2
