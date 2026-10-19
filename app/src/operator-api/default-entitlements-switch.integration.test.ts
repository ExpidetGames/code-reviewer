// SPDX-License-Identifier: Apache-2.0

// #491: the default entitlements belong to the operator whatever the billing switch says. A default that a database of
// the removed billing design stored with `source: "billing"` reads without error and without the field.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { startOperatorApiHarness } from "../test-support/operator-api-harness.ts";

const DEFAULT_PATH = "/api/operator/v1/entitlements/default";

const BODY = {
  planLabel: "Operator",
  keyMode: "own",
  limits: {
    diffRunsPerPeriod: null,
    dynamicRunsPerPeriod: null,
    managedCostLimitMicroUsd: null,
    ownKeyCostLimitMicroUsd: null,
  },
  suspended: false,
  suspensionCode: null,
};

const STORED_WITH_MARKER = {
  ...BODY,
  periodStart: "2026-10-01T00:00:00.000Z",
  modelAccess: { catalogEntries: null },
  source: "billing",
};

describe("the default entitlements through the operator API", () => {
  // #491-T05
  it("are written like any operator write while the billing switch is on", async () => {
    const harness = await startOperatorApiHarness();
    await setBillingSwitch(harness.db, true);

    const response = await harness.call("PUT", DEFAULT_PATH, { body: BODY });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      default: { planLabel: "Operator", keyMode: "own" },
    });
    expect(
      await createInstanceSettingsRepository(
        harness.db,
      ).getDefaultEntitlements(),
    ).toMatchObject({ planLabel: "Operator" });
  });

  // #491-T05
  it("know no refusal for billing in the code set", async () => {
    const harness = await startOperatorApiHarness();

    const response = await harness.call("PUT", DEFAULT_PATH, {
      body: { ...BODY, keyMode: "shared" },
    });

    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).not.toMatch(/billing/);
  });

  // #491-T06
  it("refuse the marker `source` in a body like any key the API does not know", async () => {
    const harness = await startOperatorApiHarness();

    const response = await harness.call("PUT", DEFAULT_PATH, {
      body: { ...BODY, source: "billing" },
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "entitlements_invalid",
      field: "source",
    });
  });
});

describe("a stored default of the removed billing design", () => {
  // #491-T06
  it("reads without error and without the marker", async () => {
    const harness = await startOperatorApiHarness();
    await harness.db
      .insertInto("instance_settings")
      .values({
        key: "default_entitlements",
        value: JSON.stringify(STORED_WITH_MARKER),
        updated_by: null,
        updated_at: "2026-10-18T08:00:00.000Z",
      })
      .execute();

    const stored = await createInstanceSettingsRepository(
      harness.db,
    ).getDefaultEntitlements();
    const response = await harness.call("GET", DEFAULT_PATH);

    expect(stored).toMatchObject({ planLabel: "Operator", keyMode: "own" });
    expect(stored).not.toHaveProperty("source");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.default).toMatchObject({ planLabel: "Operator" });
    expect(JSON.stringify(body)).not.toContain("source");
  });

  // #491-T06
  it("is replaced by the operator's next write, with no marker left", async () => {
    const harness = await startOperatorApiHarness();
    await harness.db
      .insertInto("instance_settings")
      .values({
        key: "default_entitlements",
        value: JSON.stringify(STORED_WITH_MARKER),
        updated_by: null,
        updated_at: "2026-10-18T08:00:00.000Z",
      })
      .execute();

    const response = await harness.call("PUT", DEFAULT_PATH, {
      body: { ...BODY, planLabel: "Next" },
    });

    expect(response.status).toBe(200);
    const row = await harness.db
      .selectFrom("instance_settings")
      .select("value")
      .where("key", "=", "default_entitlements")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.value)).not.toHaveProperty("source");
  });
});
