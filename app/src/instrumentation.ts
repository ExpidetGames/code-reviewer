// SPDX-License-Identifier: Apache-2.0

// Runs once when the Next.js server starts and must finish before the server accepts requests.
// The sign in, deployment and backup settings are checked and the database is opened and migrated here, so a missing
// setting or a broken migration stops the start; then the pins of the allow list are brought in line
// with the settings, and, while the instance is not set up, the setup code is printed. Last, the
// repositories are synchronized with GitHub in the background: that never delays or stops the
// start. The LLM settings are only reported, never a reason to stop.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkAuthConfigOnStart } = await import("./auth/startup.ts");
  checkAuthConfigOnStart();
  // Production only: the runner token (docker compose passes it). GitHub is optional.
  const { checkDeploymentConfigOnStart } = await import("./deploy/startup.ts");
  await checkDeploymentConfigOnStart();
  // An invalid BACKUP_TIME ends the start here, before the database is opened and before the sync
  // is started in the background (production only).
  const { checkBackupConfigOnStart, startBackupSchedulerOnStart } =
    await import("./backup/startup.ts");
  checkBackupConfigOnStart();
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
  // While the instance is not set up: a fresh setup code, printed once to this log and kept (as a
  // hash) in the memory of this process. Nothing is printed once it is set up.
  const { startSetupOnStart } = await import("./setup/start.ts");
  const { getSetupCodeStore } = await import("./setup/shared.ts");
  await startSetupOnStart({ db: getDatabase(), store: getSetupCodeStore() });
  const { warnAboutRunnerToken } = await import("./runner-api/startup.ts");
  warnAboutRunnerToken(process.env);
  const { warnAboutDebounce } = await import("./webhooks/debounce-config.ts");
  warnAboutDebounce(process.env);
  // Without any GitHub App variable the instance is simply not connected to GitHub (yet): there is
  // nothing to read, so nothing is attempted and nothing is reported as failed.
  const { anyGithubAppVariableSet } =
    await import("./integrations/registry.ts");
  if (anyGithubAppVariableSet(process.env)) {
    const { runStartupSync } = await import("./integrations/sync/startup.ts");
    void runStartupSync();
  }
  // The test stack's mail outbox sends no mail: say so when it is switched on.
  const { warnAboutTestMailOutbox } = await import("./mail/startup.ts");
  warnAboutTestMailOutbox();
  // Old counters and spent verification links are removed now and every hour (production only).
  const { startCleanupOnStart } = await import("./maintenance/startup.ts");
  startCleanupOnStart();
  // Last: the daily backup timer (production only). It needs nothing from the app's own connection,
  // and a problem with it never stops the app from serving.
  startBackupSchedulerOnStart();
}
