// SPDX-License-Identifier: Apache-2.0

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
  it("discards nothing, without an error, when the snapshot is already gone (a run that failed halfway before)", () => {
    const plan = planCleanup(B, { keep: ["snap_c"], discard: "snap_gone" });

    expect(plan.refused).toBeUndefined();
    expect(plan.remove).toEqual([]);
  });
});
