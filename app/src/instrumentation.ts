// Runs once when the Next.js server starts and must finish before the server accepts requests.
// The sign in and deployment settings are checked and the database is opened and migrated here, so a missing
// setting or a broken migration stops the start; then the pins of the allow list are brought in line
// with the settings. Last, the repositories are synchronized with GitHub in the background: that
// never delays or stops the start. The LLM settings are only reported, never a reason to stop.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkAuthConfigOnStart } = await import("./auth/startup.ts");
  checkAuthConfigOnStart();
  // Production only: the runner token and the GitHub App credentials (docker compose passes them).
  const { checkDeploymentConfigOnStart } = await import("./deploy/startup.ts");
  checkDeploymentConfigOnStart();
  // A missing LLM key only warns: everything but running a review works without it.
  const { checkLlmConfigOnStart } = await import("./llm/startup.ts");
  checkLlmConfigOnStart();
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
  const { runStartupSync } = await import("./integrations/sync/startup.ts");
  void runStartupSync();
  // Last: the daily backup timer (production only). It needs nothing from the app's own connection,
  // and a problem with it never stops the app from serving.
  const { startBackupSchedulerOnStart } = await import("./backup/startup.ts");
  startBackupSchedulerOnStart();
}
