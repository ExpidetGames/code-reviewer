// SPDX-License-Identifier: Apache-2.0

// The command line of the backup, for a Coolify scheduled task, a manual run and the restore guide:
//
//   node backup/cli.ts backup             back up DATABASE_PATH into BACKUP_DIR, then rotate
//   node backup/cli.ts restore <file>     replace DATABASE_PATH with a backup (stop the app first)
//
// Exit code 0 on success, 1 when the job failed (the reason is one line on stderr: a stable error
// code and a message), 2 for a wrong command line. Output holds paths, sizes and error codes only.
//
// Node runs this file as it is (TypeScript types are stripped), without Next.js and without the
// app's other code: it imports only the files of this folder and better-sqlite3. That is why the
// image copies this folder as it is (app/Dockerfile).
import { loadBackupPaths } from "./config.ts";
import { BackupError } from "./errors.ts";
import { restoreBackup } from "./restore.ts";
import { runBackupJob } from "./run-backup.ts";

const USAGE =
  "Usage: node backup/cli.ts backup | node backup/cli.ts restore <backup file>";

type Streams = {
  out: (line: string) => void;
  err: (line: string) => void;
};

export function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  { out, err }: Streams,
): number {
  const [command, ...rest] = args;
  if (command === "backup" && rest.length === 0)
    return backup(env, { out, err });
  if (command === "restore" && rest.length === 1 && rest[0])
    return restore(rest[0], env, { out, err });
  err(USAGE);
  return 2;
}

function backup(
  env: Readonly<Record<string, string | undefined>>,
  { out, err }: Streams,
): number {
  try {
    const config = loadBackupPaths(env);
    const outcome = runBackupJob({
      databasePath: config.databasePath,
      backupDir: config.backupDir,
      log: { info: out, error: err },
    });
    return outcome.ok ? 0 : 1;
  } catch (error) {
    return fail(error, err);
  }
}

function restore(
  backupPath: string,
  env: Readonly<Record<string, string | undefined>>,
  { out, err }: Streams,
): number {
  try {
    const config = loadBackupPaths(env);
    const result = restoreBackup({
      backupPath,
      databasePath: config.databasePath,
    });
    out(`[restore] restored ${backupPath} to ${result.databasePath}`);
    if (result.previousKeptAs !== null)
      out(
        `[restore] the previous database was kept as ${result.previousKeptAs}`,
      );
    // Its -journal, -wal and -shm, or (without a database) the leftover files that were alone.
    const others = result.keptAside.filter(
      (path) => path !== result.previousKeptAs,
    );
    if (others.length > 0)
      out(
        `[restore] ${result.previousKeptAs === null ? "no database was in place; leftover files were kept as" : "its side files were kept as"} ${others.join(", ")}`,
      );
    return 0;
  } catch (error) {
    return fail(error, err);
  }
}

function fail(error: unknown, err: (line: string) => void): number {
  if (error instanceof BackupError) {
    err(`[backup] ${error.code}: ${error.message}`);
    return 1;
  }
  throw error;
}

// Runs only when started as the program, not when a test imports `runCli`. `import.meta.main` is
// true however the file was reached (through a symlinked folder, a relative path): comparing
// `process.argv[1]` with the module's own path is not, and a command that silently does nothing
// would report success to a scheduled task.
if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2), process.env, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
