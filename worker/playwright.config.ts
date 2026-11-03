import { defineConfig, devices } from "@playwright/test";

// Dashboard e2e (docs/mentor-followup-dashboard/plan.md › Test coverage). Runs against e2e/server.ts: fakes, no network.
const PORT = 8788;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1, // one shared in-memory server
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["Pixel 5"],
    viewport: { width: 360, height: 740 },
    browserName: "chromium",
  },
  webServer: {
    command: "npx tsx e2e/server.ts",
    url: `http://localhost:${PORT}/dashboard/login`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_PORT: String(PORT) },
  },
});
