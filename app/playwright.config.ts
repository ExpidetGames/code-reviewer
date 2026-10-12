// SPDX-License-Identifier: Apache-2.0

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";
import { e2eEnv, llmEnv } from "./e2e/helpers/e2e-env";

// Own ports per checkout (E2E_PORT, default 3417; the fake GitHub gets a random one, see
// e2e/helpers/e2e-env.ts); never 3000 or 3100 so parallel work in other worktrees is safe.
const baseURL = e2eEnv.appUrl;

// A throwaway key for the GitHub App of the apps under test, new for every run and never written
// anywhere. The run enters the App in the admin portal of each app (e2e/setup/prepare-apps.e2e.ts),
// so the journeys that need a token (the real review) and the portal's own check (`GET /app` with
// the App's JWT) work against the fake GitHub. It is made once in this process and handed on through
// the environment, which every worker inherits.
process.env.E2E_GITHUB_APP_PRIVATE_KEY ||= generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const githubAppPrivateKey = process.env.E2E_GITHUB_APP_PRIVATE_KEY;

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

// What all apps under test share: the address of GitHub (the fake), the master key and the runner token,
// all dummies. The GitHub App itself is not in the environment: the run enters it in each app's admin portal.
const appEnv = {
  APP_SECRET: e2eEnv.appSecret,
  GITHUB_OAUTH_BASE_URL: e2eEnv.githubUrl,
  GITHUB_API_BASE_URL: e2eEnv.githubUrl,
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
    // The apps under test start without a database, so each is a new instance that answers nothing
    // but its health check until it is set up. This sets up the two that the other projects use
    // (e2e/setup/prepare-apps.e2e.ts); every other project waits for it.
    {
      name: "prepare",
      use: browser,
      testMatch: /e2e\/setup\/prepare-apps\.e2e\.ts$/,
    },
    {
      name: "chromium",
      use: browser,
      dependencies: ["prepare"],
      testIgnore: [
        /e2e\/runs\//,
        /e2e\/reviews\//,
        /e2e\/jobs\//,
        /e2e\/setup\//,
        /e2e\/auth\/(sign-up|password-reset)\.e2e\.ts$/,
        /e2e\/admin\/mail\.e2e\.ts$/,
        /e2e\/admin\/github-integration\.e2e\.ts$/,
        /e2e\/workspaces\//,
        /e2e\/settings\/llm-key\.e2e\.ts$/,
        /e2e\/upgrade\//,
      ],
    },
    {
      name: "runs",
      use: browser,
      testMatch: /e2e\/runs\/.*\.e2e\.ts$/,
      dependencies: ["prepare"],
    },
    {
      name: "reviews",
      use: browser,
      testMatch: /e2e\/reviews\/.*\.e2e\.ts$/,
      dependencies: ["runs"],
    },
    // The journeys with a mail server have an app of their own (the fourth), because a mail server makes the
    // instance ask every email account for a verified address, which would change what the admin of the
    // other journeys sees. The mail page's journey comes first: it takes the app from "no mail server" to
    // "mail through the fake SMTP server", configured in the admin portal like an operator does it. The
    // sign-up and the password reset use that mail server.
    {
      name: "mail",
      use: { ...browser, baseURL: e2eEnv.signupAppUrl },
      testMatch: /e2e\/admin\/mail\.e2e\.ts$/,
      dependencies: ["prepare"],
    },
    {
      name: "signup",
      use: { ...browser, baseURL: e2eEnv.signupAppUrl },
      testMatch: /e2e\/auth\/(sign-up|password-reset)\.e2e\.ts$/,
      dependencies: ["prepare", "mail"],
    },
    // The journey of the invitations changes who belongs to the workspace of the first app and needs its
    // sign-up rule to be "everyone", which the admin portal journey changes for a while: it runs after
    // every journey of that app.
    {
      name: "invitations",
      use: browser,
      testMatch: /e2e\/workspaces\/invite-and-accept\.e2e\.ts$/,
      dependencies: ["chromium", "runs", "reviews"],
    },
    // The journeys of the workspaces in a multi-tenant instance have an app of their own (the fifth): people
    // create workspaces there, and a single-tenant instance does not let them.
    {
      name: "multi",
      use: { ...browser, baseURL: e2eEnv.multiAppUrl },
      testMatch: /e2e\/workspaces\/multi-tenant\.e2e\.ts$/,
      dependencies: ["prepare"],
    },
    // The journey of the invitations by mail uses the multi-tenant app again, after the journeys that need it
    // without a mail server: it configures the fake SMTP server there, which makes every account of that
    // app confirm its address.
    {
      name: "multi-mail",
      use: { ...browser, baseURL: e2eEnv.multiAppUrl },
      testMatch: /e2e\/workspaces\/invite-by-mail\.e2e\.ts$/,
      dependencies: ["multi", "multi-llm"],
    },
    // The journey of the LLM key of a workspace uses the multi-tenant app as well (a workspace of its own, so it
    // changes nothing for the others), before the mail server is configured there.
    {
      name: "multi-llm",
      use: { ...browser, baseURL: e2eEnv.multiAppUrl },
      testMatch: /e2e\/settings\/llm-key\.e2e\.ts$/,
      dependencies: ["multi"],
    },
    // The journey that connects GitHub installations to workspaces uses the multi-tenant app again, after the
    // journeys that configure the fake SMTP server there (which makes every account of that app confirm its
    // address) have removed it.
    {
      name: "connect",
      use: { ...browser, baseURL: e2eEnv.multiAppUrl },
      testMatch: /e2e\/workspaces\/connect-github\.e2e\.ts$/,
      dependencies: ["multi-mail"],
    },
    // The journey of the first-run setup has an app of its own that nobody has set up (the third
    // one), so it needs nothing to run first and disturbs nobody.
    {
      name: "setup",
      use: { ...browser, baseURL: e2eEnv.setupAppUrl },
      testMatch: /e2e\/setup\/first-run\.e2e\.ts$/,
    },
    // The journey of the GitHub integration uses the third app after the first-run journey has set it up: it
    // creates the GitHub App through the manifest flow, signs people in with GitHub, merges the admin with an
    // imported operator, makes GitHub the only way to sign in and enters the App by hand, so nobody else may
    // use that app.
    {
      name: "github",
      use: { ...browser, baseURL: e2eEnv.setupAppUrl },
      testMatch: /e2e\/admin\/github-integration\.e2e\.ts$/,
      dependencies: ["setup"],
    },
    // The update of an installation of the previous release (a database and an environment made like the
    // previous release's): the journey starts and restarts the app itself, with a database of its own, and
    // runs the real runner and the real PR-Agent against the fake GitHub, so it only needs the fake GitHub and
    // the build of the first app.
    {
      name: "upgrade",
      use: { ...browser, baseURL: e2eEnv.upgradeAppUrl },
      testMatch: /e2e\/upgrade\/.*\.e2e\.ts$/,
      dependencies: ["prepare"],
    },
    // The journey with the real runner and the real PR-Agent. It has an app of its own (its own
    // database, the LLM configured, a real runner polling it), so it cannot disturb the queue of the
    // other journeys and they cannot disturb it, and it runs next to them.
    {
      name: "jobs",
      use: { ...browser, baseURL: e2eEnv.pipelineAppUrl },
      testMatch: /e2e\/jobs\/.*\.e2e\.ts$/,
      dependencies: ["prepare"],
    },
  ],
  // Six servers. The fake GitHub stands in for github.com (sign in) and api.github.com; the app
  // under test is pointed at it by environment variables. The journeys always run against a
  // production build, never the dev server, with a fresh SQLite file in the (git-ignored)
  // test-results folder; the app migrates it on start. All values are fixed dummies.
  //
  // Each app's output goes to a log file in test-results: a new instance prints its setup code only
  // there, and the journeys read it from the file (e2e/helpers/setup.ts).
  //
  // The second app serves the same build (the servers start one after the other, so the build of
  // the first is done) with a database of its own and the settings the journey with the real
  // runner needs: the LLM access (the other app has none, a journey checks its warning), and a
  // push that is reviewed after a second instead of after 90 seconds. The third is the same build
  // again, left unconfigured and not set up, for the journey that walks through the first-run
  // wizard. The fourth is the same build with a database of its own, for the journeys that need a mail server:
  // the journey of the mail page configures it in the admin portal to send to the fake SMTP server (the
  // sixth server), and the sign-up and the password reset read their mail from that server's inbox.
  webServer: [
    {
      command: "node ../fakes/github/main.ts",
      env: {
        GITHUB_FAKE_PORT: String(e2eEnv.githubPort),
        GITHUB_FAKE_CLIENT_ID: e2eEnv.githubClientId,
        GITHUB_FAKE_CLIENT_SECRET: e2eEnv.githubClientSecret,
        // Apps can also be created through the manifest flow (e2e/admin/github-integration.e2e.ts).
        GITHUB_FAKE_MANIFEST_FLOW: "true",
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
      command: "node ../fakes/smtp/main.ts",
      env: {
        SMTP_FAKE_PORT: String(e2eEnv.smtp.port),
        SMTP_FAKE_TLS_PORT: String(e2eEnv.smtp.tlsPort),
        SMTP_FAKE_CONTROL_PORT: String(e2eEnv.smtp.controlPort),
        SMTP_FAKE_USER: e2eEnv.smtp.user,
        SMTP_FAKE_PASSWORD: e2eEnv.smtp.password,
      },
      url: `${e2eEnv.smtp.controlUrl}/__fake/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        "pnpm build && rm -rf test-results/e2e-data && mkdir -p test-results/e2e-data && " +
        `pnpm start --hostname 127.0.0.1 --port ${e2eEnv.appPort} > ${e2eEnv.logFiles.app} 2>&1`,
      env: {
        ...appEnv,
        DATABASE_PATH: e2eEnv.databasePath,
        BETTER_AUTH_URL: e2eEnv.appUrl,
      },
      url: e2eEnv.appUrl,
      reuseExistingServer: false,
      timeout: 240_000,
    },
    {
      command:
        "rm -rf test-results/e2e-pipeline-data && mkdir -p test-results/e2e-pipeline-data && " +
        `pnpm start --hostname 127.0.0.1 --port ${e2eEnv.pipelineAppPort} > ${e2eEnv.logFiles.pipeline} 2>&1`,
      env: {
        ...appEnv,
        DATABASE_PATH: e2eEnv.pipelineDatabasePath,
        BETTER_AUTH_URL: e2eEnv.pipelineAppUrl,
        // The key is not an environment setting any more: the journey saves it for the workspace, as an Owner
        // does. The model and the context window of a model PR-Agent does not know still are.
        LLM_MODEL: llmEnv.model,
        LLM_MAX_TOKENS: llmEnv.maxTokens,
        REVIEW_DEBOUNCE_SECONDS: "1",
      },
      url: e2eEnv.pipelineAppUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        "rm -rf test-results/e2e-setup-data && mkdir -p test-results/e2e-setup-data && " +
        `pnpm start --hostname 127.0.0.1 --port ${e2eEnv.setupAppPort} > ${e2eEnv.logFiles.setup} 2>&1`,
      env: {
        ...appEnv,
        DATABASE_PATH: e2eEnv.setupDatabasePath,
        BETTER_AUTH_URL: e2eEnv.setupAppUrl,
      },
      url: e2eEnv.setupAppUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        "rm -rf test-results/e2e-signup-data && mkdir -p test-results/e2e-signup-data && " +
        `pnpm start --hostname 127.0.0.1 --port ${e2eEnv.signupAppPort} > ${e2eEnv.logFiles.signup} 2>&1`,
      env: {
        ...appEnv,
        DATABASE_PATH: e2eEnv.signupDatabasePath,
        BETTER_AUTH_URL: e2eEnv.signupAppUrl,
      },
      url: e2eEnv.signupAppUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        "rm -rf test-results/e2e-multi-data && mkdir -p test-results/e2e-multi-data && " +
        `pnpm start --hostname 127.0.0.1 --port ${e2eEnv.multiAppPort} > ${e2eEnv.logFiles.multi} 2>&1`,
      env: {
        ...appEnv,
        DATABASE_PATH: e2eEnv.multiDatabasePath,
        BETTER_AUTH_URL: e2eEnv.multiAppUrl,
        // The "test key" button of the LLM key journey asks the fake LLM, not the provider.
        LLM_API_BASE_URL: e2eEnv.llmFakeApiUrl,
        ALLOW_TEST_LLM_ENDPOINTS: "true",
      },
      url: e2eEnv.multiAppUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
