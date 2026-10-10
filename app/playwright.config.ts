import { defineConfig, devices } from "@playwright/test";

// Own port per checkout; never 3000 or 3100 so parallel work in other worktrees is safe.
const port = Number(process.env.E2E_PORT ?? 3417);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: Number(process.env.E2E_WORKERS ?? 2),
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Locally an installed Chrome can be used instead of a downloaded Chromium:
        // PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e
        channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
      },
    },
  ],
  // The e2e journeys always run against a production build, never the dev server.
  webServer: {
    command: `pnpm build && pnpm start --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
