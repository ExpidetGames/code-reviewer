// Runs once when the Next.js server starts and must finish before the server accepts requests.
// The database is opened and migrated here, so a broken migration stops the start.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { initializeDatabaseOnStart } = await import("./db/startup.ts");
  await initializeDatabaseOnStart();
}
