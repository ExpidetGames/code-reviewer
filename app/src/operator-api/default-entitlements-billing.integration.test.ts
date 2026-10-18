// SPDX-License-Identifier: Apache-2.0

// #438: while billing is on, the default entitlements are written by the billing module from the Free plan (ADR 0005, 2.9),
// so a write through the operator API is refused with `entitlements_default_managed_by_billing`. With billing off the API
// is exactly what it was.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
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

describe("the default entitlements through the operator API", () => {
  // #438-T06
  it("are refused while billing is on, and nothing is stored", async () => {
    const harness = await startOperatorApiHarness({ billingOn: true });

    const response = await harness.call("PUT", DEFAULT_PATH, { body: BODY });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "entitlements_default_managed_by_billing",
    });
    expect(
      await createInstanceSettingsRepository(
        harness.db,
      ).getDefaultEntitlements(),
    ).toBeUndefined();
  });

  // #438-T06
  it("are refused while billing is on even when the body is wrong, and the workspace rows are not affected", async () => {
    const harness = await startOperatorApiHarness({ billingOn: true });

    const wrong = await harness.call("PUT", DEFAULT_PATH, {
      body: { ...BODY, keyMode: "shared" },
    });
    const row = await harness.call(
      "PUT",
      `/api/operator/v1/workspaces/${harness.workspaceId}/entitlements`,
      { body: BODY },
    );

    expect(wrong.status).toBe(409);
    expect(row.status).toBe(200);
  });

  // #438-T06
  it("can still be read while billing is on", async () => {
    const harness = await startOperatorApiHarness({ billingOn: true });

    const response = await harness.call("GET", DEFAULT_PATH);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ default: null });
  });

  // #438-T10
  it("are the operator's while billing is off", async () => {
    const harness = await startOperatorApiHarness({ billingOn: false });

    const response = await harness.call("PUT", DEFAULT_PATH, { body: BODY });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      default: { planLabel: "Operator", keyMode: "own" },
    });
  });

  // #438-T06
  it("are the operator's again once billing is switched off", async () => {
    const harness = await startOperatorApiHarness({ billingOn: true });
    expect(
      (await harness.call("PUT", DEFAULT_PATH, { body: BODY })).status,
    ).toBe(409);

    harness.setBillingOn(false);

    expect(
      (await harness.call("PUT", DEFAULT_PATH, { body: BODY })).status,
    ).toBe(200);
  });

  // #438-T06
  it("refuse the marker of billing in the body, as any key they do not know", async () => {
    const harness = await startOperatorApiHarness({ billingOn: false });

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
