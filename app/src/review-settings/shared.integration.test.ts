// SPDX-License-Identifier: LicenseRef-Proprietary

// The review settings service as the running server builds it (`reviewSettingsServiceFor`, #689): the maximum cost per review
// the admin sets in the portal reaches the views and the save of a customer, read at each request. The service the tests of the
// rules build by hand gets the maximum from its harness, so only this test goes through the factory and would notice a
// factory that leaves it out (every customer then sees and is held to the default 1.00 USD while the jobs carry the admin's).
import { describe, expect, it, vi } from "vitest";

const wiring = vi.hoisted(() => ({
  db: undefined as unknown,
}));

vi.mock("../db/startup.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/startup.ts")>()),
  getDatabase: () => wiring.db,
}));

import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { defaultWorkspaceId } from "../test-support/workspaces.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { ReviewSettingsError } from "./errors.ts";
import { reviewSettingsServiceFor } from "./shared.ts";

describe("the review settings of the running server", () => {
  async function setup() {
    const { db } = await createTestDatabase();
    wiring.db = db;
    const workspaceId = await defaultWorkspaceId(db);
    const setMaximum = (cents: number) =>
      createInstanceSettingsRepository(db).set(
        "review_max_cost_cents",
        cents,
        null,
      );
    return { workspaceId, setMaximum };
  }

  // #689-T14
  it("shows the customer the maximum the admin set, read anew for every request", async () => {
    const { workspaceId, setMaximum } = await setup();

    expect(
      (await reviewSettingsServiceFor(workspaceId).getGlobalSettings())
        .operatorMaxCostCents,
    ).toBe(100);

    await setMaximum(50);
    expect(
      (await reviewSettingsServiceFor(workspaceId).getGlobalSettings())
        .operatorMaxCostCents,
    ).toBe(50);

    await setMaximum(500);
    expect(
      (await reviewSettingsServiceFor(workspaceId).getGlobalSettings())
        .operatorMaxCostCents,
    ).toBe(500);
  });

  // #689-T14
  it("holds a save to that maximum: refuses above it, accepts up to it", async () => {
    const { workspaceId, setMaximum } = await setup();
    await setMaximum(500);

    // Above the default 1.00 USD but within the admin's 5.00 USD: a service that ignored the setting would refuse this.
    const saved = await reviewSettingsServiceFor(
      workspaceId,
    ).updateGlobalSettings({ maxCostCents: 400 }, "octocat");
    expect(saved.overrides.maxCostCents).toBe(400);

    await setMaximum(50);
    const refused = await reviewSettingsServiceFor(workspaceId)
      .updateGlobalSettings({ maxCostCents: 60 }, "octocat")
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(ReviewSettingsError);
    expect((refused as ReviewSettingsError).issues).toEqual([
      expect.objectContaining({
        field: "maxCostCents",
        code: "EXCEEDS_OPERATOR_MAXIMUM",
        maximumCents: 50,
      }),
    ]);
  });
});
