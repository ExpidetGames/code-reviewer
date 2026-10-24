// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/backup/status: whether backups are scheduled and how the last one went. This is about the
// instance, not about a workspace, so it is for the people who run the instance: the instance admin. A
// member of a workspace gets the answer of a path that does not exist, and so does a person without a
// workspace; nobody else learns when or where the operator backs up. Protected: the proxy asks for a
// session, and the check below is the second guard. The logic is in src/backup/http.ts. There is
// deliberately no route that serves a backup file.
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { adminAccessOf } from "@/admin/access";
import { currentLookup } from "@/auth/session";
import { loginPath } from "@/auth/session-user";
import { loadBackupConfig } from "@/backup/config";
import { createBackupStatusHandler } from "@/backup/http";
import { getLastBackupRun } from "@/backup/run-state";
import { readBackupStatus } from "@/backup/status";

export async function GET(): Promise<Response> {
  // Reads the request, the environment and the disk, so it never runs at build time.
  await connection();
  return createBackupStatusHandler({
    requireUser: async () => {
      const lookup = await currentLookup();
      const access = adminAccessOf(lookup);
      // The proxy has answered a request without a session already; like `requireUser()`, a request that
      // gets here anyway is sent to the login page.
      if (access.kind === "anonymous") redirect(loginPath(lookup));
      if (access.kind === "not_admin") notFound();
      return access.user;
    },
    readStatus: () =>
      readBackupStatus({
        config: loadBackupConfig(process.env),
        lastRun: getLastBackupRun(),
        now: new Date(),
      }),
  })();
}
