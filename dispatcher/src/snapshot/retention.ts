// SPDX-License-Identifier: LicenseRef-Proprietary

// Which golden snapshots survive a new build (#330): the newest `keep` (the current one and the previous
// ones), plus every pinned id (the snapshot the Dispatcher is configured with, which can be older when a
// newer one failed its canary). A builder whose snapshot is unknown is never removed here: it may be a run in
// progress or a snapshot the platform did not report, and deleting it would delete the snapshot with it.
import type { BuilderInfo } from "./service.ts";

export type RetentionPlan = {
  keep: BuilderInfo[];
  remove: BuilderInfo[];
  /** Builders with no known snapshot: left alone and reported. */
  unmanaged: BuilderInfo[];
};

export function planRetention(
  builders: readonly BuilderInfo[],
  options: { keep: number; pinned: readonly string[] },
): RetentionPlan {
  const withSnapshot = builders
    .filter((builder) => builder.snapshotId !== undefined)
    .sort(
      (a, b) =>
        b.createdAt - a.createdAt ||
        (a.name < b.name ? 1 : a.name > b.name ? -1 : 0),
    );
  const pinned = new Set(options.pinned);
  const keep = withSnapshot.slice(0, options.keep);
  const remove: BuilderInfo[] = [];
  for (const builder of withSnapshot.slice(options.keep)) {
    if (builder.snapshotId !== undefined && pinned.has(builder.snapshotId))
      keep.push(builder);
    else remove.push(builder);
  }
  return {
    keep,
    remove,
    unmanaged: builders.filter((builder) => builder.snapshotId === undefined),
  };
}
