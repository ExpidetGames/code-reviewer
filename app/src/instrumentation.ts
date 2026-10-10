// Runs once when the Next.js server starts and must finish before the server accepts requests.
// The sign in settings are checked and the database is opened and migrated here, so a missing
// setting or a broken migration stops the start.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkAuthConfigOnStart } = await import("./auth/startup.ts");
  checkAuthConfigOnStart();
  const { initializeDatabaseOnStart } = await import("./db/startup.ts");
  await initializeDatabaseOnStart();
}
