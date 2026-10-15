// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { BuilderInfo } from "./service.ts";
import { planRetention } from "./retention.ts";

const builder = (
  name: string,
  createdAt: number,
  snapshotId?: string,
): BuilderInfo => ({
  name,
  createdAt,
  ...(snapshotId ? { snapshotId } : {}),
});

describe("the retention plan", () => {
  // #330-T05
  it("keeps the current and one previous snapshot and removes the older ones", () => {
    const plan = planRetention(
      [
        builder("b1", 1, "s1"),
        builder("b4", 4, "s4"),
        builder("b2", 2, "s2"),
        builder("b3", 3, "s3"),
      ],
      { keep: 2, pinned: [] },
    );
    expect(plan.keep.map((b) => b.name)).toEqual(["b4", "b3"]);
    expect(plan.remove.map((b) => b.name)).toEqual(["b2", "b1"]);
  });

  // #330-T05
  it("keeps what is pinned (the snapshot in use) even when it is older than the newest two", () => {
    const plan = planRetention(
      [
        builder("b1", 1, "s1"),
        builder("b2", 2, "s2"),
        builder("b3", 3, "s3"),
        builder("b4", 4, "s4"),
      ],
      { keep: 2, pinned: ["s2"] },
    );
    expect(plan.keep.map((b) => b.name).sort()).toEqual(["b2", "b3", "b4"]);
    expect(plan.remove.map((b) => b.name)).toEqual(["b1"]);
  });

  // #330-T05
  it("removes nothing when there are no more than two", () => {
    const plan = planRetention(
      [builder("b1", 1, "s1"), builder("b2", 2, "s2")],
      {
        keep: 2,
        pinned: [],
      },
    );
    expect(plan.remove).toEqual([]);
  });

  // #330-T05
  it("never removes a builder whose snapshot is unknown and reports it instead", () => {
    const plan = planRetention(
      [
        builder("b1", 1),
        builder("b2", 2, "s2"),
        builder("b3", 3, "s3"),
        builder("b4", 4, "s4"),
      ],
      { keep: 2, pinned: [] },
    );
    expect(plan.remove.map((b) => b.name)).toEqual(["b2"]);
    expect(plan.unmanaged.map((b) => b.name)).toEqual(["b1"]);
  });

  it("orders builders created in the same millisecond by name, so the plan is deterministic", () => {
    const plan = planRetention(
      [builder("bb", 5, "s2"), builder("ba", 5, "s1"), builder("bc", 5, "s3")],
      { keep: 2, pinned: [] },
    );
    expect(plan.keep.map((b) => b.name)).toEqual(["bc", "bb"]);
    expect(plan.remove.map((b) => b.name)).toEqual(["ba"]);
  });
});
