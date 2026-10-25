// SPDX-License-Identifier: LicenseRef-Proprietary

// Where the operator's maximum cost per review is read from (#689): the instance setting `review_max_cost_cents`. Every
// consumer (the claim, the review settings of a request, the harnesses of the tests) reads it through this one function, so none
// of them keeps a stale copy: it asks the database at each call.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { operatorCostLimitCentsOf } from "./operator-cost-limit.ts";

/** The maximum in whole US cents, read at each call; the default when the setting is not set or not valid. */
export function operatorCostLimitCentsFrom(
  db: Kysely<Database>,
): () => Promise<number> {
  const settings = createInstanceSettingsRepository(db);
  return async () =>
    operatorCostLimitCentsOf(await settings.get("review_max_cost_cents"));
}
