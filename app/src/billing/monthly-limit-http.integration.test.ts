// SPDX-License-Identifier: LicenseRef-Proprietary

// #499: `GET` and `PUT /api/w/:workspace/billing/monthly-limit` as the app wires them (guard, access, body, service), over a real
// database and the real matrix of roles. An Owner and an Admin set the workspace's monthly total limit (`manage_billing`); a
// Member gets 403 and nothing is stored; every change leaves an audit line.
import { describe, expect, it, vi } from "vitest";
import { createBillingWorkspaceSettingsRepository } from "../db/repositories/billing-workspace-settings-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { insertUser } from "../test-support/users.ts";
import { signedInMember } from "../test-support/session-lookup.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { resolveWorkspaceAccess } from "../workspaces/access.ts";
import { accessRefusal } from "../workspaces/access-response.ts";
import type { WorkspaceRole } from "../db/workspace-roles.ts";
import { isBillingOn } from "./enabled.ts";
import { createMonthlyLimitRoute } from "./monthly-limit-http.ts";
import { createMonthlyLimitService } from "./monthly-limit-service.ts";

const BASE_URL = "https://app.example.test";

class NotFound extends Error {}

async function start(options: { billingOn?: boolean } = {}) {
  const { db } = await createTestDatabase();
  const workspaceId = await addWorkspace(db, "acme");
  const otherWorkspaceId = await addWorkspace(db, "other");
  await setBillingSwitch(db, options.billingOn ?? true);
  const logs: string[] = [];
  const isOn = vi.fn(() => isBillingOn(db));
  const route = createMonthlyLimitRoute({
    guard: {
      isOn,
      notFound: () => {
        throw new NotFound("not found");
      },
    },
    service: createMonthlyLimitService({ db, log: (line) => logs.push(line) }),
  });
  const workspaces = createWorkspacesRepository(db);
  const as =
    (
      lookup: Awaited<ReturnType<typeof signedInMember>> | { kind: "none" },
      slug = "acme",
    ) =>
    (handler: Parameters<Parameters<typeof route.put>[2]>[0]) =>
      resolveWorkspaceAccess({
        lookup,
        slug,
        action: "manage_billing",
        findMembership: (userId, name) =>
          workspaces.findMembership(userId, name),
      }).then((result) =>
        result.kind === "ok" ? handler(result.access) : accessRefusal(result),
      );
  const person = async (
    role: WorkspaceRole,
    id = `u-${role}`,
    workspace = workspaceId,
  ) => signedInMember(db, { id, workspaceId: workspace, role });
  const put = (body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${BASE_URL}/api/w/acme/billing/monthly-limit`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const get = () =>
    new Request(`${BASE_URL}/api/w/acme/billing/monthly-limit`, {
      method: "GET",
    });
  const stored = (workspace = workspaceId) =>
    createBillingWorkspaceSettingsRepository(db, workspace).get();
  return {
    db,
    workspaceId,
    otherWorkspaceId,
    route,
    as,
    person,
    put,
    get,
    stored,
    isOn,
    logs,
  };
}

describe("PUT /api/w/:workspace/billing/monthly-limit", () => {
  // #499-T04
  it("lets an Owner set the limit, stores it in micro-USD with who set it, and leaves an audit line", async () => {
    const t = await start();

    const response = await t.route.put(
      t.put({ monthlyLimitCents: 25_000 }),
      "acme",
      t.as(await t.person("owner")),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ monthlyLimitCents: 25_000 });
    expect(await t.stored()).toMatchObject({
      monthlyLimitMicroUsd: 250_000_000,
      updatedBy: "u-owner",
    });
    expect(t.logs).toEqual([
      `[billing] MONTHLY_LIMIT_CHANGED workspace=${t.workspaceId} user=u-owner action=set limit_cents=25000`,
    ]);
  });

  // #499-T04
  it("lets an Admin set the limit", async () => {
    const t = await start();

    const response = await t.route.put(
      t.put({ monthlyLimitCents: 5_000 }),
      "acme",
      t.as(await t.person("admin")),
    );

    expect(response.status).toBe(200);
    expect(await t.stored()).toMatchObject({
      monthlyLimitMicroUsd: 50_000_000,
      updatedBy: "u-admin",
    });
  });

  // #499-T04
  it("answers a Member 403, stores nothing and leaves no audit line", async () => {
    const t = await start();

    const response = await t.route.put(
      t.put({ monthlyLimitCents: 5_000 }),
      "acme",
      t.as(await t.person("member")),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(await t.stored()).toBeUndefined();
    expect(t.logs).toEqual([]);
  });

  // #499-T04
  it("answers a Member who changes an existing limit 403 and leaves it as it was", async () => {
    const t = await start();
    await t.route.put(
      t.put({ monthlyLimitCents: 5_000 }),
      "acme",
      t.as(await t.person("owner")),
    );

    await t.route.put(
      t.put({ monthlyLimitCents: null }),
      "acme",
      t.as(await t.person("member")),
    );

    expect(await t.stored()).toMatchObject({
      monthlyLimitMicroUsd: 50_000_000,
    });
  });

  // #499-T04
  it("answers a person of another workspace, and nobody signed in, with the refusals of every workspace route", async () => {
    const t = await start();
    const outsider = await t.person("owner", "u-outsider", t.otherWorkspaceId);

    const outside = await t.route.put(
      t.put({ monthlyLimitCents: 5_000 }),
      "acme",
      t.as(outsider),
    );
    const anonymous = await t.route.put(
      t.put({ monthlyLimitCents: 5_000 }),
      "acme",
      t.as({ kind: "none" }),
    );

    expect(outside.status).toBe(404);
    expect(anonymous.status).toBe(401);
    expect(await t.stored()).toBeUndefined();
    expect(await t.stored(t.otherWorkspaceId)).toBeUndefined();
  });

  // #499-T04
  it("takes the workspace from the address, never from the body", async () => {
    const t = await start();

    await t.route.put(
      t.put({
        monthlyLimitCents: 5_000,
        workspaceId: t.otherWorkspaceId,
        workspace: "other",
      }),
      "acme",
      t.as(await t.person("owner")),
    );

    expect(await t.stored()).toBeDefined();
    expect(await t.stored(t.otherWorkspaceId)).toBeUndefined();
  });

  // #499-T03
  it("clears the limit with null and records it as cleared", async () => {
    const t = await start();
    const owner = await t.person("owner");
    await t.route.put(t.put({ monthlyLimitCents: 5_000 }), "acme", t.as(owner));

    const response = await t.route.put(
      t.put({ monthlyLimitCents: null }),
      "acme",
      t.as(owner),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ monthlyLimitCents: null });
    expect(await t.stored()).toMatchObject({ monthlyLimitMicroUsd: null });
    expect(t.logs.at(-1)).toBe(
      `[billing] MONTHLY_LIMIT_CHANGED workspace=${t.workspaceId} user=u-owner action=cleared`,
    );
  });

  // #499-T04
  it("refuses a limit that is not a whole number of cents in range, with a stable code, and stores nothing", async () => {
    const t = await start();
    const owner = await t.person("owner");
    const attempt = async (body: unknown) => {
      const response = await t.route.put(t.put(body), "acme", t.as(owner));
      return [response.status, await response.json()];
    };

    expect(await attempt({})).toEqual([422, { error: "limit_invalid" }]);
    expect(await attempt({ monthlyLimitCents: "50" })).toEqual([
      422,
      { error: "limit_invalid" },
    ]);
    expect(await attempt({ monthlyLimitCents: 10.5 })).toEqual([
      422,
      { error: "limit_invalid" },
    ]);
    expect(await attempt({ monthlyLimitCents: 99 })).toEqual([
      422,
      { error: "limit_out_of_range" },
    ]);
    expect(await attempt({ monthlyLimitCents: 0 })).toEqual([
      422,
      { error: "limit_out_of_range" },
    ]);
    expect(await attempt({ monthlyLimitCents: -100 })).toEqual([
      422,
      { error: "limit_out_of_range" },
    ]);
    expect(await attempt({ monthlyLimitCents: 100_000_001 })).toEqual([
      422,
      { error: "limit_out_of_range" },
    ]);
    expect(
      await attempt({ monthlyLimitCents: Number.MAX_SAFE_INTEGER }),
    ).toEqual([422, { error: "limit_out_of_range" }]);
    expect(await t.stored()).toBeUndefined();
    expect(t.logs).toEqual([]);
  });

  // #499-T04
  it("accepts the smallest and the largest limit", async () => {
    const t = await start();
    const owner = await t.person("owner");

    expect(
      (
        await t.route.put(
          t.put({ monthlyLimitCents: 100 }),
          "acme",
          t.as(owner),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await t.route.put(
          t.put({ monthlyLimitCents: 100_000_000 }),
          "acme",
          t.as(owner),
        )
      ).status,
    ).toBe(200);
    expect(await t.stored()).toMatchObject({
      monthlyLimitMicroUsd: 1_000_000_000_000,
    });
  });

  // #499-T04
  it("refuses a request from another site, a body that is not JSON and one that is too large", async () => {
    const t = await start();
    const owner = await t.person("owner");

    const crossSite = await t.route.put(
      t.put({ monthlyLimitCents: 5_000 }, { "sec-fetch-site": "cross-site" }),
      "acme",
      t.as(owner),
    );
    const notJson = await t.route.put(
      new Request(`${BASE_URL}/api/w/acme/billing/monthly-limit`, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
      "acme",
      t.as(owner),
    );
    const tooLarge = await t.route.put(
      t.put({ monthlyLimitCents: 5_000, padding: "x".repeat(10_000) }),
      "acme",
      t.as(owner),
    );

    expect(crossSite.status).toBe(403);
    expect(notJson.status).toBe(415);
    expect(tooLarge.status).toBe(413);
    expect(await t.stored()).toBeUndefined();
  });

  // #499-T03
  it("is the missing path while billing is off, before anything else is asked", async () => {
    const t = await start({ billingOn: false });
    const withAccess = vi.fn(t.as(await t.person("owner")));

    await expect(
      t.route.put(t.put({ monthlyLimitCents: 5_000 }), "acme", withAccess),
    ).rejects.toBeInstanceOf(NotFound);
    await expect(
      t.route.get(t.get(), "acme", withAccess),
    ).rejects.toBeInstanceOf(NotFound);

    expect(withAccess).not.toHaveBeenCalled();
    expect(await t.stored()).toBeUndefined();
  });
});

describe("GET /api/w/:workspace/billing/monthly-limit", () => {
  // #499-T04
  it("tells an Owner the limit, or that there is none", async () => {
    const t = await start();
    const owner = await t.person("owner");
    const before = await t.route.get(t.get(), "acme", t.as(owner));
    await t.route.put(
      t.put({ monthlyLimitCents: 12_345 }),
      "acme",
      t.as(owner),
    );

    const after = await t.route.get(t.get(), "acme", t.as(owner));

    expect(await before.json()).toEqual({ monthlyLimitCents: null });
    expect(after.headers.get("cache-control")).toBe("no-store");
    expect(await after.json()).toEqual({ monthlyLimitCents: 12_345 });
  });

  // #499-T04
  it("answers a Member 403 and says nothing of the limit", async () => {
    const t = await start();
    await t.route.put(
      t.put({ monthlyLimitCents: 12_345 }),
      "acme",
      t.as(await t.person("owner")),
    );

    const response = await t.route.get(
      t.get(),
      "acme",
      t.as(await t.person("member")),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  // #499-T12
  it("never tells the limit of another workspace", async () => {
    const t = await start();
    await createBillingWorkspaceSettingsRepository(
      t.db,
      t.otherWorkspaceId,
    ).setMonthlyLimit(7_000_000, null);

    const response = await t.route.get(
      t.get(),
      "acme",
      t.as(await t.person("owner")),
    );

    expect(await response.json()).toEqual({ monthlyLimitCents: null });
  });
});

describe("the monthly limit service on its own", () => {
  // #499-T04
  it("refuses a Member itself, whoever called it, and stores and logs nothing", async () => {
    const t = await start();
    const logs: string[] = [];
    const service = createMonthlyLimitService({
      db: t.db,
      log: (line) => logs.push(line),
    });
    const member = {
      workspaceId: t.workspaceId,
      userId: "u-member",
      role: "member",
    } as const;

    expect(await service.set(member, { monthlyLimitCents: 5_000 })).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await service.get(member)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await t.stored()).toBeUndefined();
    expect(logs).toEqual([]);
  });

  // #499-T04
  it("accepts an Admin and an Owner", async () => {
    const t = await start();
    const service = createMonthlyLimitService({ db: t.db, log: () => {} });

    for (const role of ["admin", "owner"] as const) {
      await insertUser(t.db, { id: `u-${role}` });
      expect(
        await service.set(
          { workspaceId: t.workspaceId, userId: `u-${role}`, role },
          { monthlyLimitCents: 5_000 },
        ),
      ).toEqual({ ok: true, monthlyLimitCents: 5_000 });
    }
  });

  // #499-T04
  it("reads a body that is no object as a missing limit", async () => {
    const t = await start();
    const service = createMonthlyLimitService({ db: t.db, log: () => {} });
    const owner = {
      workspaceId: t.workspaceId,
      userId: "u-owner",
      role: "owner",
    } as const;

    for (const body of [undefined, null, "5000", 5000, [5000]])
      expect(await service.set(owner, body)).toEqual({
        ok: false,
        error: "limit_invalid",
      });
    expect(await t.stored()).toBeUndefined();
  });
});
