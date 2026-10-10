// Addresses and dummy credentials shared by the Playwright configuration (which starts the app and
// the fake GitHub) and the journeys. Nothing here is a secret: the values only have to match
// between the two processes under test.
const appPort = Number(process.env.E2E_PORT) || 3417;
const githubPort = Number(process.env.E2E_GITHUB_PORT) || appPort + 1;

export const e2eEnv = {
  appPort,
  githubPort,
  appUrl: `http://127.0.0.1:${appPort}`,
  githubUrl: `http://127.0.0.1:${githubPort}`,
  githubClientId: "e2e-client-id",
  githubClientSecret: "e2e-client-secret-value",
  authSecret: "e2e-auth-secret-0123456789-0123456789-abcdef",
};
