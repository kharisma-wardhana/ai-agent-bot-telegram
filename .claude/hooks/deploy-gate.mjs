#!/usr/bin/env node
// Approval prompt on Bash commands that look like they reach a real environment.
// DEFENCE IN DEPTH, NOT THE PRODUCTION GATE: a regex over command strings cannot be complete
// (e.g. `bash deploy.sh`, `make deploy`, extra spaces, aliases all slip past). The gate is the rule that
// agents do not deploy; removing this hook removes one layer, not the rule.
// Fail closed: any internal error emits "ask". Uninstall: remove its entry from .claude/settings.json.
const DANGER = new RegExp([
  String.raw`\bwrangler\s+(deploy|publish|rollback|secret|delete|versions\s+deploy|r2\s+object\s+(put|delete)|d1\s+execute)`,
  String.raw`\bsupabase\s+(db\s+(push|reset)|link|secrets)`,
  String.raw`\bpsql\b`,
  String.raw`\bkaggle\s+(kernels\s+push|datasets\s+(create|version))`,
  String.raw`\bcloudflared\s+tunnel\s+(run|create|delete|route)`,
  String.raw`api\.telegram\.org/bot[^/\s]*/(setWebhook|deleteWebhook|sendMessage)`,
  String.raw`api\.cloudflare\.com`,
  String.raw`\.supabase\.co\b`,
  String.raw`\bgit\s+push\b`,
  String.raw`\b(npm|pnpm)\s+publish\b`,
  String.raw`\b(ssh|scp|rsync)\s`,
  String.raw`\bskilly-seed\b(?!.*--dry-run)`,
  String.raw`\brun_eval\.py\b`,
].join("|"), "i");

function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
  }));
  process.exit(0);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    let input;
    try { input = JSON.parse(raw); } catch { emit("ask", "Guard hook received input it could not parse."); }
    const cmd = String(((input && input.tool_input) || {}).command || "");
    if (!cmd) process.exit(0);
    if (DANGER.test(cmd)) emit("ask", "This command can reach a real environment (deploy, data, secrets, webhook, push). A human approves production actions.");
    process.exit(0);
  } catch {
    emit("ask", "Guard hook failed internally; approve manually.");
  }
});
