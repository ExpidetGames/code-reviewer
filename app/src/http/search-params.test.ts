// SPDX-License-Identifier: Apache-2.0

// Pins the shared reader for one page search param: a single non-empty string is the value, and a
// repeated, empty or missing parameter counts as absent.
import { describe, expect, it } from "vitest";
import { singleSearchParam } from "./search-params.ts";

describe("a single search param", () => {
  it("returns a non-empty string", () => {
    expect(singleSearchParam("created")).toBe("created");
  });

  it("treats an empty, repeated or missing value as absent", () => {
    expect(singleSearchParam("")).toBeNull();
    expect(singleSearchParam(["a", "b"])).toBeNull();
    expect(singleSearchParam(undefined)).toBeNull();
  });
});
