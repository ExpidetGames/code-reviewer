// SPDX-License-Identifier: Apache-2.0

// The plans of the admin portal with billing switched on and off (#438, epic #421), end to end over a real database, the
// real proxy and the real data routes, with the fake Paddle behind the connection check: switching billing on seeds the Free
// plan and writes it to the default entitlements, the plans routes do not exist while billing is off, and switching it off
// gives the default back to the operator.
import { describe, expect, it } from "vitest";
import {
  createAdminHarness,
  type AdminHarness,
} from "../test-support/admin-harness.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";

const SETTINGS = {
  environment: "sandbox",
  clientToken: "test_0123456789abcdef0123456789a",
  graceDays: 7,
  apiKey: "pdl_sdbx_apikey_fake_key_for_tests",
  webhookSecret: "pdl_ntfset_0123456789abcdef_secret_abcd",
};

const NEW_PLAN = {
  planKey: "team",
  kind: "paid",
  name: "Team",
  description: "",
  sort: 20,
  offered: true,
  popular: false,
  contactTarget: null,
  terms: {
    keyMode: "managed",
    limits: {
      diffRunsPerPeriod: 40,
      dynamicRunsPerPeriod: 8,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
    },
    modelAccess: { catalogEntries: null },
    monthlyAmountMinor: 1234,
    yearlyAmountMinor: null,
  },
};

const billingPut = (portal: AdminHarness, body: unknown) =>
  portal.visit("/api/admin/billing", {
    method: "PUT",
    body,
    cookies: portal.adminCookies,
  });

const plansCall = (
  portal: AdminHarness,
  method: string,
  body?: unknown,
  path = "/api/admin/billing/plans",
) =>
  portal.visit(path, {
    method,
    ...(body === undefined ? {} : { body }),
    cookies: portal.adminCookies,
  });

async function switchOn(portal: AdminHarness) {
  expect((await billingPut(portal, { settings: SETTINGS })).status).toBe(200);
  return billingPut(portal, { enabled: true });
}

async function rowCount(portal: AdminHarness, table: "billing_plans") {
  const row = await portal.db
    .selectFrom(table)
    .select((builder) => builder.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

describe("the plans while billing is off", () => {
  // #438-T10
  it("do not exist: the routes answer the missing path and nothing is written", async () => {
    const portal = await createAdminHarness();

    const list = await plansCall(portal, "GET");
    const create = await plansCall(portal, "POST", NEW_PLAN);
    const change = await plansCall(
      portal,
      "PUT",
      { archived: true },
      "/api/admin/billing/plans/team",
    );
    const remove = await plansCall(
      portal,
      "DELETE",
      undefined,
      "/api/admin/billing/plans/team",
    );

    for (const response of [list, create, change, remove])
      expect(response.status).toBe(404);
    expect(await rowCount(portal, "billing_plans")).toBe(0);
    expect(
      await createInstanceSettingsRepository(
        portal.db,
      ).getDefaultEntitlements(),
    ).toBeUndefined();
  });

  // #438-T10
  it("leave the default entitlements to the operator when billing is configured but not switched on", async () => {
    const portal = await createAdminHarness();
    const settings = createInstanceSettingsRepository(portal.db);

    expect((await billingPut(portal, { settings: SETTINGS })).status).toBe(200);

    expect(await settings.getDefaultEntitlements()).toBeUndefined();
    expect((await plansCall(portal, "GET")).status).toBe(404);
    expect(await rowCount(portal, "billing_plans")).toBe(0);
  });

  // #438-T11
  it("are not reached by somebody who is not signed in", async () => {
    const portal = await createAdminHarness();

    const response = await portal.visit("/api/admin/billing/plans");

    expect(response.status).toBeGreaterThanOrEqual(401);
    expect([401, 404]).toContain(response.status);
  });
});

describe("switching billing on", () => {
  // #438-T04
  it("seeds the Free plan and writes it to the default entitlements", async () => {
    const portal = await createAdminHarness();

    expect((await switchOn(portal)).status).toBe(200);

    const list = await plansCall(portal, "GET");
    expect(list.status).toBe(200);
    const view = (await list.json()) as {
      plans: Array<{
        planKey: string;
        kind: string;
        versions: Array<{
          keyMode: string;
          limits: { diffRunsPerPeriod: number; dynamicRunsPerPeriod: number };
        }>;
      }>;
    };
    expect(view.plans).toHaveLength(1);
    expect(view.plans[0]).toMatchObject({ planKey: "free", kind: "free" });
    expect(view.plans[0]?.versions[0]).toMatchObject({
      keyMode: "managed",
      limits: { diffRunsPerPeriod: 10, dynamicRunsPerPeriod: 2 },
    });
    expect(
      await createInstanceSettingsRepository(
        portal.db,
      ).getDefaultEntitlements(),
    ).toMatchObject({
      planLabel: "Free",
      keyMode: "managed",
      limits: { diffRunsPerPeriod: 10, dynamicRunsPerPeriod: 2 },
      modelAccess: { catalogEntries: [] },
      source: "billing",
    });
  });

  // #438-T01
  it("lets the admin create a plan through the route", async () => {
    const portal = await createAdminHarness();
    await switchOn(portal);

    const response = await plansCall(portal, "POST", NEW_PLAN);

    expect(response.status).toBe(200);
    expect(await rowCount(portal, "billing_plans")).toBe(2);
  });

  // #438-T04
  it("does not switch on when the Free plan cannot be written, and says so", async () => {
    const portal = await createAdminHarness();
    // A plan that already uses the key of the Free plan, as a database in a state nobody meant would have.
    await portal.db
      .insertInto("billing_plans")
      .values({
        id: "stray",
        plan_key: "free",
        name: "Stray",
        description: "",
        sort: 0,
        kind: "paid",
        offered: 0,
        popular: 0,
        contact_target: null,
        archived_at: null,
        created_at: "2026-10-18T10:00:00.000Z",
        updated_at: "2026-10-18T10:00:00.000Z",
        updated_by: null,
      })
      .execute();
    expect((await billingPut(portal, { settings: SETTINGS })).status).toBe(200);

    const response = await billingPut(portal, { enabled: true });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(await portal.isBillingOn()).toBe(false);
    expect(
      await createInstanceSettingsRepository(
        portal.db,
      ).getDefaultEntitlements(),
    ).toBeUndefined();
  });
});

describe("switching billing off again", () => {
  // #438-T10
  it("gives the default entitlements back to the operator and makes the routes missing, and keeps the plans", async () => {
    const portal = await createAdminHarness();
    await switchOn(portal);
    await plansCall(portal, "POST", NEW_PLAN);

    expect((await billingPut(portal, { enabled: false })).status).toBe(200);

    expect(
      await createInstanceSettingsRepository(
        portal.db,
      ).getDefaultEntitlements(),
    ).toBeUndefined();
    expect((await plansCall(portal, "GET")).status).toBe(404);
    expect(await rowCount(portal, "billing_plans")).toBe(2);
  });

  // #438-T04
  it("finds the plans and writes the Free default again when billing is switched on once more", async () => {
    const portal = await createAdminHarness();
    await switchOn(portal);
    await plansCall(portal, "POST", NEW_PLAN);
    await billingPut(portal, { enabled: false });

    expect((await billingPut(portal, { enabled: true })).status).toBe(200);

    expect(await rowCount(portal, "billing_plans")).toBe(2);
    expect(
      await createInstanceSettingsRepository(
        portal.db,
      ).getDefaultEntitlements(),
    ).toMatchObject({ planLabel: "Free", source: "billing" });
  });
});
