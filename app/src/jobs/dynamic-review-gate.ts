// SPDX-License-Identifier: Apache-2.0

// #195 rollout gate: Dynamic Review is not queued until the app/database marks it enabled
// (instance-level, default off until #202 ships). Two reasons:
//
//   * A previous-release app on a shared database ignores `review_kind` in its claim SQL and would
//     hand a Dynamic row to a runner as an untagged Diff payload — a silent fallback. Until every app
//     instance is upgraded, no Dynamic row may exist.
//   * The OpenCode engine is not packaged yet (#202).
//
// With the gate off, a Dynamic project still gets a run, and that run fails visibly with
// `dynamic_review_disabled` instead of silently reviewing as Diff. The gate is read in the enqueue
// transaction, so enabling/disabling it and queueing serialize.
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";

/** The key of the instance setting that enables Dynamic Review. */
export const DYNAMIC_REVIEW_SETTING_KEY = "dynamic_review" as const;

/** Whether Dynamic Review may be queued. Read inside the enqueue transaction. */
export type DynamicReviewGate = (
  executor: Kysely<Database>,
) => Promise<boolean>;

/**
 * The configured gate. No row (or `enabled: false`) means off: a Dynamic project's job is created
 * failed with `dynamic_review_disabled`. Turn it on only after every app instance is upgraded, and
 * off before rolling back (contracts/README.md).
 */
export function createInstanceDynamicReviewGate(): DynamicReviewGate {
  return async (executor) => {
    const value = await createInstanceSettingsRepository(executor).get(
      DYNAMIC_REVIEW_SETTING_KEY,
    );
    return value?.enabled === true;
  };
}

/** For tests and single-process setups: Dynamic Review is always allowed. */
export const dynamicReviewEnabled: DynamicReviewGate = async () => true;
