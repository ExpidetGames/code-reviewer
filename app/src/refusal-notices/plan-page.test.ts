// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  PLAN_RETURN_PATH_SECTION,
  planReturnPath,
} from "../plan-handoff/return-path.ts";
import { planPagePath, planPageUrl } from "./plan-page.ts";

describe("the address of the plan page of a workspace", () => {
  // #281-T09
  it("is the plan page of the workspace on the configured address of the app", () => {
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

  // #284-P2, #282: one place says where people land, and it is the plan page of #282.
  it("is the return path of the operator's page, from the one constant", () => {
    expect(planReturnPath("acme")).toBe("/w/acme/settings/plan");
    expect(planPagePath("acme")).toBe(planReturnPath("acme"));
    expect(PLAN_RETURN_PATH_SECTION).toBe("/plan");
  });
});
