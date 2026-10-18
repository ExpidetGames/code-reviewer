// SPDX-License-Identifier: Apache-2.0

// The plans of the admin portal (#438, epic #421) over a real database: plan versions pin what a subscriber bought,
// the Free plan drives the default entitlements, the display fields are edited in place, and every refusal has a
// stable code. All numbers are made up: no amount or limit of a real plan lives in the repository.
import { describe, expect, it } from "vitest";
import { createCatalogRepository } from "../db/repositories/catalog-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { insertUser } from "../test-support/users.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { createBillingPlansService } from "./plans-service.ts";

const T0 = new Date("2026-10-18T10:00:00.000Z");

const LIMITS = {
  diffRunsPerPeriod: 40,
  dynamicRunsPerPeriod: 8,
  managedCostLimitMicroUsd: null,
  ownKeyCostLimitMicroUsd: null,
};

function terms(overrides: Record<string, unknown> = {}) {
  return {
    keyMode: "managed",
    limits: LIMITS,
    modelAccess: { catalogEntries: ["mce_one"] },
    monthlyAmountMinor: 1234,
    yearlyAmountMinor: null,
    ...overrides,
  };
}

function ownTerms(overrides: Record<string, unknown> = {}) {
  return {
    keyMode: "own",
    limits: {
      ...LIMITS,
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
    },
    modelAccess: null,
    monthlyAmountMinor: 1000,
    yearlyAmountMinor: null,
    ...overrides,
  };
}

function paid(overrides: Record<string, unknown> = {}) {
  return {
    planKey: "team",
    kind: "paid",
    name: "Team",
    description: "For small teams.",
    sort: 20,
    offered: true,
    popular: false,
    contactTarget: null,
    terms: terms(),
    ...overrides,
  };
}

function enterprise(overrides: Record<string, unknown> = {}) {
  return {
    planKey: "enterprise",
    kind: "contact",
    name: "Enterprise",
    description: "Let's talk.",
    sort: 90,
    offered: true,
    popular: false,
    contactTarget: "https://example.test/contact",
    ...overrides,
  };
}

async function start() {
  const { db } = await createTestDatabase();
  let now = T0;
  const admin = await insertUser(db, { id: "admin-1", isInstanceAdmin: true });
  // The service runs while billing is on, and the writer of the default reads the switch (#438).
  await setBillingSwitch(db, true);
  const service = createBillingPlansService({ db, now: () => now });
  const settings = createInstanceSettingsRepository(db, () => now);
  return {
    db,
    admin,
    service,
    settings,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

type Started = Awaited<ReturnType<typeof start>>;

async function created(
  { service, admin }: Started,
  input: Record<string, unknown> = paid(),
) {
  const result = await service.createPlan(admin, input);
  if (!result.ok) throw new Error(`createPlan refused: ${result.code}`);
  return result;
}

async function planOf(started: Started, planKey: string) {
  const plan = (await started.service.view()).plans.find(
    (candidate) => candidate.planKey === planKey,
  );
  if (plan === undefined) throw new Error(`no plan ${planKey}`);
  return plan;
}

describe("creating a paid plan", () => {
  // #438-T01
  it("makes version 1 current with the limits, the key mode and the model access", async () => {
    const started = await start();

    const result = await created(started);

    expect(result.plan).toMatchObject({
      planKey: "team",
      kind: "paid",
      name: "Team",
      offered: true,
      archived: false,
    });
    expect(result.plan.versions).toEqual([
      {
        number: 1,
        role: "current",
        createdAt: T0.toISOString(),
        keyMode: "managed",
        limits: LIMITS,
        modelAccess: { catalogEntries: ["mce_one"] },
        monthlyAmountMinor: 1234,
        yearlyAmountMinor: null,
      },
    ]);
  });

  // #438-T14
  it("makes an own plan unlimited by default, with no model access", async () => {
    const started = await start();

    const result = await created(started, paid({ terms: ownTerms() }));

    expect(result.plan.versions[0]).toMatchObject({
      number: 1,
      role: "current",
      keyMode: "own",
      modelAccess: null,
      limits: {
        diffRunsPerPeriod: null,
        dynamicRunsPerPeriod: null,
        managedCostLimitMicroUsd: null,
      },
    });
  });

  // #438-T15
  it("stores an own plan's run limits and own key cost limit as configured", async () => {
    const started = await start();
    const limits = {
      diffRunsPerPeriod: 75,
      dynamicRunsPerPeriod: 11,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: 3_000_000,
    };

    const result = await created(
      started,
      paid({ terms: ownTerms({ limits }) }),
    );

    expect(result.plan.versions[0]?.limits).toEqual(limits);
  });

  // #438-T21
  it("stores a monthly and a yearly price as integer minor units", async () => {
    const started = await start();

    const result = await created(
      started,
      paid({
        terms: terms({ monthlyAmountMinor: 999, yearlyAmountMinor: 9900 }),
      }),
    );

    expect(result.plan.versions[0]).toMatchObject({
      monthlyAmountMinor: 999,
      yearlyAmountMinor: 9900,
    });
    expect(result.plan.versions[0]).not.toHaveProperty("yearlyDiscountPercent");
  });

  // #438-T22
  it("offers no yearly option without a yearly price", async () => {
    const started = await start();

    const result = await created(started);

    expect(result.plan.versions[0]?.yearlyAmountMinor).toBeNull();
    expect(result.plan.versions[0]?.monthlyAmountMinor).toBe(1234);
  });

  // #438-T01
  it("accepts a model access that names an entry which does not exist yet", async () => {
    const started = await start();

    const result = await started.service.createPlan(
      started.admin,
      paid({
        terms: terms({ modelAccess: { catalogEntries: ["mce_later"] } }),
      }),
    );

    expect(result.ok).toBe(true);
  });

  // #438-T07
  it("refuses what the rules refuse, with their code, and writes nothing", async () => {
    const started = await start();

    const result = await started.service.createPlan(
      started.admin,
      paid({ terms: terms({ monthlyAmountMinor: 0 }) }),
    );

    expect(result).toEqual({
      ok: false,
      code: "plan_price_invalid",
      field: "monthlyAmountMinor",
    });
    expect((await started.service.view()).plans).toEqual([]);
  });

  it("refuses a plan key that is taken", async () => {
    const started = await start();
    await created(started);

    expect(
      await started.service.createPlan(started.admin, paid()),
    ).toMatchObject({
      ok: false,
      code: "plan_key_taken",
    });
  });

  // #438-T17
  it("refuses an own plan of kind free or contact", async () => {
    const started = await start();

    for (const kind of ["free", "contact"])
      expect(
        await started.service.createPlan(
          started.admin,
          paid({
            planKey: `own-${kind}`,
            kind,
            contactTarget: kind === "contact" ? "mailto:a@b.test" : null,
            terms: ownTerms({ monthlyAmountMinor: null }),
          }),
        ),
      ).toMatchObject({ ok: false, code: "own_plan_requires_paid_plan" });
  });
});

describe("saving the terms of a plan", () => {
  // #438-T02
  it("makes version 2 current and leaves version 1 legacy and unchanged", async () => {
    const started = await start();
    const { plan } = await created(started);
    const first = plan.versions[0];
    started.advance(60_000);

    const result = await started.service.saveTerms(started.admin, "team", {
      basedOnVersion: 1,
      terms: terms({ limits: { ...LIMITS, diffRunsPerPeriod: 90 } }),
    });

    expect(result.ok).toBe(true);
    const saved = await planOf(started, "team");
    expect(saved.versions.map((v) => [v.number, v.role])).toEqual([
      [2, "current"],
      [1, "legacy"],
    ]);
    expect(saved.versions[0]?.limits.diffRunsPerPeriod).toBe(90);
    expect(saved.versions[1]).toEqual({ ...first, role: "legacy" });
  });

  // #438-T18
  it("makes the next version when the key mode changes", async () => {
    const started = await start();
    await created(started);

    const result = await started.service.saveTerms(started.admin, "team", {
      basedOnVersion: 1,
      terms: ownTerms(),
    });

    expect(result.ok).toBe(true);
    const saved = await planOf(started, "team");
    expect(saved.versions.map((v) => [v.number, v.role, v.keyMode])).toEqual([
      [2, "current", "own"],
      [1, "legacy", "managed"],
    ]);
    expect(saved.versions[0]?.modelAccess).toBeNull();
    expect(saved.versions[1]?.modelAccess).toEqual({
      catalogEntries: ["mce_one"],
    });
  });

  // #438-T23
  it("makes the next version when the monthly or the yearly price changes", async () => {
    const started = await start();
    await created(started);

    await started.service.saveTerms(started.admin, "team", {
      basedOnVersion: 1,
      terms: terms({ monthlyAmountMinor: 1500 }),
    });
    await started.service.saveTerms(started.admin, "team", {
      basedOnVersion: 2,
      terms: terms({ monthlyAmountMinor: 1500, yearlyAmountMinor: 15_000 }),
    });

    const saved = await planOf(started, "team");
    expect(
      saved.versions.map((v) => [
        v.number,
        v.role,
        v.monthlyAmountMinor,
        v.yearlyAmountMinor,
      ]),
    ).toEqual([
      [3, "current", 1500, 15_000],
      [2, "legacy", 1500, null],
      [1, "legacy", 1234, null],
    ]);
  });

  // #438-T02
  it("refuses terms that repeat the current version", async () => {
    const started = await start();
    await created(started);

    expect(
      await started.service.saveTerms(started.admin, "team", {
        basedOnVersion: 1,
        terms: terms({ modelAccess: { catalogEntries: ["mce_one"] } }),
      }),
    ).toMatchObject({ ok: false, code: "plan_version_unchanged" });
    expect((await planOf(started, "team")).versions).toHaveLength(1);
  });

  // #438-T02
  it("refuses a change based on a version that is no longer current", async () => {
    const started = await start();
    await created(started);
    await started.service.saveTerms(started.admin, "team", {
      basedOnVersion: 1,
      terms: terms({ monthlyAmountMinor: 1500 }),
    });

    expect(
      await started.service.saveTerms(started.admin, "team", {
        basedOnVersion: 1,
        terms: terms({ monthlyAmountMinor: 1600 }),
      }),
    ).toMatchObject({ ok: false, code: "plan_changed" });
    expect((await planOf(started, "team")).versions).toHaveLength(2);
  });

  // #438-T07
  it("refuses invalid terms and a body of the wrong shape", async () => {
    const started = await start();
    await created(started);

    expect(
      await started.service.saveTerms(started.admin, "team", {
        basedOnVersion: 1,
        terms: terms({ limits: { ...LIMITS, diffRunsPerPeriod: -3 } }),
      }),
    ).toEqual({ ok: false, code: "limit_invalid", field: "diffRunsPerPeriod" });
    for (const body of [
      null,
      {},
      { terms: terms() },
      { basedOnVersion: "1", terms: terms() },
      { basedOnVersion: 1, terms: terms(), extra: 1 },
    ])
      expect(
        await started.service.saveTerms(started.admin, "team", body),
      ).toMatchObject({ ok: false, code: "plan_input_invalid" });
  });

  it("refuses a plan that does not exist and an Enterprise plan", async () => {
    const started = await start();
    await created(started, enterprise());

    expect(
      await started.service.saveTerms(started.admin, "ghost", {
        basedOnVersion: 0,
        terms: terms(),
      }),
    ).toMatchObject({ ok: false, code: "plan_not_found" });
    expect(
      await started.service.saveTerms(started.admin, "enterprise", {
        basedOnVersion: 0,
        terms: terms({ monthlyAmountMinor: null }),
      }),
    ).toMatchObject({ ok: false, code: "contact_plan_has_no_versions" });
  });

  // #438-T17
  it("refuses to give a paid plan back to a key mode other than the two", async () => {
    const started = await start();
    await created(started);

    expect(
      await started.service.saveTerms(started.admin, "team", {
        basedOnVersion: 1,
        terms: terms({ keyMode: "shared" }),
      }),
    ).toMatchObject({ ok: false, code: "plan_key_mode_invalid" });
  });
});

describe("the fields edited in place", () => {
  // #438-T03
  it("changes name, description, sort and offered without a new version", async () => {
    const started = await start();
    await created(started);
    started.advance(5_000);

    const result = await started.service.updatePlan(started.admin, "team", {
      name: "Teams",
      description: "More.",
      sort: 5,
      offered: false,
    });

    expect(result.ok).toBe(true);
    const plan = await planOf(started, "team");
    expect(plan).toMatchObject({
      name: "Teams",
      description: "More.",
      sort: 5,
      offered: false,
    });
    expect(plan.versions).toHaveLength(1);
    expect(plan.versions[0]?.number).toBe(1);
  });

  // #438-T03
  it("changes the contact target of an Enterprise plan in place", async () => {
    const started = await start();
    await created(started, enterprise());

    const result = await started.service.updatePlan(
      started.admin,
      "enterprise",
      {
        contactTarget: "mailto:sales@example.test",
      },
    );

    expect(result.ok).toBe(true);
    expect(await planOf(started, "enterprise")).toMatchObject({
      contactTarget: "mailto:sales@example.test",
      versions: [],
    });
  });

  // #438-T07
  it("refuses a field it does not know and a plan it does not have", async () => {
    const started = await start();
    await created(started);

    expect(
      await started.service.updatePlan(started.admin, "team", {
        monthlyAmountMinor: 1,
      }),
    ).toMatchObject({ ok: false, code: "plan_input_invalid" });
    expect(
      await started.service.updatePlan(started.admin, "ghost", { sort: 1 }),
    ).toMatchObject({ ok: false, code: "plan_not_found" });
    expect(
      await started.service.updatePlan(started.admin, "team", null),
    ).toMatchObject({ ok: false, code: "plan_input_invalid" });
  });

  // #438-T26
  it("lists the plans ascending by sort, ties by plan key, across Free, paid and Enterprise", async () => {
    const started = await start();
    await started.service.enable(started.admin);
    await created(started, paid({ planKey: "pro", name: "Pro", sort: 20 }));
    await created(started, paid({ planKey: "alpha", name: "Alpha", sort: 20 }));
    await created(started, enterprise({ sort: 5 }));

    const order = async () =>
      (await started.service.view()).plans.map((plan) => plan.planKey);
    expect(await order()).toEqual(["free", "enterprise", "alpha", "pro"]);

    // Setting the display order edits in place: no new version.
    await started.service.updatePlan(started.admin, "free", { sort: 100 });
    await started.service.updatePlan(started.admin, "pro", { sort: 1 });
    expect(await order()).toEqual(["pro", "enterprise", "alpha", "free"]);
    expect((await planOf(started, "pro")).versions).toHaveLength(1);
    expect((await planOf(started, "free")).versions).toHaveLength(1);
  });

  // #438-T27
  it("moves Popular from plan A to plan B in one step", async () => {
    const started = await start();
    await created(
      started,
      paid({ planKey: "plan-a", name: "A", popular: true }),
    );
    await created(started, paid({ planKey: "plan-b", name: "B" }));

    const result = await started.service.updatePlan(started.admin, "plan-b", {
      popular: true,
    });

    expect(result).toMatchObject({ ok: true, clearedPopular: "plan-a" });
    const plans = (await started.service.view()).plans;
    expect(plans.filter((plan) => plan.popular).map((p) => p.planKey)).toEqual([
      "plan-b",
    ]);
  });

  // #438-T27
  it("takes Popular from the old plan when a new plan is created popular", async () => {
    const started = await start();
    await created(
      started,
      paid({ planKey: "plan-a", name: "A", popular: true }),
    );

    const result = await created(
      started,
      paid({ planKey: "plan-b", name: "B", popular: true }),
    );

    expect(result.clearedPopular).toBe("plan-a");
    expect(
      (await started.service.view()).plans.filter((plan) => plan.popular),
    ).toHaveLength(1);
    expect((await planOf(started, "plan-b")).popular).toBe(true);
  });

  it("does not report a plan as cleared when the flag stays where it is", async () => {
    const started = await start();
    await created(started, paid({ popular: true }));

    expect(
      await started.service.updatePlan(started.admin, "team", { sort: 3 }),
    ).toMatchObject({ ok: true, clearedPopular: null });
  });

  // #438-T29
  it("refuses Popular on the Free plan and on an Enterprise plan", async () => {
    const started = await start();
    await started.service.enable(started.admin);
    await created(started, enterprise());

    for (const planKey of ["free", "enterprise"])
      expect(
        await started.service.updatePlan(started.admin, planKey, {
          popular: true,
        }),
      ).toMatchObject({ ok: false, code: "popular_requires_paid_plan" });
  });

  // #438-T30
  it("saves an Enterprise plan with a link, then with a mailto address", async () => {
    const started = await start();

    const withLink = await created(started, enterprise());
    expect(withLink.plan.contactTarget).toBe("https://example.test/contact");
    await started.service.updatePlan(started.admin, "enterprise", {
      contactTarget: "mailto:sales@example.test",
    });

    expect((await planOf(started, "enterprise")).contactTarget).toBe(
      "mailto:sales@example.test",
    );
  });

  // #438-T30
  it("refuses to offer an Enterprise plan without a target", async () => {
    const started = await start();

    expect(
      await started.service.createPlan(
        started.admin,
        enterprise({ contactTarget: null }),
      ),
    ).toEqual({
      ok: false,
      code: "contact_target_required",
      field: "contactTarget",
    });
    await created(started, enterprise());
    expect(
      await started.service.updatePlan(started.admin, "enterprise", {
        contactTarget: null,
      }),
    ).toMatchObject({ ok: false, code: "contact_target_required" });
  });

  // #438-T07
  it("refuses a contact target that is not https or mailto", async () => {
    const started = await start();

    for (const contactTarget of [
      "http://example.test",
      "javascript:alert(1)",
      "example.test",
    ])
      expect(
        await started.service.createPlan(
          started.admin,
          enterprise({ contactTarget }),
        ),
      ).toMatchObject({ ok: false, code: "contact_target_invalid" });
  });
});

describe("an Enterprise plan", () => {
  // #438-T09
  it("has no versions and no price, and shows its contact target", async () => {
    const started = await start();

    const result = await created(started, enterprise());

    expect(result.plan).toMatchObject({
      kind: "contact",
      contactTarget: "https://example.test/contact",
      versions: [],
    });
  });
});

describe("archiving and deleting a plan", () => {
  it("hides an archived plan from new subscribers and lets it be restored", async () => {
    const started = await start();
    await created(started, paid({ popular: true }));

    const archived = await started.service.setArchived(
      started.admin,
      "team",
      true,
    );

    expect(archived).toMatchObject({
      ok: true,
      plan: { archived: true, offered: false, popular: false },
    });
    expect((await planOf(started, "team")).versions).toHaveLength(1);

    const restored = await started.service.setArchived(
      started.admin,
      "team",
      false,
    );
    expect(restored).toMatchObject({ ok: true, plan: { archived: false } });
  });

  it("refuses to offer, mark popular or give a new version to an archived plan", async () => {
    const started = await start();
    await created(started);
    await started.service.setArchived(started.admin, "team", true);

    expect(
      await started.service.updatePlan(started.admin, "team", {
        offered: true,
      }),
    ).toMatchObject({ ok: false, code: "plan_archived" });
    expect(
      await started.service.updatePlan(started.admin, "team", {
        popular: true,
      }),
    ).toMatchObject({ ok: false, code: "plan_archived" });
    expect(
      await started.service.saveTerms(started.admin, "team", {
        basedOnVersion: 1,
        terms: terms({ monthlyAmountMinor: 1 }),
      }),
    ).toMatchObject({ ok: false, code: "plan_archived" });
    // Renaming an archived plan is fine.
    expect(
      await started.service.updatePlan(started.admin, "team", { name: "Old" }),
    ).toMatchObject({ ok: true });
  });

  // #438-T08
  it("never deletes or archives the Free plan", async () => {
    const started = await start();
    await started.service.enable(started.admin);

    expect(await started.service.deletePlan("free")).toMatchObject({
      ok: false,
      code: "free_plan_not_deletable",
    });
    expect(
      await started.service.setArchived(started.admin, "free", true),
    ).toMatchObject({ ok: false, code: "free_plan_not_archivable" });
    expect((await planOf(started, "free")).archived).toBe(false);
  });

  it("deletes an Enterprise plan and keeps a plan that has versions", async () => {
    const started = await start();
    await created(started, enterprise());
    await created(started);

    expect(await started.service.deletePlan("enterprise")).toEqual({
      ok: true,
    });
    expect(await started.service.deletePlan("team")).toMatchObject({
      ok: false,
      code: "plan_has_versions",
    });
    expect(await started.service.deletePlan("ghost")).toMatchObject({
      ok: false,
      code: "plan_not_found",
    });
    expect((await started.service.view()).plans.map((p) => p.planKey)).toEqual([
      "team",
    ]);
  });
});

describe("the Free plan", () => {
  // #438-T04
  it("is seeded on the first enabling with 10 Diff and 2 Dynamic runs, managed, and becomes the default", async () => {
    const started = await start();

    await started.service.enable(started.admin);

    const free = await planOf(started, "free");
    expect(free).toMatchObject({
      kind: "free",
      name: "Free",
      offered: true,
      popular: false,
      archived: false,
    });
    expect(free.versions).toHaveLength(1);
    expect(free.versions[0]).toMatchObject({
      number: 1,
      role: "current",
      keyMode: "managed",
      limits: {
        diffRunsPerPeriod: 10,
        dynamicRunsPerPeriod: 2,
        managedCostLimitMicroUsd: null,
        ownKeyCostLimitMicroUsd: null,
      },
      modelAccess: { catalogEntries: [] },
      monthlyAmountMinor: null,
      yearlyAmountMinor: null,
    });
    expect(await started.settings.getDefaultEntitlements()).toEqual({
      planLabel: "Free",
      keyMode: "managed",
      limits: free.versions[0]?.limits,
      periodStart: "2026-10-01T00:00:00.000Z",
      suspended: false,
      suspensionCode: null,
      modelAccess: { catalogEntries: [] },
      source: "billing",
    });
  });

  // #438-T04
  it("is not seeded twice when billing is switched on again", async () => {
    const started = await start();
    await started.service.enable(started.admin);
    await started.service.saveTerms(started.admin, "free", {
      basedOnVersion: 1,
      terms: terms({
        limits: { ...LIMITS, diffRunsPerPeriod: 15 },
        modelAccess: { catalogEntries: [] },
        monthlyAmountMinor: null,
      }),
    });

    await started.service.enable(started.admin);

    const free = await planOf(started, "free");
    expect(free.versions.map((v) => v.number)).toEqual([2, 1]);
    expect(await started.settings.getDefaultEntitlements()).toMatchObject({
      limits: { diffRunsPerPeriod: 15 },
    });
  });

  // #438-T05
  it("writes a new Free version to the default entitlements", async () => {
    const started = await start();
    await started.service.enable(started.admin);

    const result = await started.service.saveTerms(started.admin, "free", {
      basedOnVersion: 1,
      terms: terms({
        limits: { ...LIMITS, diffRunsPerPeriod: 25, dynamicRunsPerPeriod: 4 },
        modelAccess: { catalogEntries: ["mce_small"] },
        monthlyAmountMinor: null,
      }),
    });

    expect(result.ok).toBe(true);
    expect(await started.settings.getDefaultEntitlements()).toMatchObject({
      keyMode: "managed",
      limits: { diffRunsPerPeriod: 25, dynamicRunsPerPeriod: 4 },
      modelAccess: { catalogEntries: ["mce_small"] },
      source: "billing",
    });
  });

  // #438-MA4
  it("replaces the model access of the default when the Free version changes it", async () => {
    const started = await start();
    await started.service.enable(started.admin);
    await started.service.saveTerms(started.admin, "free", {
      basedOnVersion: 1,
      terms: terms({
        modelAccess: { catalogEntries: ["mce_small"] },
        monthlyAmountMinor: null,
      }),
    });

    await started.service.saveTerms(started.admin, "free", {
      basedOnVersion: 2,
      terms: terms({
        modelAccess: { catalogEntries: [] },
        monthlyAmountMinor: null,
      }),
    });

    expect(await started.settings.getDefaultEntitlements()).toMatchObject({
      modelAccess: { catalogEntries: [] },
    });
  });

  // #438-T19
  it("writes the Free version as managed with source billing and leaves a manual workspace row alone", async () => {
    const started = await start();
    const workspaceId = await addWorkspace(started.db, "acme");
    const rows = createWorkspaceEntitlementsRepository(
      started.db,
      workspaceId,
      () => T0,
    );
    await rows.put(
      {
        planLabel: "Arranged by hand",
        keyMode: "own",
        limits: {
          diffRunsPerPeriod: null,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
        periodStart: "2026-10-01T00:00:00.000Z",
        suspended: false,
        suspensionCode: null,
      },
      null,
    );
    const before = await rows.get();

    await started.service.enable(started.admin);
    await started.service.saveTerms(started.admin, "free", {
      basedOnVersion: 1,
      terms: terms({
        limits: { ...LIMITS, diffRunsPerPeriod: 12 },
        modelAccess: { catalogEntries: [] },
        monthlyAmountMinor: null,
      }),
    });

    expect(await rows.get()).toEqual(before);
    expect(await started.settings.getDefaultEntitlements()).toMatchObject({
      keyMode: "managed",
      source: "billing",
    });
  });

  // #438-T17
  it("refuses to change the Free plan to the own key", async () => {
    const started = await start();
    await started.service.enable(started.admin);

    expect(
      await started.service.saveTerms(started.admin, "free", {
        basedOnVersion: 1,
        terms: ownTerms({ monthlyAmountMinor: null }),
      }),
    ).toEqual({
      ok: false,
      code: "free_plan_key_mode_fixed",
      field: "keyMode",
    });
    expect((await planOf(started, "free")).versions).toHaveLength(1);
  });

  // #438-T08
  it("refuses a price on the Free plan", async () => {
    const started = await start();
    await started.service.enable(started.admin);

    for (const field of ["monthlyAmountMinor", "yearlyAmountMinor"])
      expect(
        await started.service.saveTerms(started.admin, "free", {
          basedOnVersion: 1,
          terms: terms({
            modelAccess: { catalogEntries: [] },
            monthlyAmountMinor: null,
            [field]: 100,
          }),
        }),
      ).toEqual({ ok: false, code: "plan_price_not_allowed", field });
    expect((await planOf(started, "free")).versions).toHaveLength(1);
  });

  it("keeps the default's plan label in step with the name of the plan", async () => {
    const started = await start();
    await started.service.enable(started.admin);

    await started.service.updatePlan(started.admin, "free", {
      name: "Starter",
    });

    expect(await started.settings.getDefaultEntitlements()).toMatchObject({
      planLabel: "Starter",
      source: "billing",
    });
  });

  // #438-N2
  it("saves a Free version that arrives after billing was switched off without writing the default", async () => {
    const started = await start();
    await started.service.enable(started.admin);
    await started.service.release();
    await setBillingSwitch(started.db, false);

    const saved = await started.service.saveTerms(started.admin, "free", {
      basedOnVersion: 1,
      terms: terms({
        monthlyAmountMinor: null,
        modelAccess: { catalogEntries: [] },
        limits: { ...LIMITS, diffRunsPerPeriod: 11 },
      }),
    });

    expect(saved).toMatchObject({ ok: true });
    expect(await started.settings.getDefaultEntitlements()).toBeUndefined();
  });

  it("refuses a Free version when billing was never enabled", async () => {
    const started = await start();

    expect(
      await started.service.saveTerms(started.admin, "free", {
        basedOnVersion: 1,
        terms: terms(),
      }),
    ).toMatchObject({ ok: false, code: "plan_not_found" });
  });
});

describe("switching billing off again", () => {
  // #438-T10
  it("returns the default entitlements to the operator", async () => {
    const started = await start();
    await started.service.enable(started.admin);

    await started.service.release();

    expect(await started.settings.getDefaultEntitlements()).toBeUndefined();
    // The plans stay: switching on again finds them.
    expect((await planOf(started, "free")).versions).toHaveLength(1);
  });

  // #438-T10
  it("leaves a default the operator wrote after that alone", async () => {
    const started = await start();
    await started.service.enable(started.admin);
    await started.settings.set(
      "default_entitlements",
      {
        planLabel: "Operator",
        keyMode: "own",
        limits: { ...LIMITS, diffRunsPerPeriod: null },
        periodStart: "2026-10-05T00:00:00.000Z",
        suspended: false,
        suspensionCode: null,
      },
      null,
    );

    await started.service.release();

    expect(await started.settings.getDefaultEntitlements()).toMatchObject({
      planLabel: "Operator",
    });
  });
});

describe("the view for the plans page", () => {
  // #438-T20
  it("warns when workspaces hold an own key and no own plan is offered", async () => {
    const started = await start();
    await started.service.enable(started.admin);
    await storeOwnKey(started);

    const view = await started.service.view();

    expect(view.ownKeyWorkspaces).toBe(1);
    expect(view.warnings).toEqual(["own_key_workspaces_without_own_plan"]);
  });

  // #438-T20
  it("does not warn once an own plan is offered", async () => {
    const started = await start();
    await started.service.enable(started.admin);
    await storeOwnKey(started);
    await created(
      started,
      paid({ planKey: "own-key", name: "Own key", terms: ownTerms() }),
    );

    expect((await started.service.view()).warnings).toEqual([]);
  });

  // #438-T20
  it("warns again when the own plan is not offered, or archived", async () => {
    const started = await start();
    await storeOwnKey(started);
    await created(
      started,
      paid({
        planKey: "own-key",
        name: "Own key",
        terms: ownTerms(),
        offered: false,
      }),
    );
    expect((await started.service.view()).warnings).toHaveLength(1);

    await started.service.updatePlan(started.admin, "own-key", {
      offered: true,
    });
    expect((await started.service.view()).warnings).toEqual([]);
    await started.service.setArchived(started.admin, "own-key", true);
    expect((await started.service.view()).warnings).toHaveLength(1);
  });

  // #438-T20
  it("does not warn when no workspace holds an own key", async () => {
    const started = await start();
    await started.service.enable(started.admin);

    const view = await started.service.view();

    expect(view.ownKeyWorkspaces).toBe(0);
    expect(view.warnings).toEqual([]);
  });

  // #438-T01
  it("lists the catalog entries for the picker with name, provider and model", async () => {
    const started = await start();
    const entry = await createCatalogRepository(started.db).insert(
      {
        name: "Fast",
        nameKey: "fast",
        description: null,
        provider: "openrouter",
        modelId: "acme/quick-1",
        kinds: ["diff"],
        sortOrder: 0,
      },
      null,
    );

    const view = await started.service.view();

    expect(view.catalog).toEqual([
      {
        id: entry.id,
        name: "Fast",
        provider: "openrouter",
        modelId: "acme/quick-1",
        status: "draft",
      },
    ]);
  });
});

async function storeOwnKey({ db }: Started) {
  const workspaceId = await addWorkspace(db, "keyed");
  await db
    .insertInto("workspace_secrets")
    .values({
      workspace_id: workspaceId,
      name: "llm_api_key",
      binding: "openrouter",
      ciphertext: "x",
      nonce: "x",
      key_version: 1,
      last_four: null,
      updated_by: null,
      updated_at: T0.toISOString(),
    })
    .execute();
}
