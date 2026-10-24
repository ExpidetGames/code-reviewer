// SPDX-License-Identifier: LicenseRef-Proprietary

// The backup settings from the environment. The only place that knows the variable names of the
// backup (DATABASE_PATH is the database layer's own variable, read here with the same default).
//
// No `server-only` import: the command line (cli.ts) runs this code without Next.js.
// The Postgres-URL check is written out here on purpose: this folder is copied into the image alone
// (app/Dockerfile), so it must import no value from outside `src/backup` (a test keeps it that way).
import { BackupError } from "./errors.ts";

export const DEFAULT_BACKUP_DIR = "/backups";
export const DEFAULT_BACKUP_TIME = "02:30";
/** The same default as src/db/config.ts (a test keeps the two equal). */
export const DEFAULT_DATABASE_PATH_FOR_BACKUP = "/data/app.db";

/** Whether `DATABASE_URL` names Postgres (the large topology); the same rule as src/db/config.ts. */
function usesExternalPostgres(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const url = env.DATABASE_URL?.trim().toLowerCase() ?? "";
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

export type BackupConfig = {
  databasePath: string;
  backupDir: string;
  /** When the scheduler runs, in UTC; null when it is switched off or does not apply. */
  time: { hour: number; minute: number } | null;
  /**
   * Whether the app schedules backups itself. False for Postgres (an external database is the
   * operator's to back up), so the scheduler starts nothing and the status says so.
   */
  applies: boolean;
};

type Env = Readonly<Record<string, string | undefined>>;

function setting(env: Env, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

/** Where the database is and where the backups go: all that `backup` and `restore` need. */
export function loadBackupPaths(
  env: Env,
): Pick<BackupConfig, "databasePath" | "backupDir"> {
  return {
    databasePath: setting(
      env,
      "DATABASE_PATH",
      DEFAULT_DATABASE_PATH_FOR_BACKUP,
    ),
    backupDir: setting(env, "BACKUP_DIR", DEFAULT_BACKUP_DIR),
  };
}

/** When the scheduler runs. Kept apart from the paths: a typo here must not stop a restore. */
export function loadBackupSchedule(env: Env): BackupConfig["time"] {
  return parseTime(setting(env, "BACKUP_TIME", DEFAULT_BACKUP_TIME));
}

export function loadBackupConfig(env: Env): BackupConfig {
  // Postgres has no file to `VACUUM INTO`, so the schedule does not apply: its settings are not even
  // read, and a stray BACKUP_TIME cannot stop a start whose backups are the operator's job.
  const applies = !usesExternalPostgres(env);
  return {
    ...loadBackupPaths(env),
    applies,
    time: applies ? loadBackupSchedule(env) : null,
  };
}

/** "02:30" for the time of day of the schedule. */
export function formatBackupTime(time: {
  hour: number;
  minute: number;
}): string {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

function parseTime(text: string): BackupConfig["time"] {
  if (text.toLowerCase() === "off") return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!match)
    throw new BackupError(
      "BACKUP_CONFIG_INVALID",
      'BACKUP_TIME must be a time of day in UTC written HH:MM (for example "02:30"), or "off".',
    );
  return { hour: Number(match[1]), minute: Number(match[2]) };
}
