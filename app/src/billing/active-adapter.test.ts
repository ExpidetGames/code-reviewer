// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { DEFAULT_ADAPTER_ID, readActiveAdapterId } from "./active-adapter.ts";

describe("the active adapter", () => {
  // #497-T01
  it("is manual unless the billing setting names another adapter", () => {
    expect(DEFAULT_ADAPTER_ID).toBe("manual");
    expect(readActiveAdapterId(undefined)).toBe("manual");
    expect(readActiveAdapterId({ enabled: true })).toBe("manual");
    expect(readActiveAdapterId({ enabled: true, adapter: "stripe" })).toBe(
      "stripe",
    );
  });

  // #497-T01
  it("falls back to manual for a stored value that is not an adapter id", () => {
    for (const stored of [
      null,
      "stripe",
      7,
      [],
      { adapter: 7 },
      { adapter: "" },
      { adapter: "Not An Id" },
      { adapter: {} },
    ])
      expect(readActiveAdapterId(stored), JSON.stringify(stored)).toBe(
        "manual",
      );
  });
});
