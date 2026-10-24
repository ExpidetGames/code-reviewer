// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the line of the overview of the portal for billing review rows (#603): while rows are open, the "Needs attention"
// region names how many and links the list; with none open the overview is as it was.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminSettingsView } from "../service.ts";
import { Overview } from "./overview.tsx";

afterEach(cleanup);

function settings(): AdminSettingsView {
  const never = { updatedBy: null, updatedAt: null };
  return {
    tenancy: { value: "single", ...never },
    signUpRule: { value: { kind: "everyone" }, ...never },
    signInMethods: {
      value: { emailPassword: true, github: false },
      effective: { emailPassword: true, github: false },
      ...never,
    },
    maxWorkspacesPerUser: { value: 10, ...never },
    ownKeyTokenCap: { value: 4_000_000, ...never },
    dynamicReview: { value: false, ...never },
    planManagementUrl: { value: null, ...never },
    smtp: { value: null, password: "none", ...never },
    operatorLlmKey: { state: "not_configured" },
    operatorLlmKeys: { openrouter: { state: "not_configured" } },
    modelCatalog: {
      diff: { released: 0, hasDefault: false },
      dynamic: { released: 0, hasDefault: false },
    },
    workspaceCount: 1,
    githubConfigured: false,
    mailConfigured: false,
    signUpRuleState: { failClosed: false },
    secrets: [],
    setupCompletedAt: "2026-10-11T08:00:00.000Z",
    importNotice: null,
  };
}

describe("the billing reviews on the overview", () => {
  // #603-T17
  it("name how many rows are open and link the list", () => {
    render(<Overview settings={settings()} billingReviewCount={2} />);

    const region = screen.getByRole("region", { name: "Needs attention" });
    expect(within(region).getByText("2 payments need a review.")).toBeTruthy();
    expect(
      within(region)
        .getByRole("link", { name: "Payment reviews" })
        .getAttribute("href"),
    ).toBe("/admin/billing/reviews");
  });

  // #603-T17
  it("say it in the singular for one row", () => {
    render(<Overview settings={settings()} billingReviewCount={1} />);

    expect(screen.getByText("1 payment needs a review.")).toBeTruthy();
  });

  // #603-T17
  it("add nothing while no row is open", () => {
    render(<Overview settings={settings()} billingReviewCount={0} />);

    expect(
      screen.queryByRole("region", { name: "Needs attention" }),
    ).toBeNull();
  });
});
