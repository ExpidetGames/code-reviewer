// SPDX-License-Identifier: LicenseRef-Proprietary

// #506: a correction an operator writes by hand can take a balance below the threshold, and a credit can lift it out again. Both go
// through the same journal write as everything else, so the decision is made there; the mail is sent after the write, by the hook
// the running server hands the service.
import { describe, expect, it, vi } from "vitest";
import { createBillingNotificationsRepository } from "../db/repositories/billing-notifications-repository.ts";
import { BILLING_ENGINES } from "../test-support/billing-engines.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { insertUser } from "../test-support/users.ts";
import { createBillingCreditService } from "./admin-credit-service.ts";

const USD = 1_000_000;

for (const engine of BILLING_ENGINES) {
  describe.skipIf(engine.skip)(
    `the manual credit and the balance notices on ${engine.name}`,
    () => {
      // #506-T05
      it("decides the crossing of a correction and calls the delivery of mails after the write", async () => {
        const { db, workspaceId } = await engine.create();
        await setBillingSwitch(db, true);
        await insertUser(db, { id: "operator" });
        await fundWorkspace(db, workspaceId, 20 * USD);
        const afterWritten = vi.fn();
        const service = createBillingCreditService({ db, afterWritten });

        const result = await service.credit("operator", workspaceId, {
          type: "correction",
          amountMicroUsd: -17 * USD,
          note: "Refunded outside Stripe",
          requestId: "req-1",
        });

        expect(result).toMatchObject({ ok: true, balanceMicroUsd: 3 * USD });
        expect(afterWritten).toHaveBeenCalledTimes(1);
        expect(
          await createBillingNotificationsRepository(db, workspaceId).list(),
        ).toEqual([expect.objectContaining({ kind: "low", delivery: "due" })]);
      });

      // #506-T03
      it("re-arms with a credit that lifts the balance out of the state", async () => {
        const { db, workspaceId } = await engine.create();
        await setBillingSwitch(db, true);
        await insertUser(db, { id: "operator" });
        await fundWorkspace(db, workspaceId, 20 * USD);
        const service = createBillingCreditService({ db });
        await service.credit("operator", workspaceId, {
          type: "correction",
          amountMicroUsd: -17 * USD,
          note: "x",
          requestId: "req-1",
        });

        await service.credit("operator", workspaceId, {
          type: "credit",
          amountMicroUsd: 10 * USD,
          note: "Pilot customer",
          requestId: "req-2",
        });

        expect(
          await createBillingNotificationsRepository(db, workspaceId).list(),
        ).toEqual([
          expect.objectContaining({
            kind: "low",
            state: "armed",
            delivery: "none",
          }),
        ]);
      });

      // #506-T08
      it("does not call the delivery of mails for a refused write", async () => {
        const { db, workspaceId } = await engine.create();
        const afterWritten = vi.fn();
        const service = createBillingCreditService({ db, afterWritten });

        const result = await service.credit("operator", workspaceId, {
          type: "correction",
          amountMicroUsd: 0,
          note: "x",
          requestId: "req-1",
        });

        expect(result.ok).toBe(false);
        expect(afterWritten).not.toHaveBeenCalled();
      });
    },
  );
}
