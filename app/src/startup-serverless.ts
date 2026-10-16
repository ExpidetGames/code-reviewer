// SPDX-License-Identifier: Apache-2.0

// The start of a serverless instance, called from `src/instrumentation.ts` when the runtime mode is
// serverless (src/runtime/mode.ts). Every cold start of every instance runs this, so it only CHECKS
// settings and reports; it opens no database and starts no timer. What a long-lived server does at start
// is left out on purpose:
//
// - migrations: `pnpm migrate` (src/db/migrate-cli.ts), run at deployment time; the app reports a
//   database that is behind on /api/health (src/health/health.ts) and never changes the schema;
// - the backup of an old database and the legacy import: they are for an installation that updates in
//   place from before accounts, which a hosted deployment never is;
// - the setup code held in this process's memory: another instance would not know it. The operator makes
//   the code with `pnpm setup-code` (src/setup/setup-code-cli.ts) and the instances check it in the
//   database (src/setup/database-code-store.ts, #321);
// - the sync with GitHub, the cleanup and the backup timer: the instance lives for seconds, so a timer
//   would never fire. The sync runs from a daily cron and from the webhooks (src/app/api/internal/
//   repository-sync), the cleanup from the sweep (#328).
//
// A bad setting aborts the start by throwing, never by `process.exit`: on a serverless platform that
// would end the function instead of failing one start.
import { DatabaseError } from "./db/errors.ts";

/** Stands for `process.exit` in the checks shared with the server start; they log first, then call it. */
function abortStart(code: number): never {
  throw new Error(
    `The start was aborted by a configuration check (it would have exited with code ${String(code)} on a server); the line above says what to fix.`,
  );
}

export async function registerServerless(): Promise<void> {
  const { checkAuthConfigOnStart } = await import("./auth/startup.ts");
  checkAuthConfigOnStart({ exit: abortStart });
  const { checkDeploymentConfigOnStart } = await import("./deploy/startup.ts");
  await checkDeploymentConfigOnStart({ exit: abortStart });
  const { checkLlmConfigOnStart } = await import("./llm/startup.ts");
  checkLlmConfigOnStart();
  // Only the settings are read: the pool opens with the first request (`getDatabase()`).
  const { loadDatabaseConfig } = await import("./db/config.ts");
  try {
    loadDatabaseConfig(process.env);
  } catch (error) {
    if (error instanceof DatabaseError)
      console.error(`[database] ${error.code}: ${error.message}`);
    throw error;
  }
  const { warnAboutRunnerToken } = await import("./runner-api/startup.ts");
  warnAboutRunnerToken(process.env);
  const { logOperatorApiState } = await import("./operator-api/startup.ts");
  logOperatorApiState(process.env);
  const { warnAboutDebounce } = await import("./webhooks/debounce-config.ts");
  warnAboutDebounce(process.env);
}
