// SPDX-License-Identifier: Apache-2.0

// The price of a review for the Runs pages (ADR 0006, 2.5; #505): what a customer reads next to a run. A charged review has its two
// final prices, the AI part and the infrastructure part; a review on the workspace's own key has the infrastructure part only
// (the AI part is null, not zero: there was nothing to price). A review that was settled and charged nothing (free because of an
// error on our side, or priced to nothing) is "not charged". A review that is still open (claimed with billing on, not yet
// settled), one that was claimed with billing off and a job that never ran have no price and no entry in the answer.
//
// Only the final prices leave: no rate, no minute count, no real cost, no model or provider. The read is scoped to the workspace
// of the source (the usage record and the `usage` entry are looked up by job id inside that workspace).
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import type { RunPriceView } from "../workspace-billing/view.ts";

export type RunPriceSource = {
  /** The price of each of these runs that has one, by job id. */
  pricesOf(jobIds: readonly string[]): Promise<Map<string, RunPriceView>>;
};

export function createRunPriceSource(
  db: Kysely<Database>,
  workspaceId: string,
): RunPriceSource {
  return {
    async pricesOf(jobIds) {
      const prices = new Map<string, RunPriceView>();
      if (jobIds.length === 0) return prices;
      const ids = [...new Set(jobIds)];
      const records = await db
        .selectFrom("usage_records")
        .select(["job_id", "key_mode", "billing_state"])
        .where("workspace_id", "=", workspaceId)
        .where("job_id", "in", ids)
        .where("billing_state", "is not", null)
        .execute();
      if (records.length === 0) return prices;
      const charges = await db
        .selectFrom("billing_journal_entries")
        .select(["ref_key", "ai_micro_usd", "infra_micro_usd"])
        .where("workspace_id", "=", workspaceId)
        .where("type", "=", "usage")
        .where(
          "ref_key",
          "in",
          records.map((record) => record.job_id),
        )
        .execute();
      const chargeOf = new Map(charges.map((charge) => [charge.ref_key, charge]));
      for (const record of records) {
        const charge = chargeOf.get(record.job_id);
        if (charge !== undefined) {
          prices.set(record.job_id, {
            state: "charged",
            aiMicroUsd:
              record.key_mode === "own" ? null : Number(charge.ai_micro_usd ?? 0),
            infraMicroUsd: Number(charge.infra_micro_usd ?? 0),
          });
          continue;
        }
        // Settled with nothing charged. An open record is still to be settled: it has no price yet.
        if (record.billing_state === "settled")
          prices.set(record.job_id, { state: "not_charged" });
      }
      return prices;
    },
  };
}
