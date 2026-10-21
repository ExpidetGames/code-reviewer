// SPDX-License-Identifier: Apache-2.0

// #499: the settings a workspace makes for its own billing (the monthly total limit), on SQLite and on Postgres.
import { describe, expect, it } from "vitest";
import { BILLING_ENGINES } from "../../test-support/billing-engines.ts";
import { insertUser } from "../../test-support/users.ts";
import { createBillingWorkspaceSettingsRepository } from "./billing-workspace-settings-repository.ts";

for (const engine of BILLING_ENGINES) {
  describe.skipIf(engine.skip)(
    `the workspace billing settings on ${engine.name}`,
    () => {
      // #499-T03
      it("has no limit and no row before anything was set", async () => {
        const { db, workspaceId } = await engine.create();
        const settings = createBillingWorkspaceSettingsRepository(
          db,
          workspaceId,
        );

        expect(await settings.get()).toBeUndefined();
        expect(await settings.monthlyLimitMicroUsd()).toBeNull();
      });

      // #499-T04
      it("stores a limit above 2^31 micro-USD with who set it and when", async () => {
        const { db, workspaceId } = await engine.create();
        await insertUser(db, { id: "owner-1" });
        const settings = createBillingWorkspaceSettingsRepository(
          db,
          workspaceId,
          () => new Date("2026-10-21T08:00:00.000Z"),
        );

        const stored = await settings.setMonthlyLimit(5_000_000_000, "owner-1");

        expect(stored).toEqual({
          monthlyLimitMicroUsd: 5_000_000_000,
          updatedBy: "owner-1",
          updatedAt: "2026-10-21T08:00:00.000Z",
        });
        expect(await settings.monthlyLimitMicroUsd()).toBe(5_000_000_000);
        expect(await settings.get()).toEqual(stored);
      });

      // #499-T03
      it("changes the limit and clears it with null, keeping the row", async () => {
        const { db, workspaceId } = await engine.create();
        const settings = createBillingWorkspaceSettingsRepository(
          db,
          workspaceId,
        );
        await settings.setMonthlyLimit(10_000_000, null);

        await settings.setMonthlyLimit(20_000_000, null);
        expect(await settings.monthlyLimitMicroUsd()).toBe(20_000_000);
        const cleared = await settings.setMonthlyLimit(null, null);

        expect(cleared.monthlyLimitMicroUsd).toBeNull();
        expect(await settings.monthlyLimitMicroUsd()).toBeNull();
        expect(await settings.get()).toBeDefined();
      });

      // #499-T04
      it("refuses a limit that is not a positive whole number and stores nothing", async () => {
        const { db, workspaceId } = await engine.create();
        const settings = createBillingWorkspaceSettingsRepository(
          db,
          workspaceId,
        );

        for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 60])
          await expect(settings.setMonthlyLimit(bad, null)).rejects.toThrow(
            TypeError,
          );
        expect(await settings.get()).toBeUndefined();
      });

      // #499-T12
      it("leaves the limit of another workspace alone", async () => {
        const { db, workspaceId, otherWorkspaceId } = await engine.create();
        const mine = createBillingWorkspaceSettingsRepository(db, workspaceId);
        const theirs = createBillingWorkspaceSettingsRepository(
          db,
          otherWorkspaceId,
        );
        await theirs.setMonthlyLimit(7_000_000, null);

        await mine.setMonthlyLimit(1_000_000, null);
        await mine.setMonthlyLimit(null, null);

        expect(await theirs.monthlyLimitMicroUsd()).toBe(7_000_000);
      });
    },
  );
}
