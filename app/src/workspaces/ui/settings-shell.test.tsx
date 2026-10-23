// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// The sub-navigation of the workspace settings and its Plan entry (#282): the entry exists only for a workspace
// that has entitlements, and its address is the one the operator's page and the refusal notice send people to.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { planReturnPath } from "../../plan-handoff/return-path.ts";
import { SettingsAccessProvider } from "./settings-nav.tsx";
import { SettingsNav, settingsSectionHref } from "./settings-shell.tsx";

afterEach(cleanup);

function links(showPlan?: boolean, showAdvanced = true): string[] {
  render(
    <SettingsNav
      workspaceSlug="acme"
      current=""
      showAdvanced={showAdvanced}
      {...(showPlan === undefined ? {} : { showPlan })}
    />,
  );
  return within(screen.getByRole("navigation", { name: "Settings sections" }))
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

describe("the settings navigation", () => {
  // #282-T01
  it("has no Plan entry unless the workspace has entitlements", () => {
    expect(links()).toEqual([
      "General",
      "Review defaults",
      "LLM access",
      "Advanced",
    ]);
  });

  // #658-T02
  it("lists Advanced only for the Owner: the layout says so, and without it there is no entry", () => {
    expect(links(undefined, false)).toEqual([
      "General",
      "Review defaults",
      "LLM access",
    ]);
  });

  // #658-T02
  it("takes Advanced from the settings layout when the caller does not say", () => {
    const names = (showAdvanced: boolean) => {
      const view = render(
        <SettingsAccessProvider showAdvanced={showAdvanced}>
          <SettingsNav workspaceSlug="acme" current="" />
        </SettingsAccessProvider>,
      );
      const found = within(
        screen.getByRole("navigation", { name: "Settings sections" }),
      )
        .getAllByRole("link")
        .map((link) => link.textContent ?? "");
      view.unmount();
      return found;
    };

    expect(names(true)).toContain("Advanced");
    expect(names(false)).not.toContain("Advanced");
    // Outside a layout (a page rendered alone) nobody gets the entry.
    render(<SettingsNav workspaceSlug="acme" current="" />);
    expect(screen.queryByRole("link", { name: "Advanced" })).toBeNull();
  });

  it("has the Plan entry before Advanced for a workspace that has entitlements", () => {
    expect(links(true)).toEqual([
      "General",
      "Review defaults",
      "LLM access",
      "Plan",
      "Advanced",
    ]);
  });

  it("links the Plan entry to the address the operator's page and the notice use", () => {
    expect(settingsSectionHref("acme", "plan")).toBe(planReturnPath("acme"));
    expect(settingsSectionHref("acme", "plan")).toBe("/w/acme/settings/plan");
  });
});

describe("the settings navigation while billing is on (#505)", () => {
  function billingLinks(options: {
    showPlan?: boolean;
    showBilling?: boolean;
  }) {
    render(
      <SettingsNav
        workspaceSlug="acme"
        current=""
        showAdvanced
        {...(options.showPlan === undefined
          ? {}
          : { showPlan: options.showPlan })}
        {...(options.showBilling === undefined
          ? {}
          : { showBilling: options.showBilling })}
      />,
    );
    return within(screen.getByRole("navigation", { name: "Settings sections" }))
      .getAllByRole("link")
      .map((link) => link.textContent ?? "");
  }

  // #505-T11
  it("has no Billing entry while billing is off", () => {
    expect(billingLinks({ showPlan: true })).toEqual([
      "General",
      "Review defaults",
      "LLM access",
      "Plan",
      "Advanced",
    ]);
  });

  // #505-T11
  it("lists Billing instead of Plan before Advanced while billing is on", () => {
    expect(billingLinks({ showPlan: true, showBilling: true })).toEqual([
      "General",
      "Review defaults",
      "LLM access",
      "Billing",
      "Advanced",
    ]);
  });

  // #505-T01
  it("lists Billing for a workspace that has no entitlements too", () => {
    expect(billingLinks({ showBilling: true })).toContain("Billing");
  });

  // #505-T01
  it("links Billing to the address the top-up returns to and the notices point to", () => {
    expect(settingsSectionHref("acme", "billing")).toBe(
      "/w/acme/settings/billing",
    );
  });
});
