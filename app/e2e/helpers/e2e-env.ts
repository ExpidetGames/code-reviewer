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
  },
  /** The instance admin the journeys create when they set an app up. A dummy, as everything here. */
  adminEmail: "admin@e2e.test",
  adminPassword: "e2e-admin-passphrase-orbit-lantern-77",
  githubUrl: `http://127.0.0.1:${githubPort}`,
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
