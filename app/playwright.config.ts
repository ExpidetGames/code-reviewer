import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";
import { e2eEnv, llmEnv } from "./e2e/helpers/e2e-env";

// Own ports per checkout (E2E_PORT, default 3417; the fake GitHub gets a random one, see
// e2e/helpers/e2e-env.ts); never 3000 or 3100 so parallel work in other worktrees is safe.
const baseURL = e2eEnv.appUrl;

// A throwaway key for the GitHub App settings of the app under test, new for every run and never
// written anywhere. No journey asks GitHub for a token, so the key is only there to make the
// settings complete (the webhook route verifies deliveries only with complete settings, and the
// production server refuses to start with an unusable key).
const githubAppPrivateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

// The fake GitHub checks the App JWTs of the app under test with the public half of that key.
const githubAppPublicKey = createPublicKey(githubAppPrivateKey)
  .export({ type: "spki", format: "pem" })
  .toString();

// Locally an installed Chrome can be used instead of a downloaded Chromium:
// PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e
const browser = {
  ...devices["Desktop Chrome"],
  channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
};

// What both apps under test share: the sign in, the GitHub App and the runner token, all dummies.
const appEnv = {
  BETTER_AUTH_SECRET: e2eEnv.authSecret,
  GITHUB_OAUTH_CLIENT_ID: e2eEnv.githubClientId,
  GITHUB_OAUTH_CLIENT_SECRET: e2eEnv.githubClientSecret,
  GITHUB_OAUTH_BASE_URL: e2eEnv.githubUrl,
  GITHUB_API_BASE_URL: e2eEnv.githubUrl,
  GITHUB_APP_ID: e2eEnv.githubAppId,
  GITHUB_APP_SLUG: e2eEnv.githubAppSlug,
  GITHUB_APP_WEBHOOK_SECRET: e2eEnv.githubAppWebhookSecret,
  GITHUB_APP_PRIVATE_KEY: githubAppPrivateKey,
  RUNNER_TOKEN: e2eEnv.runnerToken,
  // Without this flag the server refuses the two overrides above.
  ALLOW_TEST_GITHUB_ENDPOINTS: "true",
};

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
  // The journeys share one app and one database file. The ones that put runs into the queue or claim
  // them (the Runs pages and the manual start) must not overlap: the Runs journey expects an empty
  // queue when it starts and `claimNextRun` takes the oldest job of the whole queue. So they are
  // projects of their own, and the manual start waits for the Runs journeys to finish.
  projects: [
    {
      name: "chromium",
      use: browser,
      testIgnore: [/e2e\/runs\//, /e2e\/reviews\//, /e2e\/jobs\//],
    },
    { name: "runs", use: browser, testMatch: /e2e\/runs\/.*\.e2e\.ts$/ },
    {
      name: "reviews",
      use: browser,
      testMatch: /e2e\/reviews\/.*\.e2e\.ts$/,
      dependencies: ["runs"],
    },
    // The journey with the real runner and the real PR-Agent. It has an app of its own (its own
    // database, the LLM configured, a real runner polling it), so it cannot disturb the queue of the
    // other journeys and they cannot disturb it, and it runs next to them.
    {
      name: "jobs",
      use: { ...browser, baseURL: e2eEnv.pipelineAppUrl },
      testMatch: /e2e\/jobs\/.*\.e2e\.ts$/,
    },
  ],
  // Three servers. The fake GitHub stands in for github.com (sign in) and api.github.com; the app
  // under test is pointed at it by environment variables. The journeys always run against a
  // production build, never the dev server, with a fresh SQLite file in the (git-ignored)
  // test-results folder; the app migrates it on start. All values are fixed dummies.
  //
  // The second app serves the same build (the servers start one after the other, so the build of
  // the first is done) with a database of its own and the settings the journey with the real
  // runner needs: the LLM access (the other app has none, a journey checks its warning), and a
  // push that is reviewed after a second instead of after 90 seconds.
  webServer: [
    {
      command: "node ../fakes/github/main.ts",
      env: {
        GITHUB_FAKE_PORT: String(e2eEnv.githubPort),
        GITHUB_FAKE_CLIENT_ID: e2eEnv.githubClientId,
        GITHUB_FAKE_CLIENT_SECRET: e2eEnv.githubClientSecret,
        GITHUB_FAKE_APP_ID: e2eEnv.githubAppId,
        GITHUB_FAKE_APP_PUBLIC_KEY: githubAppPublicKey,
        GITHUB_FAKE_APP_SLUG: e2eEnv.githubAppSlug,
        // The links of the fake point to the fake, so that a pull request and the API address of a
        // job are on one host, which the runner demands.
        GITHUB_FAKE_SELF_LINKS: "true",
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
        ...appEnv,
        DATABASE_PATH: e2eEnv.databasePath,
        BETTER_AUTH_URL: e2eEnv.appUrl,
        ALLOWED_GITHUB_LOGINS: e2eEnv.allowedLogins,
      },
      url: e2eEnv.appUrl,
      reuseExistingServer: false,
      timeout: 240_000,
    },
    {
      command:
        "rm -rf test-results/e2e-pipeline-data && mkdir -p test-results/e2e-pipeline-data && " +
        `pnpm start --hostname 127.0.0.1 --port ${e2eEnv.pipelineAppPort}`,
      env: {
        ...appEnv,
        DATABASE_PATH: e2eEnv.pipelineDatabasePath,
        BETTER_AUTH_URL: e2eEnv.pipelineAppUrl,
        ALLOWED_GITHUB_LOGINS: e2eEnv.pipelineAllowedLogins,
        LLM_PROVIDER: llmEnv.provider,
        LLM_API_KEY: llmEnv.apiKey,
        LLM_MODEL: llmEnv.model,
        LLM_MAX_TOKENS: llmEnv.maxTokens,
        REVIEW_DEBOUNCE_SECONDS: "1",
      },
      url: e2eEnv.pipelineAppUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
