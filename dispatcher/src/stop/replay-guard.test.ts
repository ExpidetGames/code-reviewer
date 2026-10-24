// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { createReplayGuard } from "./replay-guard.ts";

describe("the replay guard of the stop call", () => {
  // #487-T03
  it("lets an id through once, until it has been forgotten", () => {
    const guard = createReplayGuard();

    expect(guard.begin("a")).toBe(true);
    expect(guard.begin("a")).toBe(false);
    guard.forget("a");
    expect(guard.begin("a")).toBe(true);
  });

  // #487-T03
  it("remembers an id for twice the clock window and then lets it go", () => {
    let now = 0;
    const guard = createReplayGuard({ now: () => now, ttlMs: 600_000 });

    guard.begin("a");
    now = 599_999;
    expect(guard.begin("a")).toBe(false);
    now = 600_000;
    expect(guard.begin("a")).toBe(true);
  });

  // #487-T03
  it("is bounded: when full, the oldest id goes first", () => {
    const guard = createReplayGuard({ maxIds: 2 });

    guard.begin("a");
    guard.begin("b");
    guard.begin("c");

    expect(guard.begin("c")).toBe(false);
    expect(guard.begin("a")).toBe(true);
  });
});
