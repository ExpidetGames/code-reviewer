// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// A navigation entry of a capability the deployment does not have is not rendered, for anybody (#731): the workspace
// sidebar, the settings sub-navigation and the admin menu all read the capability set the root layout hands down.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";

const navigation = vi.hoisted(() => ({ pathname: "/w/acme/members" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

import { AdminNav } from "../admin/ui/admin-nav.tsx";
import { adminNavGroupsFor } from "../admin/ui/nav-items.ts";
import { AppShell } from "../shell/app-shell.tsx";
import { navGroupsFor, navItemsFor } from "../shell/nav-items.ts";
import { getProductIdentity } from "../product-identity/current.ts";
import { workspaceHome } from "../workspaces/paths.ts";
import { SettingsNav } from "../workspaces/ui/settings-nav.tsx";
import { CapabilitiesProvider } from "./context.tsx";
import { createCapabilitySet, type Capability } from "./capability.ts";

afterEach(() => {
  cleanup();
  navigation.pathname = "/w/acme/members";
});

const FACTORY: Capability[] = ["review", "dynamic-review"];
const labels = () =>
  screen.queryAllByRole("link").map((link) => link.textContent);

describe("the workspace sidebar", () => {
  // #731-T06
  it("lists Projects and Runs where the deployment has review, and the rest of the workspace always", () => {
    render(
      <CapabilitiesProvider capabilities={FACTORY}>
        <AppShell product={getProductIdentity()} userMenu={<span>menu</span>}>
          <h1>Page</h1>
        </AppShell>
      </CapabilitiesProvider>,
    );

    expect(labels()).toEqual(
      expect.arrayContaining([
        "Projects",
        "Runs",
        "Connections",
        "Members",
        "Settings",
      ]),
    );
  });

  // #731-T06
  it("leaves Projects and Runs out without review, for every person: the sidebar knows no roles", () => {
    render(
      <CapabilitiesProvider capabilities={[]}>
        <AppShell product={getProductIdentity()} userMenu={<span>menu</span>}>
          <h1>Page</h1>
        </AppShell>
      </CapabilitiesProvider>,
    );

    expect(labels()).not.toContain("Projects");
    expect(labels()).not.toContain("Runs");
    expect(labels()).toEqual(
      expect.arrayContaining(["Connections", "Members", "Settings"]),
    );
  });

  it("shows the whole product where no capability set was provided", () => {
    render(
      <AppShell product={getProductIdentity()} userMenu={<span>menu</span>}>
        <h1>Page</h1>
      </AppShell>,
    );

    expect(labels()).toEqual(expect.arrayContaining(["Projects", "Runs"]));
  });

  it("has the pure lists agree, and starts a workspace on a page it has", () => {
    const none = createCapabilitySet([]);
    expect(navItemsFor("/w/acme", none).map((item) => item.label)).toEqual([
      "Connections",
      "Members",
      "Settings",
    ]);
    expect(navGroupsFor("/w/acme", none)).toHaveLength(1);
    expect(workspaceHome("acme")).toBe("/w/acme/projects");
    expect(workspaceHome("acme", createCapabilitySet(FACTORY))).toBe(
      "/w/acme/projects",
    );
    expect(workspaceHome("acme", none)).toBe("/w/acme/connections");
  });
});

describe("the settings navigation", () => {
  const sections = () =>
    screen
      .getAllByRole("link")
      .map((link) => link.textContent)
      .filter((text): text is string => text !== null);

  // #731-T06
  it.each([
    ["Owner", true],
    ["Admin", false],
    ["Member", false],
  ])(
    "lists neither Billing nor anything of billing in the factory set, for the %s",
    (_role, advanced) => {
      render(
        <CapabilitiesProvider capabilities={FACTORY}>
          <SettingsNav
            workspaceSlug="acme"
            current=""
            showPlan
            showBilling
            showAdvanced={advanced}
          />
        </CapabilitiesProvider>,
      );

      expect(sections()).not.toContain("Billing");
      expect(sections()).toContain("Review defaults");
      expect(sections().includes("Advanced")).toBe(advanced);
    },
  );

  // #731-T06
  it("lists Review defaults only with review, and Billing only with billing", () => {
    const { rerender } = render(
      <CapabilitiesProvider capabilities={[]}>
        <SettingsNav workspaceSlug="acme" current="" showBilling />
      </CapabilitiesProvider>,
    );
    expect(sections()).not.toContain("Review defaults");
    expect(sections()).not.toContain("Billing");

    rerender(
      <CapabilitiesProvider capabilities={["review", "billing"]}>
        <SettingsNav workspaceSlug="acme" current="" showBilling />
      </CapabilitiesProvider>,
    );
    expect(sections()).toContain("Review defaults");
    expect(sections()).toContain("Billing");
  });
});

describe("the admin menu", () => {
  // #731-T06
  it("has no Billing section and no Runs section without those capabilities, and a group never stays empty", () => {
    render(
      <SidebarProvider>
        <CapabilitiesProvider capabilities={FACTORY}>
          <AdminNav />
        </CapabilitiesProvider>
      </SidebarProvider>,
    );

    expect(labels()).not.toContain("Billing");
    expect(labels()).not.toContain("Payment reviews");
    expect(labels()).toContain("Runs");
    expect(labels()).toEqual(
      expect.arrayContaining(["Overview", "Integrations", "Mail", "Catalog"]),
    );
  });

  it("lists the sections of the capabilities it has", () => {
    const names = (set: Capability[]) =>
      adminNavGroupsFor(createCapabilitySet(set)).flatMap((group) =>
        group.items.map((item) => item.label),
      );

    expect(names(["review", "dynamic-review", "billing"])).toContain("Billing");
    expect(names(["review", "billing"])).toContain("Runs");
    expect(names(["billing"])).not.toContain("Runs");
    expect(names([])).toEqual(
      expect.arrayContaining(["Overview", "General", "Mail", "Catalog"]),
    );
  });
});
