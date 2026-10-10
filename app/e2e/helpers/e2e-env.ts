// Addresses and dummy credentials shared by the Playwright configuration (which starts the app and
// the fake GitHub) and the journeys. Nothing here is a secret: the values only have to match
// between the two processes under test.
const appPort = Number(process.env.E2E_PORT) || 3417;
// The fake GitHub gets a random port in a high range, so two checkouts never collide however their
// E2E_PORT values are chosen. The choice is stored in the environment: Playwright loads this file
// again in every worker process, which inherits the main process's environment.
process.env.E2E_GITHUB_PORT ||= String(
  20000 + Math.floor(Math.random() * 20000),
);
const githubPort = Number(process.env.E2E_GITHUB_PORT);

export const e2eEnv = {
  appPort,
  githubPort,
  appUrl: `http://127.0.0.1:${appPort}`,
  githubUrl: `http://127.0.0.1:${githubPort}`,
  githubClientId: "e2e-client-id",
  githubClientSecret: "e2e-client-secret-value",
  // ALLOWED_GITHUB_LOGINS of the app under test: the accounts of the journeys that sign in. A new
  // journey that signs in with an account of its own adds the login here. Accounts that are not
  // listed are refused (see e2e/auth/allow-list.e2e.ts).
  allowedLogins: ["login-journey", "nav-journey"].join(","),
  authSecret: "e2e-auth-secret-0123456789-0123456789-abcdef",
};
