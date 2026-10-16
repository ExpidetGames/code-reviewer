// SPDX-License-Identifier: Apache-2.0

// The read side of the plan page of a workspace (#282): the entitlements that apply to it (#271) and what its runs
// consumed since `periodStart` (#272), through the same repositories and the same period rule as the claim (#277),
// so the page and the refusal always agree: a run belongs to the period it started in (`reserved_at`), `reserved`
// and `settled` records count and `void` ones do not. Nothing is written. The shape of the answer, and what it
// leaves out, is `plan-view.ts`.
import "server-only";
import type { Kysely } from "kysely";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import type { Database } from "../db/schema.ts";
import { readEffectiveEntitlements } from "../workspaces/effective-entitlements.ts";
import { buildPlanView, type PlanUsage, type PlanView } from "./plan-view.ts";

/** After every run there can be: `summarize` takes a half open range, and the usage of a period has no end here. */
const END_OF_TIME = "9999-12-31T23:59:59.999Z";

const NO_USAGE: PlanUsage = {
  runs: { diff: 0, dynamic: 0 },
  costMicroUsd: 0,
  unknownCostCount: 0,
};

/**
 * The plan view of one workspace: what it may use and what it has used in the current period. A workspace
 * without entitlements, or with entitlements that cannot be read, reads no usage at all.
 */
export async function readPlanView(
  db: Kysely<Database>,
  workspaceId: string,
  now: () => Date = () => new Date(),
): Promise<PlanView> {
  const entitlements = await readEffectiveEntitlements(db, workspaceId, now);
  if (entitlements.kind !== "limited")
    return buildPlanView(entitlements, NO_USAGE);

  const records = createUsageRecordsRepository(db, workspaceId, now);
  const since = entitlements.periodStart;
  const runs = await records.countByKind(since);
  // The claim watches the cost of the runs on the key the workspace runs on, and only while that key's cost limit
  // is set (#361: the operator's key has its own limit, the workspace's key another).
  const { keyMode, limits } = entitlements;
  const costLimit =
    keyMode === "managed"
      ? limits.managedCostLimitMicroUsd
      : limits.ownKeyCostLimitMicroUsd;
  if (costLimit === null)
    return buildPlanView(entitlements, { ...NO_USAGE, runs });
  const [costMicroUsd, groups] = await Promise.all([
    records.sumSettledCostMicroUsd(since, keyMode),
    records.summarize({ from: since, to: END_OF_TIME }),
  ]);
  return buildPlanView(entitlements, {
    runs,
    costMicroUsd,
    unknownCostCount: groups
      .filter((group) => group.keyMode === keyMode)
      .reduce((total, group) => total + group.unknownCostCount, 0),
  });
}

/**
 * Whether the settings navigation links to the plan page: the workspace has entitlements (its own or the
 * instance default), readable or not. An unlimited workspace has no link; its page, reached by address, says
 * that no limits apply.
 */
export async function planPageAvailable(
  db: Kysely<Database>,
  workspaceId: string,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  return (
    (await readEffectiveEntitlements(db, workspaceId, now)).kind !== "unlimited"
  );
}
