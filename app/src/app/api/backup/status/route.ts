// GET /api/backup/status: whether backups are scheduled and how the last one went.
// Protected: the proxy asks for a session, and `requireUser()` is the second guard. The logic is in
// src/backup/http.ts. There is deliberately no route that serves a backup file.
import { connection } from "next/server";
import { requireUser } from "@/auth/session";
import { loadBackupConfig } from "@/backup/config";
import { createBackupStatusHandler } from "@/backup/http";
import { getLastBackupRun } from "@/backup/run-state";
import { readBackupStatus } from "@/backup/status";

export async function GET(): Promise<Response> {
  // Reads the request, the environment and the disk, so it never runs at build time.
  await connection();
  return createBackupStatusHandler({
    requireUser: () => requireUser(),
    readStatus: () =>
      readBackupStatus({
        config: loadBackupConfig(process.env),
        lastRun: getLastBackupRun(),
        now: new Date(),
      }),
  })();
}
