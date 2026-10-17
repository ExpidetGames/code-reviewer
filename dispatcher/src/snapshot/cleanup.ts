// SPDX-License-Identifier: Apache-2.0

// Which golden snapshots a deployment removes once it is live (#403), or discards when it did not get there. The
// rule is a list of what to KEEP, never of what to delete: the snapshot the live Dispatcher deployment was started
// with and the one before it (the rollback target still references it) are the callers' `keep`, and everything else
// the pipeline built goes. A builder whose snapshot is unknown is left alone unless it has outlived any build (the leftover of one that was killed), and a snapshot that is not kept but is young is left alone too (a manual rehearsal may be using it). When
// none of the kept snapshots is found among the builders the list is not trusted and nothing is removed. Planning
// from the current state makes a repeat after a failure halfway safe: what is gone is not planned again.
import type { BuilderInfo } from "./service.ts";

export type CleanupPlan = {
  keep: BuilderInfo[];
  remove: BuilderInfo[];
  /** Builders with no known snapshot that are too young to be a crashed build's leftover: left alone and reported. */
  unmanaged: BuilderInfo[];
  /** Builders of a snapshot that is not kept but is too young to touch (a run that may be using it): left alone. */
  recent: BuilderInfo[];
  /** Why nothing is removed although something was asked. */
  refused?: "nothing_to_keep" | "keep_not_found";
};

export type CleanupRules = {
  keep: readonly string[];
  discard?: string;
  /** The clock (ms since the epoch). Without it no age rule applies. */
  now?: number;
  /** A snapshot that is not kept is left alone while its builder is younger than this (a manual rehearsal in progress). */
  minAgeMs?: number;
  /**
   * A builder with no snapshot is removed once it is older than this: no build lasts that long (builds are serialised
   * and time out), so it is the leftover of one that was killed. Younger ones are left alone and reported.
   */
  unmanagedMaxAgeMs?: number;
};

export function planCleanup(
  builders: readonly BuilderInfo[],
  options: CleanupRules,
): CleanupPlan {
  const kept = new Set(options.keep);
  const age = (builder: BuilderInfo): number | undefined =>
    options.now === undefined ? undefined : options.now - builder.createdAt;
  const withoutSnapshot = builders.filter(
    (builder) => builder.snapshotId === undefined,
  );
  const managed = builders.filter(
    (builder) => builder.snapshotId !== undefined,
  );
  const keep = managed.filter(
    (builder) =>
      builder.snapshotId !== undefined && kept.has(builder.snapshotId),
  );
  const refuse = (refused: CleanupPlan["refused"]): CleanupPlan => ({
    keep,
    remove: [],
    unmanaged: withoutSnapshot,
    recent: [],
    refused,
  });
  // A discard removes one named snapshot and nothing else, so it needs no check of the list. Anything wider does:
  // an empty or truncated list must never turn "everything but these" into "everything".
  if (options.discard === undefined) {
    if (kept.size === 0) return refuse("nothing_to_keep");
    if (keep.length === 0) return refuse("keep_not_found");
  }
  const candidates = managed.filter(
    (builder) =>
      builder.snapshotId !== undefined &&
      !kept.has(builder.snapshotId) &&
      (options.discard === undefined || builder.snapshotId === options.discard),
  );
  const tooYoung = (builder: BuilderInfo): boolean => {
    const old = age(builder);
    return (
      options.discard === undefined &&
      options.minAgeMs !== undefined &&
      old !== undefined &&
      old < options.minAgeMs
    );
  };
  const remove = candidates.filter((builder) => !tooYoung(builder));
  const recent = candidates.filter(tooYoung);
  // Leftovers of a killed build: a builder that never got a snapshot and has outlived any build.
  const stale = withoutSnapshot.filter((builder) => {
    const old = age(builder);
    return (
      options.discard === undefined &&
      options.unmanagedMaxAgeMs !== undefined &&
      old !== undefined &&
      old > options.unmanagedMaxAgeMs
    );
  });
  return {
    keep,
    remove: [...remove, ...stale].sort((a, b) => a.createdAt - b.createdAt),
    unmanaged: withoutSnapshot.filter((builder) => !stale.includes(builder)),
    recent,
  };
}
