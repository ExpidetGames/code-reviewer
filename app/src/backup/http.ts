// The handler behind GET /api/backup/status: the picture of the backups for the people who run the
// instance (schedule, target, last scheduled run, newest backup). It serves no backup file and no
// path: a backup holds sessions and tokens and is fetched from the server's volume, never over HTTP.
// The user check is passed in so tests need no session; the route file wires the real one.
import type { SessionUser } from "../auth/access-policy.ts";
import { BackupError } from "./errors.ts";
import type { BackupStatus } from "./status.ts";

const NO_STORE = { "cache-control": "no-store" };

export type BackupStatusDependencies = {
  /** The signed in user, or a throw that ends the request. Called first, on every request. */
  requireUser: () => Promise<SessionUser>;
  readStatus: () => BackupStatus;
};

export function createBackupStatusHandler({
  requireUser,
  readStatus,
}: BackupStatusDependencies): () => Promise<Response> {
  return async () => {
    await requireUser();
    try {
      return Response.json(readStatus(), { headers: NO_STORE });
    } catch (error) {
      // The only expected failure is an invalid setting; the code says which kind, nothing more.
      const code =
        error instanceof BackupError ? error.code : "BACKUP_STATUS_UNAVAILABLE";
      return Response.json({ error: code }, { status: 500, headers: NO_STORE });
    }
  };
}
