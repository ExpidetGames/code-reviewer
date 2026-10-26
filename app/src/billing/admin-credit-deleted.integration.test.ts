// SPDX-License-Identifier: LicenseRef-Proprietary

// #658: an operator's lookup, search and manual credit never reach a deleted workspace (a tombstone: anonymised, its journal kept
// for the books). Crediting one would put money where nobody can spend it.
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { BILLING_ENGINES } from "../test-support/billing-engines.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { insertUser } from "../test-support/users.ts";
import { markWorkspaceDeleted } from "../test-support/workspaces.ts";
import { createBillingCreditService } from "./admin-credit-service.ts";

for (const engine of BILLING_ENGINES) {
  describe(`the operator's credit and a deleted workspace on ${engine.name}`, () => {
    async function start() {
      const { db, workspaceId, otherWorkspaceId } = await engine.create();
      await setBillingSwitch(db, true);
      await insertUser(db, { id: "operator" });
      await markWorkspaceDeleted(db, workspaceId);
      return {
        db,
        deletedId: workspaceId,
        liveId: otherWorkspaceId,
        service: createBillingCreditService({ db }),
      };
    }

    // #658-T03
    it("does not find a deleted workspace by name or by id", async () => {
      const { service, deletedId, liveId } = await start();

      expect((await service.search("")).map((found) => found.id)).not.toContain(
        deletedId,
      );
      expect(await service.search("deleted")).toEqual([]);
      expect(await service.workspace(deletedId)).toBeUndefined();
      expect((await service.workspace(liveId))?.workspace.id).toBe(liveId);
    });

    // #658-T03
    it("refuses to credit or correct a deleted workspace and writes no entry", async () => {
      const { db, service, deletedId } = await start();
      const before = (
        await createBillingJournalRepository(db, deletedId).entries({
          limit: 100,
        })
      ).entries;

      for (const type of ["credit", "correction"] as const) {
        const result = await service.credit("operator", deletedId, {
          type,
          amountMicroUsd: 5_000_000,
          note: "x",
          requestId: `req-${type}`,
        });
        expect(result, type).toEqual({
          ok: false,
          error: "workspace_not_found",
        });
      }

      expect(
        (
          await createBillingJournalRepository(db, deletedId).entries({
            limit: 100,
          })
        ).entries,
      ).toEqual(before);
    });
  });
}
