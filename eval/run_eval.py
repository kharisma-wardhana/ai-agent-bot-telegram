"""Live evaluation — RUN BY THE OWNER against a staging bot, never from CI or an agent session.

Sends each question in questions.jsonl to the deployed Worker as a synthetic Telegram *DM* update from a
test learner, waits for the assistant turn to appear in Supabase, closes the session with a 👍 callback,
then scores everything with scoring.py.

Use a STAGING setup: a separate bot and Supabase project, and MENTOR_IDS set to your own Telegram ID, because
out-of-scope questions trigger real mentor DMs. The test learner (EVAL_LEARNER_ID) must have pressed Start.

Env: EVAL_WEBHOOK_URL (https://<worker>/telegram/webhook), EVAL_WEBHOOK_SECRET, EVAL_LEARNER_ID,
     SUPABASE_URL, SUPABASE_SERVICE_KEY. Optional: EVAL_TIMEOUT_S (default 90).

    uv run --project eval python eval/run_eval.py [--limit N] [--out eval/results.json]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from scoring import Result, render, score

HERE = Path(__file__).parent


def _post(url: str, body: dict, headers: dict) -> None:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **headers}, method="POST")
    urllib.request.urlopen(req, timeout=30).close()


def _assistant_turn_after(supabase: str, key: str, since_iso: str) -> dict | None:
    q = urllib.parse.urlencode({"select": "content,answer_source,sources,created_at", "role": "eq.assistant", "created_at": f"gt.{since_iso}", "order": "id.asc", "limit": "1"})
    req = urllib.request.Request(f"{supabase}/rest/v1/session_turns?{q}", headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        rows = json.loads(r.read())
    return rows[0] if rows else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", type=Path, default=HERE / "results.json")
    args = ap.parse_args()
    env = {k: os.environ.get(k, "") for k in ("EVAL_WEBHOOK_URL", "EVAL_WEBHOOK_SECRET", "EVAL_LEARNER_ID", "SUPABASE_URL", "SUPABASE_SERVICE_KEY")}
    missing = [k for k, v in env.items() if not v]
    if missing:
        print(f"missing env: {', '.join(missing)}", file=sys.stderr)
        return 2
    learner = int(env["EVAL_LEARNER_ID"])
    timeout = float(os.environ.get("EVAL_TIMEOUT_S", "90"))
    hook = {"X-Telegram-Bot-Api-Secret-Token": env["EVAL_WEBHOOK_SECRET"]}
    user = {"id": learner, "is_bot": False, "first_name": "Eval"}

    questions = [json.loads(l) for l in (HERE / "questions.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    if args.limit:
        questions = questions[: args.limit]
    results: list[Result] = []
    for n, q in enumerate(questions, 1):
        since = datetime.now(timezone.utc).isoformat()
        t0 = time.monotonic()
        update = {"update_id": int(time.time() * 1000), "message": {"message_id": n, "from": user, "chat": {"id": learner, "type": "private"}, "text": q["question"]}}
        _post(env["EVAL_WEBHOOK_URL"], update, hook)
        turn = None
        while time.monotonic() - t0 < timeout and turn is None:
            time.sleep(1)
            turn = _assistant_turn_after(env["SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"], since)
        latency = (time.monotonic() - t0) * 1000
        results.append(Result(q["id"], q["scope"], q["question"], (turn or {}).get("content", ""), (turn or {}).get("answer_source"), latency if turn else float("inf"), q.get("expect_source")))
        print(f"[{n}/{len(questions)}] {q['id']}: {results[-1].answer_source or 'TIMEOUT'} in {latency / 1000:.1f}s")
        # Close the session so the next question starts fresh.
        _post(env["EVAL_WEBHOOK_URL"], {"update_id": int(time.time() * 1000) + 1, "callback_query": {"id": f"eval{n}", "from": user, "data": "fb:up"}}, hook)
        time.sleep(1)

    args.out.write_text(json.dumps([r.__dict__ for r in results], ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    rep = score(results)
    print(render(rep))
    return 0 if rep.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
