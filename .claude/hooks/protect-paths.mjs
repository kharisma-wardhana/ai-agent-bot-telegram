#!/usr/bin/env node
// Guard: blocks agent edits to protected repo paths (lesson-docs/ is the append-only corpus).
// Fail closed: any internal error emits "ask" instead of silently allowing.
// Uninstall: remove this script's entry from .claude/settings.json.
const PROTECTED = ["lesson-docs/"]; // repo-relative, anchored prefixes. Add lines; never widen.

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
      else process.exit(0); // absolute path outside the repo: not ours to guard
    }
    rel = rel.replace(/^\.\//, "");
    for (const p of PROTECTED) {
      if (rel.toLowerCase().startsWith(p.toLowerCase())) {
        emit("deny", `${p} is the append-only lesson corpus. Add knowledge via /add_knowledge or the seed CLI, not by editing files.`);
      }
    }
    process.exit(0);
  } catch {
    emit("ask", "Guard hook failed internally; approve manually.");
  }
});
