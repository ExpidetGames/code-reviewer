// SPDX-License-Identifier: Apache-2.0

// Runs once when the Next.js server starts and must finish before the server accepts requests.
// The sign in, deployment and backup settings are checked and the database is opened and migrated here, so a missing
// setting or a broken migration stops the start. An installation from before accounts is backed up first
// (before the migrations touch it) and imported right after them (src/legacy-import/); a backup or an import that
// fails ends the start. While the instance is not set up, the setup code is printed. Last, the repositories are
// synchronized with GitHub in the background: that never delays or stops the start. The LLM options are only
// reported, never a reason to stop.
//
// A serverless instance (APP_RUNTIME=serverless, src/runtime/mode.ts) runs none of the above that opens the
// database or starts a timer: see src/startup-serverless.ts.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { isServerless } = await import("./runtime/mode.ts");
  if (isServerless()) {
    const { registerServerless } = await import("./startup-serverless.ts");
    return registerServerless();
  }
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
  // A wrong LLM option only warns: everything but running a review works without it.
  const { checkLlmConfigOnStart } = await import("./llm/startup.ts");
  checkLlmConfigOnStart();
  // An installation from before accounts is backed up before anything touches it. If that fails the start ends
  // here, with the database as the previous release left it.
  const { backupBeforeUpdateOnStart } =
    await import("./legacy-import/backup-step.ts");
  backupBeforeUpdateOnStart();
  const { getDatabase, initializeDatabaseOnStart } =
    await import("./db/startup.ts");
  await initializeDatabaseOnStart();
  // After the migrations: the data, the GitHub App and the LLM key of an existing installation move into the
  // new model once, in one transaction. A failure ends the start and leaves nothing behind.
  const { importOnStart } = await import("./legacy-import/startup.ts");
  await importOnStart({ db: getDatabase() });
  // While the instance is not set up: a fresh setup code, printed once to this log and kept (as a
  // hash) in the memory of this process. Nothing is printed once it is set up.
  const { startSetupOnStart } = await import("./setup/start.ts");
  const { getSetupCodeStore } = await import("./setup/shared.ts");
  await startSetupOnStart({ db: getDatabase(), store: getSetupCodeStore() });
  const { warnAboutRunnerToken } = await import("./runner-api/startup.ts");
  warnAboutRunnerToken(process.env);
  // One line: whether the operator API is on (it is off, and absent, until OPERATOR_API_TOKEN is set).
  const { logOperatorApiState } = await import("./operator-api/startup.ts");
  logOperatorApiState(process.env);
  const { warnAboutDebounce } = await import("./webhooks/debounce-config.ts");
  warnAboutDebounce(process.env);
  // Without a GitHub App in the database and without any variable the instance is simply not connected
  // to GitHub (yet): there is nothing to read, so nothing is attempted and nothing is reported as failed.
  const { getGithubCredentialStore } =
    await import("./github-config/shared.ts");
  if ((await getGithubCredentialStore().load()).source !== "none") {
    const { runStartupSync } = await import("./integrations/sync/startup.ts");
    void runStartupSync();
  }
  // Old counters and spent verification links are removed now and every hour (production only).
  const { startCleanupOnStart } = await import("./maintenance/startup.ts");
  startCleanupOnStart();
  // The check runs of the review jobs are brought in line with GitHub every minute: the jobs that ended without
  // a request of their own (a lease that ran out, a timeout) are found here (production only).
  const { startCheckReconcilerOnStart } =
    await import("./check-runs/startup.ts");
  startCheckReconcilerOnStart();
  // The models.dev catalog is fetched once a day, asked for at the start and every hour (production only, and not when
  // MODELS_DEV_FETCH=off). A failed fetch keeps the rows it has.
  const { startModelsDevRefreshOnStart } =
    await import("./models-dev/startup.ts");
  startModelsDevRefreshOnStart();
  // Last: the daily backup timer (production only). It needs nothing from the app's own connection,
  // and a problem with it never stops the app from serving.
  startBackupSchedulerOnStart();
}
