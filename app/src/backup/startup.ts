// What the production server does about backups when it starts: read the settings, say what is
// scheduled (and warn if the target cannot be written to right now), and start the daily timer.
// Called from `src/instrumentation.ts`. Other environments (the dev server, tests) run no timer.
//
// An invalid setting ends the start with one readable line, like the other settings of a deployment:
// a typo must not turn into "no backups" without anybody noticing.
import "server-only";
import { formatBackupTime, loadBackupConfig } from "./config.ts";
import { assertBackupTargetUsable } from "./create-backup.ts";
import { BackupError } from "./errors.ts";
import { runBackupJob } from "./run-backup.ts";
import { recordBackupRun } from "./run-state.ts";
import { startBackupScheduler, type BackupScheduler } from "./scheduler.ts";

type StartOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  log?: Pick<Console, "info" | "warn" | "error">;
  exit?: (code: number) => void;
  startScheduler?: typeof startBackupScheduler;
};

export function startBackupSchedulerOnStart({
  env = process.env,
  log = console,
  exit = (code) => process.exit(code),
  startScheduler = startBackupScheduler,
}: StartOptions = {}): BackupScheduler | null {
  if (env.NODE_ENV !== "production") return null;

  let config;
  try {
    config = loadBackupConfig(env);
  } catch (error) {
    if (!(error instanceof BackupError)) throw error;
    log.error(`[backup] ${error.code}: ${error.message}`);
    exit(1);
    return null;
  }
  if (config.time === null) {
    log.warn(
      "[backup] BACKUP_TIME=off: no daily backup is scheduled. Make sure something else backs up the database.",
    );
    return null;
  }

  try {
    assertBackupTargetUsable(config.backupDir, config.databasePath);
  } catch (error) {
    // The app runs without backups until this is fixed; the status route shows the same problem.
    if (!(error instanceof BackupError)) throw error;
    log.error(`[backup] ${error.code}: ${error.message}`);
  }

  const { databasePath, backupDir, time } = config;
  const scheduler = startScheduler({
    time,
    run: () => runBackupJob({ databasePath, backupDir }),
    record: recordBackupRun,
  });
  log.info(
    `[backup] daily backup scheduled at ${formatBackupTime(time)} UTC into ${backupDir}`,
  );
  return scheduler;
}
