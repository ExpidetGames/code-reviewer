// What the app remembers about its last scheduled backup, for the status route. Held in the memory
// of the server process (a restart forgets it; the directory itself still shows the newest backup).
// The global survives module reloads in `next dev` and is shared between the instrumentation bundle
// and the route bundles, which do not share modules.
import "server-only";
import type { BackupErrorCode } from "./errors.ts";

export type BackupRunRecord = {
  /** ISO 8601, UTC. */
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  /** Set when the run failed. The reason in words is in the log, not here: this is served by the status route. */
  errorCode: BackupErrorCode | null;
  /** True when the backup is fine but the rotation could not delete every old backup. */
  rotationIncomplete: boolean;
  fileName: string | null;
  bytes: number | null;
};

const globalKey = Symbol.for("code-reviewer.backup-last-run");
type Holder = typeof globalThis & { [globalKey]?: BackupRunRecord };

export function recordBackupRun(entry: BackupRunRecord): void {
  (globalThis as Holder)[globalKey] = entry;
}

export function getLastBackupRun(): BackupRunRecord | null {
  return (globalThis as Holder)[globalKey] ?? null;
}

/** For tests. */
export function clearLastBackupRun(): void {
  delete (globalThis as Holder)[globalKey];
}
