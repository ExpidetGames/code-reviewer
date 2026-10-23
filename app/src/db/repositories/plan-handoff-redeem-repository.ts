// SPDX-License-Identifier: Apache-2.0

// The redemption of a handoff token and the clean-up of the old ones, for the operator API (#284). Instance level on
// purpose: the external service holds only the token, so there is no workspace to scope to before the token is looked
// up, and the answer names its own workspace. It never lists tokens and a token is only ever found by its hash. The
// making of a token is the scoped plan-handoff-tokens-repository.ts.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";
import type { HandoffRole } from "./plan-handoff-tokens-repository.ts";
import { NOT_DELETED } from "./workspaces-repository.ts";

export type RedeemedHandoff = {
  workspaceId: string;
  workspaceSlug: string;
  userId: string;
  role: HandoffRole;
};

export type PlanHandoffRedeemRepository = {
  /**
   * Uses the token up and says who it was made for, or answers undefined. Undefined for every reason alike: no such
   * token, used, expired or revoked, or the person is no longer a member with the role the token was made for (an
   * Owner who was demoted, or removed, since). The token is used up by one guarded statement, so of two requests with
   * one token exactly one gets the answer, and a token whose person lost the role is used up too.
   */
  redeem(tokenHash: string): Promise<RedeemedHandoff | undefined>;
  /** Deletes the tokens that expired before `cutoff`. Returns how many. */
  deleteExpiredBefore(cutoff: Date): Promise<number>;
};

export function createPlanHandoffRedeemRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): PlanHandoffRedeemRepository {
  return {
    async redeem(tokenHash) {
      const timestamp = formatTimestamp(now());
      return db.transaction().execute(async (trx) => {
        const used = await trx
          .updateTable("plan_handoff_tokens")
          .set({ used_at: timestamp })
          .where("token_hash", "=", tokenHash)
          .where("used_at", "is", null)
          .where("revoked_at", "is", null)
          .where("expires_at", ">", timestamp)
          .returning(["workspace_id", "user_id", "role"])
          .executeTakeFirst();
        if (used === undefined) return undefined;
        // The role is checked again now, not only when the token was made.
        const member = await trx
          .selectFrom("workspace_members")
          .innerJoin(
            "workspaces",
            "workspaces.id",
            "workspace_members.workspace_id",
          )
          .select(["workspaces.slug as slug", "workspace_members.role as role"])
          .where("workspace_members.workspace_id", "=", used.workspace_id)
          .where("workspace_members.user_id", "=", used.user_id)
          .where(NOT_DELETED)
          .executeTakeFirst();
        if (member === undefined || member.role !== used.role) return undefined;
        if (used.role !== "owner" && used.role !== "admin") return undefined;
        return {
          workspaceId: used.workspace_id,
          workspaceSlug: member.slug,
          userId: used.user_id,
          role: used.role,
        };
      });
    },

    async deleteExpiredBefore(cutoff) {
      const result = await db
        .deleteFrom("plan_handoff_tokens")
        .where("expires_at", "<=", formatTimestamp(cutoff))
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
