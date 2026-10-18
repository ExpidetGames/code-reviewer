// SPDX-License-Identifier: Apache-2.0

// #438: the default entitlements that billing writes from the Free plan carry the marker `source: billing`, so the claim
// can tell a billed default from an operator's one without reading a billing table (ADR 0005, 2.9). Only the billing
// writer sets it: a write of the operator (the API, the portal) stores no marker, and a marker in its input is refused.
import { describe, expect, it } from "vitest";
import { planEntitlements } from "../../billing/plan-entitlements.ts";
import { setBillingSwitch } from "../../test-support/billing-switch.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import type { EntitlementsData } from "../../workspaces/entitlements.ts";
import { EntitlementsError } from "../../workspaces/entitlements-validation.ts";
import { createInstanceSettingsRepository } from "./instance-settings-repository.ts";

const NOW = new Date("2026-10-18T10:00:00.000Z");

const LIMITS = {
  diffRunsPerPeriod: 7,
  dynamicRunsPerPeriod: 1,
  managedCostLimitMicroUsd: null,
  ownKeyCostLimitMicroUsd: null,
};

function free(periodStart = "2026-10-01T00:00:00.000Z") {
  return planEntitlements({
    name: "Free",
    terms: {
      keyMode: "managed",
      limits: LIMITS,
      modelAccess: { catalogEntries: [] },
      monthlyAmountMinor: null,
      yearlyAmountMinor: null,
    },
    periodStart,
  });
}

const OPERATOR_DEFAULT: EntitlementsData = {
  planLabel: "Operator",
  keyMode: "own",
  limits: { ...LIMITS, diffRunsPerPeriod: null },
  periodStart: "2026-10-02T00:00:00.000Z",
  suspended: false,
  suspensionCode: null,
};

async function start() {
  const { db } = await createTestDatabase();
  // The billing writer works while billing is on: it reads the switch in its own transaction (#438).
  await setBillingSwitch(db, true);
  return createInstanceSettingsRepository(db, () => NOW);
}

describe("the default entitlements and their source marker", () => {
  // #438-T19
  it("stores the Free version with key mode managed and source billing", async () => {
    const repository = await start();

    await repository.setBillingDefaultEntitlements(free(), null);

    expect(await repository.getDefaultEntitlements()).toEqual({
      ...free(),
      source: "billing",
    });
  });

  // #438-T19
  it("reads a default stored without the marker as the operator's own", async () => {
    const repository = await start();

    await repository.set("default_entitlements", OPERATOR_DEFAULT, null);

    const stored = await repository.getDefaultEntitlements();
    expect(stored).toMatchObject({ planLabel: "Operator" });
    expect(stored).not.toHaveProperty("source");
  });

  // #438-T06
  it("refuses the marker in a write of the operator", async () => {
    const repository = await start();

    await expect(
      repository.set(
        "default_entitlements",
        { ...OPERATOR_DEFAULT, source: "billing" },
        null,
      ),
    ).rejects.toMatchObject({
      code: "entitlements_invalid",
      field: "source",
    });
    expect(await repository.getDefaultEntitlements()).toBeUndefined();
  });

  // #438-T06
  it("drops the marker when the operator writes the default again", async () => {
    const repository = await start();
    await repository.setBillingDefaultEntitlements(free(), null);

    await repository.set("default_entitlements", OPERATOR_DEFAULT, null);

    expect(await repository.getDefaultEntitlements()).not.toHaveProperty(
      "source",
    );
  });

  // #438-T05
  it("replaces the default and its model access on every billing write", async () => {
    const repository = await start();
    await repository.setBillingDefaultEntitlements(
      {
        ...free(),
        modelAccess: { catalogEntries: ["mce_a"] },
      },
      null,
    );

    await repository.setBillingDefaultEntitlements(free(), null);

    expect(await repository.getDefaultEntitlements()).toMatchObject({
      modelAccess: { catalogEntries: [] },
    });
  });

  // #438-T05
  it("never moves the period start back when billing writes a new Free version", async () => {
    const repository = await start();
    await repository.setBillingDefaultEntitlements(
      free("2026-10-10T00:00:00.000Z"),
      null,
    );

    await repository.setBillingDefaultEntitlements(
      free("2026-10-01T00:00:00.000Z"),
      null,
    );

    expect(await repository.getDefaultEntitlements()).toMatchObject({
      periodStart: "2026-10-10T00:00:00.000Z",
    });
  });

  // #438-T19
  it("refuses a billing write that is not valid entitlements", async () => {
    const repository = await start();

    await expect(
      repository.setBillingDefaultEntitlements(
        { ...free(), limits: { ...LIMITS, diffRunsPerPeriod: -1 } },
        null,
      ),
    ).rejects.toBeInstanceOf(EntitlementsError);
    expect(await repository.getDefaultEntitlements()).toBeUndefined();
  });

  // #438-T10
  it("removes a default billing wrote and leaves the operator's one", async () => {
    const repository = await start();
    await repository.setBillingDefaultEntitlements(free(), null);

    expect(await repository.removeBillingDefaultEntitlements()).toBe(true);
    expect(await repository.getDefaultEntitlements()).toBeUndefined();

    await repository.set("default_entitlements", OPERATOR_DEFAULT, null);
    expect(await repository.removeBillingDefaultEntitlements()).toBe(false);
    expect(await repository.getDefaultEntitlements()).toMatchObject({
      planLabel: "Operator",
    });
  });

  // #438-T10
  it("removes nothing when there is no default", async () => {
    const repository = await start();

    expect(await repository.removeBillingDefaultEntitlements()).toBe(false);
  });
});
