// SPDX-License-Identifier: Apache-2.0

// Whether a deployment needs a new golden snapshot (#403). The snapshot is stale when something that goes into the
// Worker image changed between the commit it was built from and the commit being deployed, and it is missing when
// the pair is not configured (the first deployment). The pair in use is the one the live production Dispatcher
// deployment was started with (its meta), because that is what production really runs; the variables of the project
// (Infisical `/dispatcher`, synced) are the fallback for a deployment made by hand. When the two differ, the live one
// wins and the variables are to be repaired: a run that promoted and then could not write them leaves exactly that.
//
// Rebuilding is the safe answer whenever the pair cannot be trusted. Reusing is only ever answered for a complete
// pair of the right shape whose commit is in this clone and whose image inputs did not change.
import { IMAGE_INPUT_PATHS, pairsEqual, type SnapshotPair } from "./pair.ts";

export type DecideReason =
  | "forced"
  | "pair_missing"
  | "commit_unknown"
  | "inputs_changed"
  | "inputs_unchanged";

export type Decision = {
  rebuild: boolean;
  reason: DecideReason;
  /** The pair this deployment uses; only when nothing is rebuilt. */
  pair?: SnapshotPair;
  /** The variables of the project differ from the live pair: write the pair to them again after the promotion. */
  repair: boolean;
};

export type DecideDeps = {
  /** The pair the live production Dispatcher deployment carries in its meta, if it carries one. */
  live(): Promise<SnapshotPair | undefined>;
  /** The pair in the variables of the project (`vercel pull`), if complete and of the right shape. */
  projectPair(): SnapshotPair | undefined;
  /** Whether the commit is in this clone. */
  commitKnown(commit: string): Promise<boolean>;
  /** Whether any of the paths differs between the two commits. Throws when it cannot tell. */
  changed(from: string, to: string, paths: readonly string[]): Promise<boolean>;
};

export async function decide(options: {
  sha: string;
  force: boolean;
  deps: DecideDeps;
}): Promise<Decision> {
  const { deps } = options;
  if (options.force) return { rebuild: true, reason: "forced", repair: false };
  const live = await deps.live();
  const configured = deps.projectPair();
  const pair = live ?? configured;
  if (pair === undefined)
    return { rebuild: true, reason: "pair_missing", repair: false };
  if (!(await deps.commitKnown(pair.commit)))
    return { rebuild: true, reason: "commit_unknown", repair: false };
  if (await deps.changed(pair.commit, options.sha, IMAGE_INPUT_PATHS))
    return { rebuild: true, reason: "inputs_changed", repair: false };
  return {
    rebuild: false,
    reason: "inputs_unchanged",
    pair,
    repair: live !== undefined && !pairsEqual(live, configured),
  };
}
