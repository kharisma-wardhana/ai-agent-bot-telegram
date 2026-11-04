#!/usr/bin/env bash
# Agent-configuration eval. Asserts each installed hook decides as documented, in both directions.
# Hooks here are Node scripts (jq is not available on contributors' machines). Deliberately no `set -e`.
# Run from the repo root:  bash .claude/hooks/eval.sh
set -uo pipefail
fail=0
ran=0

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL - node is not installed: every guard hook would be a no-op."; exit 1
fi

# acts <label> <script> <expected-substring> <input-json>  -- the hook must return this decision
acts () {
  [ -f "$2" ] || { echo "skip - $1 (no $2)"; return; }
  ran=$((ran + 1))
  out=$(printf '%s' "$4" | node "$2" 2>&1)
  if printf '%s' "$out" | grep -q "$3"; then echo "ok   - $1"
  else echo "FAIL - $1 (expected '$3', got '${out:-<empty>}')"; fail=1; fi
}

# quiet <label> <script> <input-json>  -- the hook must say nothing (the case it must NOT act on)
quiet () {
  [ -f "$2" ] || { echo "skip - $1 (no $2)"; return; }
  ran=$((ran + 1))
  out=$(printf '%s' "$3" | node "$2" 2>&1)
  if [ -z "$out" ]; then echo "ok   - $1"
  else echo "FAIL - $1 (expected no output, got '$out')"; fail=1; fi
}

# One PAIR per installed hook. Adding a hook and adding its pair are the same change.
acts  "protect-paths denies lesson-docs edit"   .claude/hooks/protect-paths.mjs \
      '"permissionDecision":"deny"' \
      '{"cwd":"/r","tool_name":"Edit","tool_input":{"file_path":"lesson-docs/mastering-art-of-prompting.md"}}'
acts  "protect-paths denies Windows abs path"   .claude/hooks/protect-paths.mjs \
      '"permissionDecision":"deny"' \
      '{"cwd":"D:\\PROJECT\\repo","tool_name":"Write","tool_input":{"file_path":"D:\\PROJECT\\repo\\lesson-docs\\x.md"}}'
quiet "protect-paths allows worker source"      .claude/hooks/protect-paths.mjs \
      '{"cwd":"/r","tool_name":"Edit","tool_input":{"file_path":"worker/src/index.ts"}}'
quiet "protect-paths allows nested look-alike"  .claude/hooks/protect-paths.mjs \
      '{"cwd":"/r","tool_name":"Edit","tool_input":{"file_path":"docs/lesson-docs/notes.md"}}'
acts  "protect-paths asks on unparseable input" .claude/hooks/protect-paths.mjs \
      '"permissionDecision":"ask"' 'not json'

acts  "guard-tests asks on a test file"   .claude/hooks/guard-tests.mjs \
      '"permissionDecision":"ask"' '{"tool_input":{"file_path":"worker/test/webhook.test.ts"}}'
quiet "guard-tests allows source"         .claude/hooks/guard-tests.mjs \
      '{"tool_input":{"file_path":"worker/src/index.ts"}}'

acts  "deploy-gate asks on wrangler deploy" .claude/hooks/deploy-gate.mjs \
      '"permissionDecision":"ask"' '{"tool_input":{"command":"pnpm -C worker exec wrangler deploy"}}'
quiet "deploy-gate allows tests"            .claude/hooks/deploy-gate.mjs \
      '{"tool_input":{"command":"pnpm -C worker test"}}'

# settings.json must still reference every hook script that exists (a dropped entry is invisible in a diff).
for h in .claude/hooks/*.mjs; do
  [ -f "$h" ] || continue
  ran=$((ran + 1))
  if grep -q "$(basename "$h")" .claude/settings.json 2>/dev/null; then echo "ok   - settings.json registers $(basename "$h")"
  else echo "FAIL - $(basename "$h") exists but is not registered in .claude/settings.json"; fail=1; fi
done

if [ -f .claude/monitoring/control_band.py ]; then
  PY=$(command -v python 2>/dev/null || command -v python3 2>/dev/null)
  ran=$((ran + 1))
  "$PY" .claude/monitoring/control_band.py --self-check || fail=1
fi

if [ "$ran" -eq 0 ]; then
  echo "FAIL - nothing to evaluate: no hooks and no monitoring script found."; fail=1
fi
exit $fail
