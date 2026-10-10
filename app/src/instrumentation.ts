// Runs once when the Next.js server starts and must finish before the server accepts requests.
// The sign in and deployment settings are checked and the database is opened and migrated here, so a missing
// setting or a broken migration stops the start; then the pins of the allow list are brought in line
// with the settings.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkAuthConfigOnStart } = await import("./auth/startup.ts");
  checkAuthConfigOnStart();
  // Production only: the runner token and the GitHub App credentials (docker compose passes them).
  const { checkDeploymentConfigOnStart } = await import("./deploy/startup.ts");
  checkDeploymentConfigOnStart();
  const { getDatabase, initializeDatabaseOnStart } =
    await import("./db/startup.ts");
  await initializeDatabaseOnStart();
  // After the migrations: the pins of the allow list need their table.
  const { loadAuthConfig } = await import("./auth/config.ts");
  const { syncLoginPinsOnStart } = await import("./auth/startup.ts");
  await syncLoginPinsOnStart({
    db: getDatabase(),
    config: loadAuthConfig(process.env).access,
  });
}
