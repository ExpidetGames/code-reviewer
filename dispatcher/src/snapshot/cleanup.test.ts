// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { planCleanup } from "./cleanup.ts";
import type { BuilderInfo } from "./service.ts";

const builder = (n: number, snapshotId: string | undefined): BuilderInfo => ({
  name: `code-reviewer-golden-builder-${String(n).padStart(2, "0")}`,
  createdAt: n * 1000,
  ...(snapshotId === undefined ? {} : { snapshotId }),
});
const B = [
  builder(1, "snap_a"),
  builder(2, "snap_b"),
  builder(3, "snap_c"),
  builder(4, "snap_d"),
  builder(5, undefined),
];

describe("which golden snapshots are removed after a deployment", () => {
  // #403-T16
  it("removes every managed builder whose snapshot is not kept", () => {
    const plan = planCleanup(B, { keep: ["snap_d", "snap_c"] });

    expect(plan.refused).toBeUndefined();
    expect(plan.remove.map((b) => b.snapshotId)).toEqual(["snap_a", "snap_b"]);
    expect(plan.keep.map((b) => b.snapshotId).sort()).toEqual([
      "snap_c",
      "snap_d",
    ]);
  });

  // #403-T16
  it("never removes the current or the previous snapshot, however old their builders are", () => {
    const plan = planCleanup(B, { keep: ["snap_a", "snap_b"] });

    expect(plan.remove.map((b) => b.snapshotId)).toEqual(["snap_c", "snap_d"]);
    expect(plan.remove.map((b) => b.snapshotId)).not.toContain("snap_a");
    expect(plan.remove.map((b) => b.snapshotId)).not.toContain("snap_b");
  });

  // #403-T16
  it("leaves a builder with no known snapshot alone and reports it", () => {
    const plan = planCleanup(B, { keep: ["snap_d"] });

    expect(plan.unmanaged.map((b) => b.name)).toEqual([
      builder(5, undefined).name,
    ]);
    expect(plan.remove.map((b) => b.name)).not.toContain(
      builder(5, undefined).name,
    );
  });

  // #403-T16
  it("refuses to remove anything when none of the kept snapshots is among the builders: the list may be incomplete", () => {
    const plan = planCleanup(B, { keep: ["snap_unknown"] });

    expect(plan.refused).toBe("keep_not_found");
    expect(plan.remove).toEqual([]);
  });

  // #403-T16
  it("refuses to remove anything when nothing is to be kept", () => {
    const plan = planCleanup(B, { keep: [] });

    expect(plan.refused).toBe("nothing_to_keep");
    expect(plan.remove).toEqual([]);
  });

  // #403-T16
  it("is idempotent: a second plan after the removals removes nothing more", () => {
    const first = planCleanup(B, { keep: ["snap_d", "snap_c"] });
    const left = B.filter((b) => !first.remove.includes(b));

    expect(planCleanup(left, { keep: ["snap_d", "snap_c"] }).remove).toEqual(
      [],
    );
  });

  // #403-T16
  it("discards one snapshot that a failed run built, and only that one, unless it is kept", () => {
    const plan = planCleanup(B, { keep: ["snap_c"], discard: "snap_d" });
    expect(plan.remove.map((b) => b.snapshotId)).toEqual(["snap_d"]);

    const protectedPlan = planCleanup(B, {
      keep: ["snap_d"],
      discard: "snap_d",
    });
    expect(protectedPlan.remove).toEqual([]);
  });

  // #403-T16
  it("discards the snapshot of the very first deployment that failed, when there is nothing to keep", () => {
    const plan = planCleanup(B, { keep: [], discard: "snap_d" });

    expect(plan.refused).toBeUndefined();
    expect(plan.remove.map((b) => b.snapshotId)).toEqual(["snap_d"]);
  });

  // #403-T16
  it("never discards more than the one snapshot, whatever else is in the list", () => {
    const plan = planCleanup(B, { keep: ["snap_unknown"], discard: "snap_b" });

    expect(plan.remove.map((b) => b.snapshotId)).toEqual(["snap_b"]);
  });

  // #403-T16
  it("discards nothing, without an error, when the snapshot is already gone (a run that failed halfway before)", () => {
    const plan = planCleanup(B, { keep: ["snap_c"], discard: "snap_gone" });

    expect(plan.refused).toBeUndefined();
    expect(plan.remove).toEqual([]);
  });
});

describe("what a cleanup leaves for a run that may be in progress, and what it clears that nothing owns", () => {
  const HOUR = 3_600_000;
  const NOW = 100 * HOUR;
  const aged = (
    hoursOld: number,
    snapshotId: string | undefined,
    n: number,
  ): BuilderInfo => ({
    name: `code-reviewer-golden-builder-${String(n).padStart(2, "0")}`,
    createdAt: NOW - hoursOld * HOUR,
    ...(snapshotId === undefined ? {} : { snapshotId }),
  });
  const rules = { now: NOW, minAgeMs: 3 * HOUR, unmanagedMaxAgeMs: 3 * HOUR };

  // #403-T22
  it("leaves a snapshot that is not kept but is young alone: a rehearsal by hand may be using it right now", () => {
    const builders = [
      aged(1, "snap_rehearsal", 1),
      aged(50, "snap_old", 2),
      aged(10, "snap_keep", 3),
    ];

    const plan = planCleanup(builders, { keep: ["snap_keep"], ...rules });

    expect(plan.remove.map((b) => b.snapshotId)).toEqual(["snap_old"]);
    expect(plan.recent.map((b) => b.snapshotId)).toEqual(["snap_rehearsal"]);
  });

  // #403-T22
  it("removes a builder with no snapshot once it is older than any build can last, and not before", () => {
    const builders = [
      aged(10, undefined, 1),
      aged(1, undefined, 2),
      aged(10, "snap_keep", 3),
    ];

    const plan = planCleanup(builders, { keep: ["snap_keep"], ...rules });

    expect(plan.remove.map((b) => b.name)).toEqual([builders[0]?.name]);
    expect(plan.unmanaged.map((b) => b.name)).toEqual([builders[1]?.name]);
  });

  // #403-T22
  it("does not apply the ages to a discard, which names its snapshot", () => {
    const builders = [aged(0.1, "snap_new", 1), aged(10, "snap_keep", 2)];

    const plan = planCleanup(builders, {
      keep: ["snap_keep"],
      discard: "snap_new",
      ...rules,
    });

    expect(plan.remove.map((b) => b.snapshotId)).toEqual(["snap_new"]);
  });

  // #403-T22
  it("does not clear builders with no snapshot when the list is refused", () => {
    const plan = planCleanup([aged(10, undefined, 1)], {
      keep: ["snap_unknown"],
      ...rules,
    });

    expect(plan.refused).toBe("keep_not_found");
    expect(plan.remove).toEqual([]);
  });

  // #403-T22
  it("keeps its earlier behavior when no clock is given", () => {
    const plan = planCleanup(B, { keep: ["snap_d"] });

    expect(plan.remove.map((b) => b.snapshotId)).toEqual([
      "snap_a",
      "snap_b",
      "snap_c",
    ]);
    expect(plan.recent).toEqual([]);
  });
});
