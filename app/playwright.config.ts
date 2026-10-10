import { defineConfig, devices } from "@playwright/test";
import { e2eEnv } from "./e2e/helpers/e2e-env";

// Own ports per checkout (E2E_PORT, default 3417; the fake GitHub gets a random one, see
// e2e/helpers/e2e-env.ts); never 3000 or 3100 so parallel work in other worktrees is safe.
const baseURL = e2eEnv.appUrl;

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: Number(process.env.E2E_WORKERS) || 2,
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
  // Two servers. The fake GitHub stands in for github.com (sign in) and api.github.com; the app
  // under test is pointed at it by environment variables. The journeys always run against a
  // production build, never the dev server, with a fresh SQLite file in the (git-ignored)
  // test-results folder; the app migrates it on start. All values are fixed dummies.
  webServer: [
    {
      command: "node ../fakes/github/main.ts",
      env: {
        GITHUB_FAKE_PORT: String(e2eEnv.githubPort),
        GITHUB_FAKE_CLIENT_ID: e2eEnv.githubClientId,
        GITHUB_FAKE_CLIENT_SECRET: e2eEnv.githubClientSecret,
      },
      url: `${e2eEnv.githubUrl}/__fake/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        "pnpm build && rm -rf test-results/e2e-data && mkdir -p test-results/e2e-data && " +
        `pnpm start --hostname 127.0.0.1 --port ${e2eEnv.appPort}`,
      env: {
        DATABASE_PATH: "test-results/e2e-data/app.db",
        BETTER_AUTH_SECRET: e2eEnv.authSecret,
        BETTER_AUTH_URL: e2eEnv.appUrl,
        GITHUB_OAUTH_CLIENT_ID: e2eEnv.githubClientId,
        GITHUB_OAUTH_CLIENT_SECRET: e2eEnv.githubClientSecret,
        GITHUB_OAUTH_BASE_URL: e2eEnv.githubUrl,
        GITHUB_API_BASE: e2eEnv.githubUrl,
        ALLOWED_GITHUB_LOGINS: e2eEnv.allowedLogins,
        // Without this flag the server refuses the two overrides above.
        ALLOW_TEST_GITHUB_ENDPOINTS: "true",
      },
      url: baseURL,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
