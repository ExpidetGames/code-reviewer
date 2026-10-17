// SPDX-License-Identifier: Apache-2.0

// Which golden snapshots a deployment removes once it is live (#403), or discards when it did not get there. The
// rule is a list of what to KEEP, never of what to delete: the snapshot the live Dispatcher deployment was started
// with and the one before it (the rollback target still references it) are the callers' `keep`, and everything else
// the pipeline built goes. A builder whose snapshot is unknown is never touched (it may be a run in progress). When
// none of the kept snapshots is found among the builders the list is not trusted and nothing is removed. Planning
// from the current state makes a repeat after a failure halfway safe: what is gone is not planned again.
import type { BuilderInfo } from "./service.ts";

export type CleanupPlan = {
  keep: BuilderInfo[];
  remove: BuilderInfo[];
  /** Builders with no known snapshot: left alone and reported. */
  unmanaged: BuilderInfo[];
  /** Why nothing is removed although something was asked. */
  refused?: "nothing_to_keep" | "keep_not_found";
};

export function planCleanup(
  builders: readonly BuilderInfo[],
  options: { keep: readonly string[]; discard?: string },
): CleanupPlan {
  const kept = new Set(options.keep);
  const unmanaged = builders.filter(
    (builder) => builder.snapshotId === undefined,
  );
  const managed = builders.filter(
    (builder) => builder.snapshotId !== undefined,
  );
  const keep = managed.filter(
    (builder) =>
      builder.snapshotId !== undefined && kept.has(builder.snapshotId),
  );
  if (kept.size === 0)
    return { keep, remove: [], unmanaged, refused: "nothing_to_keep" };
  if (keep.length === 0)
    return { keep, remove: [], unmanaged, refused: "keep_not_found" };
  const remove = managed
    .filter(
      (builder) =>
        builder.snapshotId !== undefined && !kept.has(builder.snapshotId),
    )
    .filter(
      (builder) =>
        options.discard === undefined || builder.snapshotId === options.discard,
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  return { keep, remove, unmanaged };
}
