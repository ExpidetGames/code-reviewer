// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { planPagePath, planPageUrl } from "./plan-page.ts";

describe("the address of the plan page of a workspace", () => {
  // #281-T09
  it("is the settings page of the workspace on the configured address of the app", () => {
    expect(planPageUrl("https://reviews.example.com", "acme")).toBe(
      "https://reviews.example.com/w/acme/settings/plan",
    );
  });

  it("keeps a slug that is not a plain name from changing the path", () => {
    expect(planPagePath("a/../b")).toBe("/w/a%2F..%2Fb/settings/plan");
    expect(planPageUrl("https://reviews.example.com", "a/../b")).toBe(
      "https://reviews.example.com/w/a%2F..%2Fb/settings/plan",
    );
  });
});
