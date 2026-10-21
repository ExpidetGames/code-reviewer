// SPDX-License-Identifier: Apache-2.0

// #501: the billing profile service: who may read and write the profile, and what it hands out.
import { describe, expect, it } from "vitest";
import { createBillingProfilesRepository } from "../db/repositories/billing-profiles-repository.ts";
import { insertUser } from "../test-support/users.ts";
import {
  BILLING_ENGINES,
  type BillingEngine,
} from "../test-support/billing-engines.ts";
import { createBillingProfileService } from "./profile-service.ts";

const BODY = {
  legalName: "Example GmbH",
  country: "DE",
  addressLine1: "Teststrasse 1",
  addressLine2: "",
  postalCode: "10115",
  city: "Berlin",
  vatId: "de 123 456 789",
};

function suite(engine: BillingEngine) {
  describe.skipIf(engine.skip)(
    `the billing profile service on ${engine.name}`,
    () => {
      async function start() {
        const { db, workspaceId, otherWorkspaceId } = await engine.create();
        await insertUser(db, { id: "owner" });
        const service = createBillingProfileService({ db });
        const actor = (role: "owner" | "admin" | "member") => ({
          workspaceId,
          userId: "owner",
          role,
        });
        return { db, workspaceId, otherWorkspaceId, service, actor };
      }

      // #501-T04
      it("lets an Owner and an Admin save and read the profile, normalized, and tells a Member nothing", async () => {
        const t = await start();

        for (const role of ["owner", "admin"] as const) {
          const saved = await t.service.save(t.actor(role), BODY);
          expect(saved).toMatchObject({
            ok: true,
            profile: {
              legalName: "Example GmbH",
              country: "DE",
              addressLine2: null,
              vatId: "DE123456789",
              businessConfirmed: false,
            },
          });
          expect(await t.service.get(t.actor(role))).toMatchObject({
            ok: true,
            profile: { legalName: "Example GmbH" },
          });
        }
        expect(await t.service.get(t.actor("member"))).toEqual({
          ok: false,
          error: "forbidden",
        });
      });

      // #501-T04
      it("stores nothing for a Member", async () => {
        const t = await start();

        const refused = await t.service.save(t.actor("member"), BODY);

        expect(refused).toEqual({ ok: false, error: "forbidden" });
        expect(
          await createBillingProfilesRepository(t.db, t.workspaceId).get(),
        ).toBeUndefined();
      });

      // #501-T12
      it("refuses a wrong field with its code, stores nothing, and echoes no value", async () => {
        const t = await start();

        const refused = await t.service.save(t.actor("owner"), {
          ...BODY,
          vatId: "XX-secret-vat",
          country: "ZZ",
        });

        expect(refused).toEqual({
          ok: false,
          error: "invalid_input",
          issues: [{ field: "country", code: "country_unknown" }],
        });
        expect(JSON.stringify(refused)).not.toContain("secret");
        expect(
          await createBillingProfilesRepository(t.db, t.workspaceId).get(),
        ).toBeUndefined();
        const vat = await t.service.save(t.actor("owner"), {
          ...BODY,
          vatId: "DE12",
        });
        expect(vat).toMatchObject({
          ok: false,
          issues: [{ field: "vatId", code: "vat_id_invalid" }],
        });
      });

      // #501-T11
      it("hands out the profile without the customer id or the user who confirmed, and says whether the business confirmed", async () => {
        const t = await start();
        await t.service.save(t.actor("owner"), BODY);
        const repository = createBillingProfilesRepository(t.db, t.workspaceId);
        await repository.confirmBusiness({
          userId: "owner",
          termsVersion: "1",
        });
        await repository.setCustomer("stripe", "cus_1");

        const read = await t.service.get(t.actor("admin"));

        expect(read).toMatchObject({
          ok: true,
          profile: { businessConfirmed: true },
        });
        const json = JSON.stringify(read);
        expect(json).not.toContain("cus_1");
        expect(json).not.toContain("customerRef");
        expect(json).not.toContain("confirmedBy");
      });

      // #501-T11
      it("reads and writes the profile of the workspace in the actor, never another", async () => {
        const t = await start();
        await t.service.save(t.actor("owner"), BODY);

        const other = await t.service.get({
          workspaceId: t.otherWorkspaceId,
          userId: "owner",
          role: "owner",
        });

        expect(other).toEqual({ ok: true, profile: null });
      });

      // #501-T08
      it("keeps the confirmation and the customer when the profile is edited", async () => {
        const t = await start();
        await t.service.save(t.actor("owner"), BODY);
        const repository = createBillingProfilesRepository(t.db, t.workspaceId);
        await repository.confirmBusiness({
          userId: "owner",
          termsVersion: "1",
        });
        await repository.setCustomer("stripe", "cus_1");

        await t.service.save(t.actor("owner"), { ...BODY, city: "Hamburg" });

        expect(await repository.get()).toMatchObject({
          city: "Hamburg",
          termsVersion: "1",
          customerRef: "cus_1",
        });
      });
    },
  );
}

for (const engine of BILLING_ENGINES) suite(engine);
