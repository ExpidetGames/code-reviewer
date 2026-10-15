// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { UsageRecord } from "../db/repositories/usage-records-repository.ts";
import { usageItemView } from "./usage-views.ts";

function record(modelTier: string | null): UsageRecord {
  return {
    id: "r1",
    workspaceId: "w1",
    jobId: "j1",
    reviewKind: "diff",
    keyMode: "managed",
    modelTier,
    state: "settled",
    costMicroUsd: 1,
    promptTokens: 1,
    completionTokens: 1,
    reservedAt: "2026-10-14T11:00:00.000Z",
    settledAt: "2026-10-14T11:00:01.000Z",
  };
}

describe("the model tier of a usage item", () => {
  // #278-T04
  it.each(["standard", "deep", "tier-2", "fast_v2", "a"])(
    "serves the tier name %s",
    (tier) => {
      expect(usageItemView(record(tier)).modelTier).toBe(tier);
    },
  );

  // #278-T04
  it.each([
    ["a model id with a vendor", "vendor/some-model"],
    ["a version with a dot", "model-4.5"],
    ["upper case", "Standard"],
    ["white space", "very good"],
    ["empty", ""],
    ["starting with a digit", "2fast"],
    ["too long", `a${"b".repeat(32)}`],
  ])("serves null for a value that is not a tier name: %s", (_name, value) => {
    expect(usageItemView(record(value)).modelTier).toBeNull();
  });

  // #278-T04
  it("keeps null as null", () => {
    expect(usageItemView(record(null)).modelTier).toBeNull();
  });
});
