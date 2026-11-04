#!/usr/bin/env node
// Guard: asks before an agent edits a test file, so "make the tests pass" can't become "change the tests".
// Matches this repo's real test layout only. Fail closed: any internal error emits "ask".
// Uninstall: remove this script's entry from .claude/settings.json.
const TEST_PATHS = [
  /^worker\/test\//,          // vitest (incl. fakes, fixtures, db tests)
  /^ingest\/tests\//,         // pytest + shared chunker fixture
  /^kaggle\/tests\//,
  /^eval\/tests\//,
  /^eval\/questions\.jsonl$/, // the labelled eval set is test data too
];

function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
  }));
  process.exit(0);
}

const norm = (p) => String(p).split("\\").join("/");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    let input;
    try { input = JSON.parse(raw); } catch { emit("ask", "Guard hook received input it could not parse."); }
    const ti = (input && input.tool_input) || {};
    const path = ti.file_path || ti.notebook_path || "";
    if (!path) process.exit(0);
    let rel = norm(path);
    const root = norm(input.cwd || process.env.CLAUDE_PROJECT_DIR || "").replace(/\/+$/, "");
    if (/^([A-Za-z]:)?\//.test(rel)) {
      if (root && rel.toLowerCase().startsWith(root.toLowerCase() + "/")) rel = rel.slice(root.length + 1);
      else process.exit(0);
    }
    rel = rel.replace(/^\.\//, "");
    if (TEST_PATHS.some((re) => re.test(rel))) {
      emit("ask", `${rel} is a test file. If the task is to fix the code, existing tests should not change. Confirm this edit is intended (adding a new test is fine).`);
    }
    process.exit(0);
  } catch {
    emit("ask", "Guard hook failed internally; approve manually.");
  }
});
