import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Worker code, run inside the local Workers runtime (Miniflare). No remote bindings.
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" }, remoteBindings: false })],
        test: { name: "workers", include: ["test/**/*.test.ts"], exclude: ["test/db/**"] },
      },
      {
        // SQL migrations and functions, run on PGlite + pgvector in Node.
        test: { name: "db", environment: "node", include: ["test/db/**/*.test.ts"] },
      },
    ],
  },
});
