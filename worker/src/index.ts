import { Hono } from "hono";
import type { Env } from "./config";

// Step 1 stub: health check only. Webhook, MCP, cron and the Durable Object arrive in later steps.
const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true }));

export default app;
