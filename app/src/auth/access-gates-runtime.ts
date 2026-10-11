// SPDX-License-Identifier: Apache-2.0

// The access gates of the running server: whether the instance can send mail (looked up on every call,
// because the admin can add or remove the mail server at any time) and whether the user belongs to a
// workspace, both from the server's database.
import "server-only";
import { getDatabase } from "../db/startup.ts";
import { getMailSender } from "../mail/shared.ts";
import type { AccessGates } from "./access-gates.ts";

export function getAccessGates(): AccessGates {
  // The database is opened when a gate is asked, not when the gates are handed out.
  return {
    verificationRequired: () => getMailSender().isConfigured(),
    async hasWorkspace(userId) {
      const membership = await getDatabase()
        .selectFrom("workspace_members")
        .select("user_id")
        .where("user_id", "=", userId)
        .limit(1)
        .executeTakeFirst();
      return membership !== undefined;
    },
  };
}
