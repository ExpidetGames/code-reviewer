// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the real route file `GET /api/w/:workspace/plan` (#282) with the wiring the running server uses: the
// database opened at start, the plan view and the workspace access. Only the session lookup and `connection()` are
// replaced (they need Next.js's request scope). Every member may read it; a workspace the person does not belong to
// answers like one that does not exist; the answer is never cached and holds no amount, model or job data.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import { createWorkspaceEntitlementsRepository } from "../../src/db/repositories/workspace-entitlements-repository.ts";
import {
  closeDatabase,
  getDatabase,
  initializeDatabaseOnStart,
} from "../../src/db/startup.ts";
import { GET } from "../../src/app/api/w/[workspace]/plan/route.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import { createUsageSeeder } from "../../src/test-support/usage-seed.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../src/test-support/workspaces.ts";
import type { EntitlementsData } from "../../src/workspaces/entitlements.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
// `connection()` only works inside a Next.js request; here it just returns.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

const ENTITLEMENTS: EntitlementsData = {
  planLabel: "Team",
  keyMode: "managed",
  limits: {
    diffRunsPerPeriod: 5,
    dynamicRunsPerPeriod: 2,
    managedCostLimitMicroUsd: 10_000_000,
    ownKeyCostLimitMicroUsd: null,
  },
  periodStart: "2026-10-01T00:00:00.000Z",
  suspended: false,
  suspensionCode: null,
};

async function startRoute(role: "member" | "admin" | "owner" = "member") {
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(await createTestDirectory(), "app.db") },
  });
  const db = getDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  session.currentLookup.mockResolvedValue(
    await signedInMember(db, { workspaceId, role }),
  );
  return { db, workspaceId };
}

const read = (workspace: string) =>
  GET(new Request(`https://app.test/api/w/${workspace}/plan`), {
    params: Promise.resolve({ workspace }),
  } as Parameters<typeof GET>[1]);

afterEach(async () => {
  await closeDatabase();
});

describe("the plan route file", () => {
  // #282-T01
  it("answers unlimited for a workspace without entitlements", async () => {
    await startRoute();

    const response = await read("default");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "unlimited" });
  });

  // #282-T02, #282-T04
  it("answers the counts and the percentage of the cost limit, to a Member, and never caches", async () => {
    const { db, workspaceId } = await startRoute("member");
    await createWorkspaceEntitlementsRepository(db, workspaceId).put(
      ENTITLEMENTS,
      null,
    );
    const seeder = createUsageSeeder(db);
    const at = "2026-10-05T10:00:00.000Z";
    for (const costMicroUsd of [3_000_000, 3_200_000])
      await seeder.seed({
        workspaceId,
        reservedAt: at,
        keyMode: "managed",
        costMicroUsd,
      });
    await seeder.seed({ workspaceId, reservedAt: at, state: "reserved" });

    const response = await read("default");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      kind: "limited",
      planLabel: "Team",
      managed: true,
      suspended: false,
      periodStart: "2026-10-01T00:00:00.000Z",
      runs: {
        diff: { used: 3, limit: 5 },
        dynamic: { used: 0, limit: 2 },
      },
      cost: { percentUsed: 62, unknownCostCount: 0 },
    });
  });

  // #282-T08
  it("holds no amount, model, tier, key or job data, whatever the run recorded", async () => {
    const { db, workspaceId } = await startRoute();
    await createWorkspaceEntitlementsRepository(db, workspaceId).put(
      { ...ENTITLEMENTS, suspended: true, suspensionCode: "overdue" },
      null,
    );
    await createUsageSeeder(db).seed({
      workspaceId,
      reservedAt: "2026-10-05T10:00:00.000Z",
      keyMode: "managed",
      modelTier: "tier-secret-name",
      costMicroUsd: 6_200_000,
      promptTokens: 123456,
      jobResult: {
        usage: { model: "vendor/secret-model", costUsd: 6.2 },
        logTail: "a-log-line",
      },
    });

    const text = await (await read("default")).text();

    for (const forbidden of [
      "tier-secret-name",
      "secret-model",
      "6200000",
      "6.2",
      "123456",
      "a-log-line",
      "overdue",
      "suspensionCode",
      "seeded-",
      workspaceId,
    ])
      expect(text, forbidden).not.toContain(forbidden);
  });

  // #282-T07
  it("answers a workspace the person does not belong to like one that does not exist", async () => {
    const { db } = await startRoute();
    await addWorkspace(db, "other");
    await createWorkspaceEntitlementsRepository(
      db,
      await defaultWorkspaceId(db),
    ).put(ENTITLEMENTS, null);
    session.currentLookup.mockResolvedValue(
      await signedInMember(db, { id: "outsider" }),
    );

    for (const workspace of ["default", "other", "no-such-workspace"]) {
      const response = await read(workspace);
      expect(response.status, workspace).toBe(404);
      expect(await response.json(), workspace).toEqual({ error: "not_found" });
    }
  });

  it("asks for the session first and answers a visitor with 401", async () => {
    await startRoute();
    session.currentLookup.mockResolvedValue({ kind: "none" });

    const response = await read("default");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
  });

  it("exports only the GET method", async () => {
    const route = await import("../../src/app/api/w/[workspace]/plan/route.ts");

    expect(Object.keys(route)).toEqual(["GET"]);
  });
});
