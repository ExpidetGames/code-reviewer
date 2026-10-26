// SPDX-License-Identifier: LicenseRef-Proprietary

// #497: the manual adapter's service. An operator grants credit or makes a correction by hand: a journal entry with the
// provider `manual`, an actor and a note, which is the audit trail (the journal is append-only). There is no page yet
// (#504); the service is what its forms will call.
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import {
  BILLING_ENGINES,
  type BillingEngine,
} from "../test-support/billing-engines.ts";
import {
  MANUAL_ADJUSTMENT_MAX_MICRO_USD,
  MANUAL_CREDIT_ERROR_CODES,
  ManualCreditError,
  createManualCreditService,
} from "./manual-credit.ts";

const USD = 1_000_000;

async function codeOf(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
  } catch (error) {
    return error instanceof ManualCreditError ? error.code : "other";
  }
  return undefined;
}

function suite(engine: BillingEngine) {
  describe(`manual credits on ${engine.name}`, () => {
    async function setup() {
      const { db, workspaceId, otherWorkspaceId } = await engine.create();
      const lines: string[] = [];
      const service = createManualCreditService(db, {
        logger: { info: (line) => lines.push(line) },
      });
      const journal = createBillingJournalRepository(db, workspaceId);
      return { db, workspaceId, otherWorkspaceId, service, journal, lines };
    }

    // #497-T11
    it("grants credit as a top-up of the provider manual with its actor and note", async () => {
      const { service, journal, workspaceId } = await setup();

      const entry = await service.grant({
        workspaceId,
        amount: 40 * USD,
        actor: "user-admin",
        note: "pilot customer, invoice 2026-17",
      });

      expect(entry).toMatchObject({
        type: "top_up",
        amountMicroUsd: 40 * USD,
        provider: "manual",
        actorUserId: "user-admin",
        note: "pilot customer, invoice 2026-17",
        workspaceId,
      });
      expect(entry.providerRef).toMatch(/^manual_[A-Za-z0-9-]+$/);
      expect(entry.refKey).toBe(entry.providerRef);
      expect((await journal.balance()).balanceMicroUsd).toBe(40 * USD);
    });

    // #497-T11
    it("keys each grant by a random reference, so the same grant twice is two grants", async () => {
      const { service, journal, workspaceId } = await setup();
      const grant = { workspaceId, amount: 5 * USD, actor: "u", note: "n" };

      const first = await service.grant(grant);
      const second = await service.grant(grant);

      expect(first.refKey).not.toBe(second.refKey);
      expect((await journal.balance()).balanceMicroUsd).toBe(10 * USD);
    });

    // #497-T11
    it("makes a grant once per request id, however often the form is submitted", async () => {
      const { service, journal, workspaceId } = await setup();
      const grant = {
        workspaceId,
        amount: 5 * USD,
        actor: "u",
        note: "n",
        requestId: "form-1",
      };

      const results = await Promise.all([
        service.grant(grant),
        service.grant(grant),
        service.grant(grant),
      ]);

      expect(new Set(results.map((entry) => entry.id)).size).toBe(1);
      expect((await journal.balance()).balanceMicroUsd).toBe(5 * USD);
      expect(await codeOf(service.grant({ ...grant, amount: 6 * USD }))).toBe(
        "request_conflict",
      );
    });

    // #497-T11
    it("corrects a balance up or down with a correction, even below zero", async () => {
      const { service, journal, workspaceId } = await setup();
      await service.grant({
        workspaceId,
        amount: 10 * USD,
        actor: "u",
        note: "n",
      });

      const down = await service.correct({
        workspaceId,
        amount: -15 * USD,
        actor: "user-admin",
        note: "wrong grant last month",
      });
      const up = await service.correct({
        workspaceId,
        amount: 2 * USD,
        actor: "user-admin",
        note: "goodwill",
      });

      expect(down).toMatchObject({
        type: "correction",
        amountMicroUsd: -15 * USD,
        provider: "manual",
        actorUserId: "user-admin",
        note: "wrong grant last month",
      });
      expect(up.amountMicroUsd).toBe(2 * USD);
      expect((await journal.balance()).balanceMicroUsd).toBe(-3 * USD);
    });

    // #497-T11
    it("refuses a grant without a note or an actor, and a note that is only space", async () => {
      const { service, journal, workspaceId } = await setup();
      const base = { workspaceId, amount: 5 * USD, actor: "u", note: "n" };

      expect(await codeOf(service.grant({ ...base, note: "" }))).toBe(
        "note_required",
      );
      expect(await codeOf(service.grant({ ...base, note: "  \n\t " }))).toBe(
        "note_required",
      );
      expect(
        await codeOf(service.grant({ ...base, note: "x".repeat(501) })),
      ).toBe("note_too_long");
      expect(await codeOf(service.grant({ ...base, actor: "" }))).toBe(
        "actor_required",
      );
      expect(await codeOf(service.correct({ ...base, note: "" }))).toBe(
        "note_required",
      );
      expect((await journal.entries({ limit: 10 })).entries).toEqual([]);
    });

    // #497-T11
    it("refuses a grant that is not positive and an amount beyond what an operator may enter", async () => {
      const { service, journal, workspaceId } = await setup();
      const base = { workspaceId, actor: "u", note: "n" };

      for (const amount of [0, -1, -5 * USD, 1.5, Number.NaN, Infinity])
        expect(
          await codeOf(service.grant({ ...base, amount })),
          String(amount),
        ).toBe("amount_invalid");
      expect(
        await codeOf(
          service.grant({
            ...base,
            amount: MANUAL_ADJUSTMENT_MAX_MICRO_USD + 1,
          }),
        ),
      ).toBe("amount_out_of_range");
      expect(await codeOf(service.correct({ ...base, amount: 0 }))).toBe(
        "amount_invalid",
      );
      expect(
        await codeOf(
          service.correct({
            ...base,
            amount: -MANUAL_ADJUSTMENT_MAX_MICRO_USD - 1,
          }),
        ),
      ).toBe("amount_out_of_range");
      expect((await journal.entries({ limit: 10 })).entries).toEqual([]);
    });

    // #497-T11
    it("refuses a workspace that does not exist and credits only the one named", async () => {
      const { service, db, workspaceId, otherWorkspaceId } = await setup();

      expect(
        await codeOf(
          service.grant({
            workspaceId: "missing",
            amount: 5 * USD,
            actor: "u",
            note: "n",
          }),
        ),
      ).toBe("workspace_not_found");
      await service.grant({
        workspaceId,
        amount: 5 * USD,
        actor: "u",
        note: "n",
      });

      expect(
        (await createBillingJournalRepository(db, otherWorkspaceId).balance())
          .balanceMicroUsd,
      ).toBe(0);
    });

    // #497-T11
    it("logs a code line with the entry and never the note", async () => {
      const { service, workspaceId, lines } = await setup();

      const entry = await service.grant({
        workspaceId,
        amount: 5 * USD,
        actor: "u",
        note: "secret customer detail",
      });

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("billing_manual_credit");
      expect(lines[0]).toContain(entry.id);
      expect(lines.join("\n")).not.toContain("secret customer detail");
    });
  });
}

for (const engine of BILLING_ENGINES) suite(engine);

describe("the manual credit codes", () => {
  // #497-T13
  it("are a closed set in snake case", () => {
    expect(new Set(MANUAL_CREDIT_ERROR_CODES).size).toBe(
      MANUAL_CREDIT_ERROR_CODES.length,
    );
    for (const code of MANUAL_CREDIT_ERROR_CODES)
      expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });
});
