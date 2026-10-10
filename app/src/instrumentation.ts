// Runs once when the Next.js server starts and must finish before the server accepts requests.
// The sign in settings are checked and the database is opened and migrated here, so a missing
// setting or a broken migration stops the start; then the pins of the allow list are brought in line
// with the settings. Last, the repositories are synchronized with GitHub in the background: that
// never delays or stops the start.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkAuthConfigOnStart } = await import("./auth/startup.ts");
  checkAuthConfigOnStart();
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
  const { warnAboutRunnerToken } = await import("./runner-api/startup.ts");
  warnAboutRunnerToken(process.env);
  const { runStartupSync } = await import("./integrations/sync/startup.ts");
  void runStartupSync();
}
