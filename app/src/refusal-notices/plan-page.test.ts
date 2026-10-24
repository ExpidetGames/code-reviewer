// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  PLAN_RETURN_PATH_SECTION,
  planReturnPath,
} from "../plan-handoff/return-path.ts";
import {
  billingPageUrl,
  planPagePath,
  planPageUrl,
  workspaceSettingsUrl,
} from "./plan-page.ts";

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

describe("the address of the settings of a workspace", () => {
  // #498-T03
  it("is the settings of the workspace on the configured address of the app, with a slug that cannot change the path", () => {
    expect(workspaceSettingsUrl("https://reviews.example.com", "acme")).toBe(
      "https://reviews.example.com/w/acme/settings",
    );
    expect(workspaceSettingsUrl("https://reviews.example.com", "a/../b")).toBe(
      "https://reviews.example.com/w/a%2F..%2Fb/settings",
    );
  });
});

describe("the address of the billing page of a workspace", () => {
  // #505-T12
  it("is the billing page of the workspace on the configured address of the app, with a slug that cannot change the path", () => {
    expect(billingPageUrl("https://reviews.example.com", "acme")).toBe(
      "https://reviews.example.com/w/acme/settings/billing",
    );
    expect(billingPageUrl("https://reviews.example.com", "a/../b")).toBe(
      "https://reviews.example.com/w/a%2F..%2Fb/settings/billing",
    );
  });
});
