// SPDX-License-Identifier: Apache-2.0

// #499: what a workspace was charged since a moment (the `usage` entries of the journal, AI plus infrastructure), the read of the
// monthly limit. The count of started reviews, the read of the hourly brake, is in usage-records-started-since.integration.test.ts.
import { describe, expect, it } from "vitest";
import { BILLING_ENGINES } from "../../test-support/billing-engines.ts";
import { createBillingJournalRepository } from "./billing-journal-repository.ts";

for (const engine of BILLING_ENGINES) {
  describe.skipIf(engine.skip)(`the charged total on ${engine.name}`, () => {
    async function charge(
      db: Awaited<ReturnType<typeof engine.create>>["db"],
      workspaceId: string,
      jobId: string,
      at: string,
      parts: { ai: number; infra: number },
    ) {
      const journal = createBillingJournalRepository(
        db,
        workspaceId,
        () => new Date(at),
      );
      await journal.append({
        type: "top_up",
        amountMicroUsd: 100_000_000,
        provider: "manual",
        providerRef: `top-${jobId}`,
        refKey: `top-${jobId}`,
      });
      await journal.reserve(1_000_000, jobId);
      await journal.settle(jobId, {
        aiMicroUsd: parts.ai,
        infraMicroUsd: parts.infra,
        minutes: 3,
        reviewKind: "diff",
      });
    }

    // #499-T01
    it("sums the usage entries since a moment, AI and infrastructure together, and nothing else", async () => {
      const { db, workspaceId } = await engine.create();
      await charge(db, workspaceId, "job-1", "2026-10-05T10:00:00.000Z", {
        ai: 400_000,
        infra: 100_000,
      });
      await charge(db, workspaceId, "job-2", "2026-10-20T10:00:00.000Z", {
        ai: 0,
        infra: 250_000,
      });
      const journal = createBillingJournalRepository(db, workspaceId);

      expect(await journal.chargedSince("2026-10-01T00:00:00.000Z")).toBe(
        750_000,
      );
      expect(await journal.chargedSince("2026-10-10T00:00:00.000Z")).toBe(
        250_000,
      );
      // Top-ups, reservations and releases are not charges.
      expect(await journal.chargedSince("2026-11-01T00:00:00.000Z")).toBe(0);
    });

    // #499-T02
    it("counts an entry made exactly at the start of the period, and not one a millisecond before", async () => {
      const { db, workspaceId } = await engine.create();
      await charge(db, workspaceId, "job-edge", "2026-10-01T00:00:00.000Z", {
        ai: 10,
        infra: 20,
      });
      await charge(db, workspaceId, "job-before", "2026-09-30T23:59:59.999Z", {
        ai: 1_000,
        infra: 0,
      });
      const journal = createBillingJournalRepository(db, workspaceId);

      expect(await journal.chargedSince("2026-10-01T00:00:00.000Z")).toBe(30);
    });

    // #499-T12
    it("never reads the charges of another workspace", async () => {
      const { db, workspaceId, otherWorkspaceId } = await engine.create();
      await charge(
        db,
        otherWorkspaceId,
        "job-other",
        "2026-10-05T10:00:00.000Z",
        { ai: 5_000, infra: 5_000 },
      );

      expect(
        await createBillingJournalRepository(db, workspaceId).chargedSince(
          "2026-10-01T00:00:00.000Z",
        ),
      ).toBe(0);
    });
  });
}
