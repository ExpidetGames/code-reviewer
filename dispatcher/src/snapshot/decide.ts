// SPDX-License-Identifier: LicenseRef-Proprietary

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
  | "snapshot_missing"
  | "inputs_changed"
  | "inputs_unchanged";

export type Decision = {
  rebuild: boolean;
  reason: DecideReason;
  /** The pair this deployment uses; only when nothing is rebuilt. */
  pair?: SnapshotPair;
  /**
   * The snapshot production runs now, when there is one: the one to keep next to a new one. Also known for a pair
   * that was set up by hand and has no commit, so that the first cleanup does not delete what the previous
   * deployment (the rollback target) still runs.
   */
  previousSnapshotId?: string;
  /** The variables of the project differ from the live pair: write the pair to them again after the promotion. */
  repair: boolean;
};

export type DecideDeps = {
  /**
   * The pair the live production Dispatcher deployment carries in its meta, if it carries one. Rejects when the
   * platform cannot say: the stale variables must not decide in its place.
   */
  live(): Promise<SnapshotPair | undefined>;
  /** The pair in the variables of the project (`vercel pull`), if complete and of the right shape. */
  projectPair(): SnapshotPair | undefined;
  /** The snapshot id in the variables of the project when it has the shape of one, even if the pair is incomplete. */
  projectSnapshotId(): string | undefined;
  /** Whether the snapshot is still there. "unavailable" is not "no". */
  snapshotExists(snapshotId: string): Promise<"yes" | "no" | "unavailable">;
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
  const live = await deps.live();
  const configured = deps.projectPair();
  const pair = live ?? configured;
  const previousSnapshotId = pair?.snapshotId ?? deps.projectSnapshotId();
  const previous =
    previousSnapshotId === undefined ? {} : { previousSnapshotId };
  if (options.force)
    return { rebuild: true, reason: "forced", repair: false, ...previous };
  if (pair === undefined)
    return {
      rebuild: true,
      reason: "pair_missing",
      repair: false,
      ...previous,
    };
  if (!(await deps.commitKnown(pair.commit)))
    return {
      rebuild: true,
      reason: "commit_unknown",
      repair: false,
      ...previous,
    };
  if (await deps.changed(pair.commit, options.sha, IMAGE_INPUT_PATHS))
    return {
      rebuild: true,
      reason: "inputs_changed",
      repair: false,
      ...previous,
    };
  // About to reuse it: is there still a snapshot behind the pair? A rollback past the previous snapshot, or a
  // deletion by hand, leaves a pair that looks fine and cannot start a job.
  const exists = await deps.snapshotExists(pair.snapshotId);
  if (exists === "unavailable") throw new Error("snapshot_lookup_failed");
  if (exists === "no")
    return {
      rebuild: true,
      reason: "snapshot_missing",
      repair: false,
      ...previous,
    };
  return {
    rebuild: false,
    reason: "inputs_unchanged",
    pair,
    ...previous,
    repair: live !== undefined && !pairsEqual(live, configured),
  };
}
