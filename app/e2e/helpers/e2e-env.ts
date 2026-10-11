// Addresses and dummy credentials shared by the Playwright configuration (which starts the app and
// the fake GitHub) and the journeys. Nothing here is a secret: the values only have to match
// between the two processes under test.
const appPort = Number(process.env.E2E_PORT) || 3417;
// The second app of the run, for the journey that runs the real runner (see playwright.config.ts):
// the next port unless E2E_PIPELINE_PORT says otherwise.
const pipelineAppPort = Number(process.env.E2E_PIPELINE_PORT) || appPort + 1;
// The fake GitHub gets a random port in a high range, so two checkouts never collide however their
// E2E_PORT values are chosen. The choice is stored in the environment: Playwright loads this file
// again in every worker process, which inherits the main process's environment.
process.env.E2E_GITHUB_PORT ||= String(
  20000 + Math.floor(Math.random() * 20000),
);
const githubPort = Number(process.env.E2E_GITHUB_PORT);

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
  /** ALLOWED_GITHUB_LOGINS of the second app. */
  pipelineAllowedLogins: "pipeline-journey",
  githubUrl: `http://127.0.0.1:${githubPort}`,
  githubClientId: "e2e-client-id",
  githubClientSecret: "e2e-client-secret-value",
  // ALLOWED_GITHUB_LOGINS of the app under test: the accounts of the journeys that sign in. A new
  // journey that signs in with an account of its own adds the login here. Accounts that are not
  // listed are refused (see e2e/auth/allow-list.e2e.ts).
  allowedLogins: [
    "login-journey",
    "nav-journey",
    "projects-journey",
    "inactive-journey",
    "runs-journey",
    "manual-journey",
  ].join(","),
  authSecret: "e2e-auth-secret-0123456789-0123456789-abcdef",
  // The production server refuses to start without the runner token. A dummy: only the journey of
  // e2e/jobs starts a runner that talks to an app (the second one); the others act on the queue
  // through its code (e2e/helpers/job-queue.ts).
  runnerToken: "e2e-runner-token-0123456789-0123456789-abcdef",
  // The GitHub App of the app under test. Only the webhook secret matters to the journeys (they
  // sign deliveries with it); the private key is generated for each run in playwright.config.ts.
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
