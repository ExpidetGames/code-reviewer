// SPDX-License-Identifier: Apache-2.0

// Access to the handoff tokens of ONE workspace (the table `plan_handoff_tokens`; the factory takes the workspace id,
// see ../workspace-scope.ts): the single-use tokens with which an Owner or Admin is handed over to the
// operator-configured plan page (src/plan-handoff/README.md). Only the hash of a token is kept. Making a token
// revokes the unused ones of the same person in the same workspace, in one transaction. The redemption is by the hash
// alone and belongs to no workspace (plan-handoff-redeem-repository.ts, instance level).
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import { databaseDriver } from "../driver.ts";
import type { Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

/** The roles a token can be made for: the ones that may manage the plan. */
export type HandoffRole = "owner" | "admin";

export type PlanHandoffTokensRepository = {
  /**
   * Stores a new token for the person with the role they have now, valid for `ttlMs` from now, and revokes their unused
   * ones in this workspace. One transaction.
   */
  issue(input: {
    tokenHash: string;
    userId: string;
    role: HandoffRole;
    ttlMs: number;
  }): Promise<void>;
};

export function createPlanHandoffTokensRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): PlanHandoffTokensRepository {
  const driver = databaseDriver(db);
  return {
    async issue({ tokenHash, userId, role, ttlMs }) {
      const run = async (executor: Kysely<Database>) => {
        // Two clicks of one person at once would both revoke nothing and both insert (READ COMMITTED), leaving two
        // live tokens. The row of the person's membership is the lock they queue on: the second revokes the first's.
        // On SQLite every transaction already holds the single write lock (`begin immediate`, ../dialect.ts), and
        // `for update` does not exist there.
        const member = executor
          .selectFrom("workspace_members")
          .select("user_id")
          .where("workspace_id", "=", workspaceId)
          .where("user_id", "=", userId);
        await (driver === "postgres" ? member.forUpdate() : member).execute();
        const current = now();
        const timestamp = formatTimestamp(current);
        await executor
          .updateTable("plan_handoff_tokens")
          .set({ revoked_at: timestamp })
          .where("workspace_id", "=", workspaceId)
          .where("user_id", "=", userId)
          .where("used_at", "is", null)
          .where("revoked_at", "is", null)
          .execute();
        await executor
          .insertInto("plan_handoff_tokens")
          .values({
            token_hash: tokenHash,
            workspace_id: workspaceId,
            user_id: userId,
            role,
            created_at: timestamp,
            expires_at: formatTimestamp(new Date(current.getTime() + ttlMs)),
            used_at: null,
            revoked_at: null,
          })
          .execute();
      };
      if (db.isTransaction) await run(db);
      else await db.transaction().execute(run);
    },
  };
}
