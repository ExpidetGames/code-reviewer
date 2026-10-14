// SPDX-License-Identifier: Apache-2.0

// The privileged Dynamic e2e lane (#253): one fake GitHub and one app under test (a production build,
// made once by runner/scripts/run_dynamic_e2e.sh before this runs), and the journeys of e2e/dynamic, which
// start the real Dynamic runner as root and the pinned OpenCode as its engine user. It is a configuration of
// its own because the lane needs root, nft, an engine user and a network namespace that nothing of
// `playwright.config.ts` has: the other journeys never run it, and the lane never runs theirs. Run it with
// `make test-e2e-dynamic` (it uses sudo), not directly.
//
// Ports: the app listens on E2E_PIPELINE_PORT (default E2E_PORT + 1) and nothing else of the lane listens
// on a fixed port (the fake GitHub takes a random one, the fake LLM another); never 3000 or 3100.
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";
import { e2eEnv, llmEnv } from "./e2e/helpers/e2e-env";

for (const port of [e2eEnv.appPort, e2eEnv.pipelineAppPort])
  if (port === 3000 || port === 3100)
    throw new Error(
      `The lane must not use port ${String(port)}: other work runs there. Set E2E_PORT to a private one.`,
    );

// A throwaway key for the GitHub App of the app under test, new for every run and never written anywhere
// (the same as playwright.config.ts).
process.env.E2E_GITHUB_APP_PRIVATE_KEY ||= generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const githubAppPublicKey = createPublicKey(
  process.env.E2E_GITHUB_APP_PRIVATE_KEY,
)
  .export({ type: "spki", format: "pem" })
  .toString();

const browser = {
  ...devices["Desktop Chrome"],
  channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  baseURL: e2eEnv.pipelineAppUrl,
};

export default defineConfig({
  testDir: "e2e/dynamic",
  testMatch: /.*\.e2e\.ts$/,
  // Before anything else: the lane says what is missing and stops (e2e/helpers/dynamic-preflight.ts).
  globalSetup: "./e2e/dynamic/preflight.global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // One runner, one slot, one database: nothing of the lane runs next to anything else.
  workers: 1,
  timeout: 240_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: e2eEnv.pipelineAppUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // The app starts without a database: the first-run setup and the GitHub App, once per run.
    {
      name: "prepare",
      use: browser,
      testMatch: /prepare-app\.e2e\.ts$/,
    },
    // The guard first proves its own counters move; then the journey, which also reads it.
    {
      name: "guard",
      use: browser,
      testMatch: /network-guard\.e2e\.ts$/,
      dependencies: ["prepare"],
    },
    {
      name: "journey",
      use: browser,
      testMatch: /dynamic-review\.e2e\.ts$/,
      dependencies: ["guard"],
    },
  ],
  webServer: [
    {
      command: "node ../fakes/github/main.ts",
      env: {
        GITHUB_FAKE_PORT: String(e2eEnv.githubPort),
        GITHUB_FAKE_CLIENT_ID: e2eEnv.githubClientId,
        GITHUB_FAKE_CLIENT_SECRET: e2eEnv.githubClientSecret,
        GITHUB_FAKE_MANIFEST_FLOW: "true",
        GITHUB_FAKE_APP_ID: e2eEnv.githubAppId,
        GITHUB_FAKE_APP_PUBLIC_KEY: githubAppPublicKey,
        GITHUB_FAKE_APP_SLUG: e2eEnv.githubAppSlug,
        // The links of the fake point to the fake, so that a pull request and the API address of a job
        // are on one host, which the runner demands.
        GITHUB_FAKE_SELF_LINKS: "true",
        // The comments carry github.com links, like a real GitHub's (the Runs page links only to those).
        GITHUB_FAKE_COMMENT_LINKS: "https://github.com",
      },
      url: `${e2eEnv.githubUrl}/__fake/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // The build is made once, before the lane starts (one production build per worktree).
      command:
        "rm -rf test-results/e2e-pipeline-data && mkdir -p test-results/e2e-pipeline-data && " +
        `./node_modules/.bin/next start --hostname 127.0.0.1 --port ${e2eEnv.pipelineAppPort} > ${e2eEnv.logFiles.pipeline} 2>&1`,
      env: {
        APP_SECRET: e2eEnv.appSecret,
        GITHUB_OAUTH_BASE_URL: e2eEnv.githubUrl,
        GITHUB_API_BASE_URL: e2eEnv.githubUrl,
        RUNNER_TOKEN: e2eEnv.runnerToken,
        // Without this flag the server refuses the two overrides above.
        ALLOW_TEST_GITHUB_ENDPOINTS: "true",
        DATABASE_PATH: e2eEnv.pipelineDatabasePath,
        BETTER_AUTH_URL: e2eEnv.pipelineAppUrl,
        LLM_MODEL: llmEnv.model,
        LLM_MAX_TOKENS: llmEnv.maxTokens,
        // A push is reviewed after a second instead of after 90.
        REVIEW_DEBOUNCE_SECONDS: "1",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      url: e2eEnv.pipelineAppUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
