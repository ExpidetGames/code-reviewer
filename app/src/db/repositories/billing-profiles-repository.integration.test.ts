// SPDX-License-Identifier: Apache-2.0

// #501: the billing profile of one workspace, on SQLite and on Postgres.
import { describe, expect, it } from "vitest";
import {
  BILLING_ENGINES,
  type BillingEngine,
} from "../../test-support/billing-engines.ts";
import { insertUser } from "../../test-support/users.ts";
import type { BillingProfileInput } from "../../billing/profile.ts";
import { createBillingProfilesRepository } from "./billing-profiles-repository.ts";

const PROFILE: BillingProfileInput = {
  legalName: "Example GmbH",
  country: "DE",
  addressLine1: "Teststrasse 1",
  addressLine2: "c/o Example",
  postalCode: "10115",
  city: "Berlin",
  vatId: "DE123456789",
};

function suite(engine: BillingEngine) {
  describe.skipIf(engine.skip)(`the billing profile on ${engine.name}`, () => {
    // #501-T11
    it("has no profile until one is saved, then returns what was saved", async () => {
      const { db, workspaceId } = await engine.create();
      const profiles = createBillingProfilesRepository(db, workspaceId);

      expect(await profiles.get()).toBeUndefined();
      const saved = await profiles.save(PROFILE);

      expect(saved).toMatchObject({
        ...PROFILE,
        confirmedAt: null,
        confirmedBy: null,
        termsVersion: null,
        customerAdapter: null,
        customerRef: null,
      });
      expect(await profiles.get()).toEqual(saved);
    });

    // #501-T08
    it("keeps the confirmation and the customer when the profile is edited, and moves the update time", async () => {
      const { db, workspaceId } = await engine.create();
      await insertUser(db, { id: "buyer" });
      let clock = new Date("2026-10-21T08:00:00.000Z");
      const profiles = createBillingProfilesRepository(
        db,
        workspaceId,
        () => clock,
      );
      await profiles.save(PROFILE);
      await profiles.confirmBusiness({ userId: "buyer", termsVersion: "1" });
      await profiles.setCustomer("stripe", "cus_1");

      clock = new Date("2026-10-21T09:00:00.000Z");
      const edited = await profiles.save({
        ...PROFILE,
        legalName: "Renamed GmbH",
        addressLine2: null,
        vatId: null,
      });

      expect(edited).toMatchObject({
        legalName: "Renamed GmbH",
        addressLine2: null,
        vatId: null,
        confirmedBy: "buyer",
        termsVersion: "1",
        customerAdapter: "stripe",
        customerRef: "cus_1",
        createdAt: "2026-10-21T08:00:00.000Z",
        updatedAt: "2026-10-21T09:00:00.000Z",
      });
    });

    // #501-T03
    it("records the business confirmation once: time, user and terms version", async () => {
      const { db, workspaceId } = await engine.create();
      await insertUser(db, { id: "first" });
      await insertUser(db, { id: "second" });
      const profiles = createBillingProfilesRepository(
        db,
        workspaceId,
        () => new Date("2026-10-21T08:00:00.000Z"),
      );
      expect(
        await profiles.confirmBusiness({ userId: "first", termsVersion: "1" }),
      ).toBeUndefined();
      await profiles.save(PROFILE);

      const confirmed = await profiles.confirmBusiness({
        userId: "first",
        termsVersion: "1",
      });
      const again = await profiles.confirmBusiness({
        userId: "second",
        termsVersion: "2",
      });

      expect(confirmed).toMatchObject({
        confirmedAt: "2026-10-21T08:00:00.000Z",
        confirmedBy: "first",
        termsVersion: "1",
      });
      expect(again).toEqual(confirmed);
    });

    // #501-T08
    it("records the customer of an adapter and replaces it when the adapter or the id is another", async () => {
      const { db, workspaceId } = await engine.create();
      const profiles = createBillingProfilesRepository(db, workspaceId);
      expect(await profiles.setCustomer("stripe", "cus_1")).toBeUndefined();
      await profiles.save(PROFILE);

      expect(await profiles.setCustomer("stripe", "cus_1")).toMatchObject({
        customerAdapter: "stripe",
        customerRef: "cus_1",
      });
      expect(await profiles.setCustomer("stripe", "cus_2")).toMatchObject({
        customerRef: "cus_2",
      });
      expect(await profiles.setCustomer("other", "x_1")).toMatchObject({
        customerAdapter: "other",
        customerRef: "x_1",
      });
    });

    // #501-T09
    it("refuses an adapter id that is not one and a provider id that is not opaque", async () => {
      const { db, workspaceId } = await engine.create();
      const profiles = createBillingProfilesRepository(db, workspaceId);
      await profiles.save(PROFILE);

      await expect(profiles.setCustomer("No Id", "cus_1")).rejects.toThrow();
      await expect(
        profiles.setCustomer("stripe", "cus 1; drop"),
      ).rejects.toThrow();
      expect(await profiles.get()).toMatchObject({ customerRef: null });
    });

    // #501-T11
    it("is scoped to its workspace: the other one has its own profile and its own confirmation", async () => {
      const { db, workspaceId, otherWorkspaceId } = await engine.create();
      await insertUser(db, { id: "buyer" });
      const a = createBillingProfilesRepository(db, workspaceId);
      const b = createBillingProfilesRepository(db, otherWorkspaceId);
      await a.save(PROFILE);
      await a.confirmBusiness({ userId: "buyer", termsVersion: "1" });
      await a.setCustomer("stripe", "cus_a");

      expect(await b.get()).toBeUndefined();
      await b.save({ ...PROFILE, legalName: "B GmbH" });
      expect(await b.get()).toMatchObject({
        legalName: "B GmbH",
        confirmedAt: null,
        customerRef: null,
      });
      expect(await a.get()).toMatchObject({
        legalName: "Example GmbH",
        customerRef: "cus_a",
      });
    });
  });
}

for (const engine of BILLING_ENGINES) suite(engine);
