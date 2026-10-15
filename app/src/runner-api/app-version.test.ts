// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { APP_VERSION } from "./app-version.ts";

describe("the app version", () => {
  // #322-T11
  it("is a non-empty text of at most 64 characters, as the contract requires", () => {
    expect(APP_VERSION.length).toBeGreaterThanOrEqual(1);
    expect(APP_VERSION.length).toBeLessThanOrEqual(64);
  });
});
