// SPDX-License-Identifier: LicenseRef-Proprietary

// The handoff tokens (#284): making one (scoped to a workspace) and redeeming one (by its hash alone). The behavior
// of the whole hand-over is in src/plan-handoff/; what is pinned here is what the statements guarantee.
import { describe, expect, it } from "vitest";
import { signedInMember } from "../../test-support/session-lookup.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { addWorkspace } from "../../test-support/workspaces.ts";
import { createPlanHandoffRedeemRepository } from "./plan-handoff-redeem-repository.ts";
import { createPlanHandoffTokensRepository } from "./plan-handoff-tokens-repository.ts";
import { createWorkspaceMembersRepository } from "./workspace-members-repository.ts";

const START = new Date("2026-10-16T09:00:00.000Z");
const FIVE_MINUTES = 5 * 60 * 1000;

async function start() {
  const { db } = await createTestDatabase();
  let now = START;
  const alpha = await addWorkspace(db, "alpha");
  const beta = await addWorkspace(db, "beta");
  await signedInMember(db, { id: "owner", workspaceId: alpha, role: "owner" });
  await signedInMember(db, { id: "admin", workspaceId: alpha, role: "admin" });
  const clock = () => now;
  return {
    db,
    alpha,
    beta,
    tokens: (workspaceId: string) =>
      createPlanHandoffTokensRepository(db, workspaceId, clock),
    redeem: createPlanHandoffRedeemRepository(db, clock),
    members: (workspaceId: string) =>
      createWorkspaceMembersRepository(db, workspaceId, clock),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    expiry: () => new Date(now.getTime() + FIVE_MINUTES),
    stored: () => db.selectFrom("plan_handoff_tokens").selectAll().execute(),
  };
}

describe("making and redeeming a handoff token", () => {
  // #284-T03
  it("answers who the token was made for, once, and the answer holds no email or name", async () => {
    const t = await start();
    await t.tokens(t.alpha).issue({
      tokenHash: "h1",
      userId: "owner",
      role: "owner",
      ttlMs: FIVE_MINUTES,
    });

    const first = await t.redeem.redeem("h1");

    expect(first).toEqual({
      workspaceId: t.alpha,
      workspaceSlug: "alpha",
      userId: "owner",
      role: "owner",
    });
    expect(await t.redeem.redeem("h1")).toBeUndefined();
  });

  // #284-T04
  it("answers nothing for an unknown hash, a used token and an expired one", async () => {
    const t = await start();
    await t.tokens(t.alpha).issue({
      tokenHash: "h1",
      userId: "owner",
      role: "owner",
      ttlMs: FIVE_MINUTES,
    });
    await t.tokens(t.alpha).issue({
      tokenHash: "h2",
      userId: "admin",
      role: "admin",
      ttlMs: FIVE_MINUTES,
    });

    expect(await t.redeem.redeem("unknown")).toBeUndefined();
    await t.redeem.redeem("h1");
    expect(await t.redeem.redeem("h1")).toBeUndefined();
    t.advance(FIVE_MINUTES);
    expect(await t.redeem.redeem("h2")).toBeUndefined();
  });

  // #284-T04
  it("lets exactly one of two simultaneous redemptions through", async () => {
    const t = await start();
    await t.tokens(t.alpha).issue({
      tokenHash: "h1",
      userId: "owner",
      role: "owner",
      ttlMs: FIVE_MINUTES,
    });

    const answers = await Promise.all([
      t.redeem.redeem("h1"),
      t.redeem.redeem("h1"),
    ]);

    expect(answers.filter((answer) => answer !== undefined)).toHaveLength(1);
  });

  // #284-T05
  it("answers nothing, and uses the token up, when the person was demoted, removed or promoted since", async () => {
    const t = await start();
    const issue = (
      tokenHash: string,
      userId: string,
      role: "owner" | "admin",
    ) =>
      t.tokens(t.alpha).issue({ tokenHash, userId, role, ttlMs: FIVE_MINUTES });
    await issue("demoted", "owner", "owner");
    await issue("removed", "admin", "admin");
    await signedInMember(t.db, {
      id: "other",
      workspaceId: t.alpha,
      role: "admin",
    });
    await issue("promoted", "other", "admin");

    await t.members(t.alpha).setRole("owner", "member");
    await t.members(t.alpha).remove("admin");
    await t.members(t.alpha).setRole("other", "owner");

    expect(await t.redeem.redeem("demoted")).toBeUndefined();
    expect(await t.redeem.redeem("removed")).toBeUndefined();
    expect(await t.redeem.redeem("promoted")).toBeUndefined();
    // Restoring the role later does not bring the token back.
    await t.members(t.alpha).setRole("owner", "owner");
    expect(await t.redeem.redeem("demoted")).toBeUndefined();
  });

  // #284-T12
  it("revokes the unused tokens of the same person in the same workspace, and only those", async () => {
    const t = await start();
    const issue = (
      workspaceId: string,
      tokenHash: string,
      userId: string,
      role: "owner" | "admin" = "owner",
    ) =>
      t.tokens(workspaceId).issue({
        tokenHash,
        userId,
        role,
        ttlMs: FIVE_MINUTES,
      });
    await signedInMember(t.db, {
      id: "owner",
      workspaceId: t.beta,
      role: "owner",
    });
    await issue(t.alpha, "old", "owner");
    await issue(t.beta, "other-workspace", "owner");
    await issue(t.alpha, "other-person", "admin", "admin");

    await issue(t.alpha, "new", "owner");

    expect(await t.redeem.redeem("old")).toBeUndefined();
    expect(await t.redeem.redeem("new")).toMatchObject({ userId: "owner" });
    expect(await t.redeem.redeem("other-workspace")).toMatchObject({
      workspaceId: t.beta,
    });
    expect(await t.redeem.redeem("other-person")).toMatchObject({
      userId: "admin",
    });
  });

  // #284-T12
  it("does not revoke a token that was used already, so its record stays as it was", async () => {
    const t = await start();
    await t.tokens(t.alpha).issue({
      tokenHash: "used",
      userId: "owner",
      role: "owner",
      ttlMs: FIVE_MINUTES,
    });
    await t.redeem.redeem("used");

    await t.tokens(t.alpha).issue({
      tokenHash: "new",
      userId: "owner",
      role: "owner",
      ttlMs: FIVE_MINUTES,
    });

    const used = (await t.stored()).find((row) => row.token_hash === "used");
    expect(used?.revoked_at).toBeNull();
    expect(used?.used_at).not.toBeNull();
  });

  // #284-T02
  it("keeps the hash, the workspace, the person and the role, and nothing else about them", async () => {
    const t = await start();
    await t.tokens(t.alpha).issue({
      tokenHash: "h1",
      userId: "admin",
      role: "admin",
      ttlMs: FIVE_MINUTES,
    });

    expect(await t.stored()).toEqual([
      {
        token_hash: "h1",
        workspace_id: t.alpha,
        user_id: "admin",
        role: "admin",
        created_at: START.toISOString(),
        expires_at: t.expiry().toISOString(),
        used_at: null,
        revoked_at: null,
      },
    ]);
  });

  // #284-T04
  it("deletes the tokens that expired, and keeps the others", async () => {
    const t = await start();
    await t.tokens(t.alpha).issue({
      tokenHash: "h1",
      userId: "owner",
      role: "owner",
      ttlMs: FIVE_MINUTES,
    });
    t.advance(FIVE_MINUTES * 2);
    await t.tokens(t.alpha).issue({
      tokenHash: "h2",
      userId: "admin",
      role: "admin",
      ttlMs: FIVE_MINUTES,
    });

    expect(
      await t.redeem.deleteExpiredBefore(
        new Date(START.getTime() + FIVE_MINUTES * 2),
      ),
    ).toBe(1);
    expect((await t.stored()).map((row) => row.token_hash)).toEqual(["h2"]);
  });
});
