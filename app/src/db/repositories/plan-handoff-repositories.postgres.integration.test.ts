// SPDX-License-Identifier: LicenseRef-Proprietary

// The handoff tokens on Postgres behave like the SQLite ones (#284-T04, T05, T12): of several simultaneous
// redemptions exactly one answers, a token whose person lost the role is used up and answers nothing, making a token
// revokes the older unused ones of the same person, and the check of the table refuses a role that may not manage the
// plan. Runs only when TEST_DATABASE_URL is set.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { signedInMember } from "../../test-support/session-lookup.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { addWorkspace } from "../../test-support/workspaces.ts";
import { createPlanHandoffRedeemRepository } from "./plan-handoff-redeem-repository.ts";
import { createPlanHandoffTokensRepository } from "./plan-handoff-tokens-repository.ts";
import { createWorkspaceMembersRepository } from "./workspace-members-repository.ts";

const describePostgres = hasPostgres() ? describe : describe.skip;

const FIVE_MINUTES = 5 * 60 * 1000;

async function setup() {
  const { db } = await createPostgresTestDatabase({ poolMax: 12 });
  const workspaceId = await addWorkspace(db, "alpha");
  await signedInMember(db, { id: "owner", workspaceId, role: "owner" });
  await signedInMember(db, { id: "admin", workspaceId, role: "admin" });
  return {
    db,
    workspaceId,
    tokens: createPlanHandoffTokensRepository(db, workspaceId),
    redeem: createPlanHandoffRedeemRepository(db),
    members: createWorkspaceMembersRepository(db, workspaceId),
  };
}

describePostgres("the handoff tokens on Postgres", () => {
  // #284-T04
  it("answers exactly one of several simultaneous redemptions", async () => {
    const t = await setup();
    await t.tokens.issue({
      tokenHash: "h1",
      userId: "owner",
      role: "owner",
      ttlMs: FIVE_MINUTES,
    });

    const answers = await Promise.all(
      Array.from({ length: 10 }, () => t.redeem.redeem("h1")),
    );

    expect(answers.filter((answer) => answer !== undefined)).toHaveLength(1);
    expect(await t.redeem.redeem("h1")).toBeUndefined();
  });

  // #284-T05
  it("answers nothing, and uses the token up, when the person lost the role", async () => {
    const t = await setup();
    await t.tokens.issue({
      tokenHash: "demoted",
      userId: "owner",
      role: "owner",
      ttlMs: FIVE_MINUTES,
    });
    await t.members.setRole("owner", "member");

    expect(await t.redeem.redeem("demoted")).toBeUndefined();
    await t.members.setRole("owner", "owner");
    expect(await t.redeem.redeem("demoted")).toBeUndefined();
  });

  // #284-T12
  it("revokes the unused older tokens of the same person when a new one is made", async () => {
    const t = await setup();
    const issue = (
      tokenHash: string,
      userId: string,
      role: "owner" | "admin",
    ) => t.tokens.issue({ tokenHash, userId, role, ttlMs: FIVE_MINUTES });
    await issue("old", "owner", "owner");
    await issue("other", "admin", "admin");

    await issue("new", "owner", "owner");

    expect(await t.redeem.redeem("old")).toBeUndefined();
    expect(await t.redeem.redeem("new")).toMatchObject({ userId: "owner" });
    expect(await t.redeem.redeem("other")).toMatchObject({ userId: "admin" });
  });

  // #284-T12
  it("leaves exactly one live token when two clicks of one person make a token at the same time", async () => {
    for (let round = 0; round < 5; round += 1) {
      const t = await setup();

      await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          t.tokens.issue({
            tokenHash: `h${String(index)}`,
            userId: "owner",
            role: "owner",
            ttlMs: FIVE_MINUTES,
          }),
        ),
      );

      const live = await t.db
        .selectFrom("plan_handoff_tokens")
        .select("token_hash")
        .where("user_id", "=", "owner")
        .where("revoked_at", "is", null)
        .where("used_at", "is", null)
        .execute();
      expect(live).toHaveLength(1);
      const answers = await Promise.all(
        live.length === 1
          ? [0, 1, 2, 3, 4, 5].map((i) => t.redeem.redeem(`h${String(i)}`))
          : [],
      );
      expect(answers.filter((answer) => answer !== undefined)).toHaveLength(1);
    }
  });

  // #284-T06
  it("refuses a role that may not manage the plan", async () => {
    const t = await setup();

    await expect(
      sql`insert into plan_handoff_tokens (token_hash, workspace_id, user_id, role, created_at, expires_at)
          values ('h', ${t.workspaceId}, 'owner', 'member', '2026-10-16T09:00:00.000Z', '2026-10-16T09:05:00.000Z')`.execute(
        t.db,
      ),
    ).rejects.toThrow();
  });
});
