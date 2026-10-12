// SPDX-License-Identifier: Apache-2.0

// Addresses and dummy credentials shared by the Playwright configuration (which starts the app and
// the fake GitHub) and the journeys. Nothing here is a secret: the values only have to match
// between the two processes under test.
const appPort = Number(process.env.E2E_PORT) || 3417;
// The second app of the run, for the journey that runs the real runner (see playwright.config.ts):
// the next port unless E2E_PIPELINE_PORT says otherwise.
const pipelineAppPort = Number(process.env.E2E_PIPELINE_PORT) || appPort + 1;
// The third app of the run, for the journey of the first-run setup (it needs an instance that nobody
// has set up): the port after the second one unless E2E_SETUP_PORT says otherwise.
const setupAppPort = Number(process.env.E2E_SETUP_PORT) || appPort + 2;
// The fourth app of the run, for the journey of the sign-up and the email verification (it has a mail
// outbox, which makes every other journey's admin ask for a verified address): the port after the third
// one unless E2E_SIGNUP_PORT says otherwise.
const signupAppPort = Number(process.env.E2E_SIGNUP_PORT) || appPort + 3;
// The fifth app of the run, for the journeys of the workspaces in a multi-tenant instance (people create
// workspaces and switch between them): the port after the fourth one unless E2E_MULTI_PORT says otherwise.
const multiAppPort = Number(process.env.E2E_MULTI_PORT) || appPort + 4;
// The app of the journey of the update from the previous release (e2e/upgrade/): the journey starts and restarts
// it itself, on the port after the fifth app unless E2E_UPGRADE_PORT says otherwise.
const upgradeAppPort = Number(process.env.E2E_UPGRADE_PORT) || appPort + 5;
// The fake GitHub gets a random port in a high range, so two checkouts never collide however their
// E2E_PORT values are chosen. The choice is stored in the environment: Playwright loads this file
// again in every worker process, which inherits the main process's environment.
process.env.E2E_GITHUB_PORT ||= String(
  20000 + Math.floor(Math.random() * 20000),
);
const githubPort = Number(process.env.E2E_GITHUB_PORT);
// The fake SMTP server takes three ports in a row (the plain one that offers STARTTLS, the one with TLS and
// the control API the journeys read the inbox from), also random and kept in the environment. A base of its
// own so that the three never overlap the fake GitHub's port.
process.env.E2E_SMTP_PORT ||= String(40500 + Math.floor(Math.random() * 20000));
const smtpPort = Number(process.env.E2E_SMTP_PORT);
// The fake LLM of the journey of the LLM key. The fifth app (multi-tenant) checks keys at this address (the
// "test key" button), so the port has to be known when the app starts: random, in a range of its own, and kept
// in the environment for the worker processes like the others.
process.env.E2E_LLM_PORT ||= String(61000 + Math.floor(Math.random() * 4000));
const llmFakePort = Number(process.env.E2E_LLM_PORT);

export const e2eEnv = {
  appPort,
  /** The SQLite file of the app under test, relative to the app folder (fresh for every run). */
  databasePath: "test-results/e2e-data/app.db",
  githubPort,
  appUrl: `http://127.0.0.1:${appPort}`,
  pipelineAppPort,
  /** The SQLite file of the second app, relative to the app folder (fresh for every run). */
  pipelineDatabasePath: "test-results/e2e-pipeline-data/app.db",
  pipelineAppUrl: `http://127.0.0.1:${pipelineAppPort}`,
  setupAppPort,
  /** The SQLite file of the third app, which the setup journey sets up (fresh for every run). */
  setupDatabasePath: "test-results/e2e-setup-data/app.db",
  setupAppUrl: `http://127.0.0.1:${setupAppPort}`,
  signupAppPort,
  /** The SQLite file of the fourth app, which the sign-up journey uses (fresh for every run). */
  signupDatabasePath: "test-results/e2e-signup-data/app.db",
  signupAppUrl: `http://127.0.0.1:${signupAppPort}`,
  multiAppPort,
  /** The SQLite file of the fifth app, which is multi-tenant (fresh for every run). */
  multiDatabasePath: "test-results/e2e-multi-data/app.db",
  multiAppUrl: `http://127.0.0.1:${multiAppPort}`,
  upgradeAppPort,
  upgradeAppUrl: `http://127.0.0.1:${upgradeAppPort}`,
  /**
   * The fake SMTP server (fakes/smtp): the journey of the mail page configures the fourth app to send to it
   * (host, STARTTLS port, TLS port, a login), and every journey that reads a mail reads the "inbox" from its
   * control API.
   */
  smtp: {
    host: "127.0.0.1",
    port: smtpPort,
    tlsPort: smtpPort + 1,
    controlPort: smtpPort + 2,
    controlUrl: `http://127.0.0.1:${smtpPort + 2}`,
    user: "e2e-mailer",
    password: "e2e-smtp-password-0123456789",
  },
  /**
   * Where each app's output goes (relative to the app folder). The first-run setup prints its code
   * in the log only, so the journeys read it from there, the way an operator reads `docker compose
   * logs`. The files are fresh for every run.
   */
  logFiles: {
    app: "test-results/e2e-app.log",
    pipeline: "test-results/e2e-pipeline.log",
    setup: "test-results/e2e-setup.log",
    signup: "test-results/e2e-signup.log",
    multi: "test-results/e2e-multi.log",
  },
  /** The instance admin the journeys create when they set an app up. A dummy, as everything here. */
  adminEmail: "admin@e2e.test",
  adminPassword: "e2e-admin-passphrase-orbit-lantern-77",
  githubUrl: `http://127.0.0.1:${githubPort}`,
  /** The fake LLM of the LLM key journey; the fifth app is pointed at its `/api/v1` (LLM_API_BASE_URL). */
  llmFakePort,
  llmFakeApiUrl: `http://127.0.0.1:${llmFakePort}/api/v1`,
  githubClientId: "e2e-client-id",
  githubClientSecret: "e2e-client-secret-value",
  appSecret: "e2e-app-secret-0123456789-0123456789-abcdef",
  // The production server refuses to start without the runner token. A dummy: only the journey of
  // e2e/jobs starts a runner that talks to an app (the second one); the others act on the queue
  // through its code (e2e/helpers/job-queue.ts).
  runnerToken: "e2e-runner-token-0123456789-0123456789-abcdef",
  // The GitHub App of the apps under test, which the run enters in the admin portal of each (e2e/setup/
  // prepare-apps.e2e.ts). The webhook secret matters to the journeys (they sign deliveries with it); the
  // private key is generated for each run in playwright.config.ts and handed on through the environment.
  githubAppId: "424242",
  githubAppSlug: "code-reviewer-e2e",
  /** The login the app's comments are written as at the fake GitHub. */
  githubBotLogin: "code-reviewer-e2e[bot]",
  githubAppWebhookSecret: "e2e-webhook-secret-value",
};

/**
 * The LLM access of the second app. The key is a dummy that must never show up anywhere: the fake
 * LLM quotes it in its errors, and the journey searches every output for it. The model is one
 * PR-Agent does not know, so the context window is given too.
 */
export const llmEnv = {
  provider: "openrouter",
  apiKey: "e2e-llm-key-0123456789-0123456789-abcdef",
  model: "test/fake-model",
  maxTokens: "32000",
};

/**
 * The private key of the GitHub App registered at the fake GitHub (a throwaway made for each run in
 * playwright.config.ts and passed on in the environment, never written anywhere), for the journeys that
 * enter the App in the admin portal.
 */
export function githubAppPrivateKey(): string {
  const key = process.env.E2E_GITHUB_APP_PRIVATE_KEY;
  if (key === undefined || key === "")
    throw new Error("playwright.config.ts did not make the GitHub App key.");
  return key;
}

/**
 * What the journey of the update from the previous release (e2e/upgrade/) needs besides the shared values: where
 * its files are (relative to the app folder, fresh for every run) and the secrets of the installation that is
 * updated. The master key is the one the previous release ran with (`BETTER_AUTH_SECRET`); the LLM key is the
 * one of its environment. Dummies that must never show up in a log.
 */
export const upgradeEnv = {
  directory: "test-results/e2e-upgrade",
  databasePath: "test-results/e2e-upgrade/data/app.db",
  backupDir: "test-results/e2e-upgrade/backups",
  legacySecret: "e2e-legacy-better-auth-secret-0123456789-abcdef",
  llmKey: "e2e-legacy-llm-key-0123456789-0123456789-abcdef",
  oauthClientId: "e2e-legacy-oauth-client-id",
  oauthClientSecret: "e2e-legacy-oauth-client-secret-0123456789",
};
