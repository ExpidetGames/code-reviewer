// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the navigation of the portal on the shadcn Sidebar: the grouped sections in order, the
// current one marked (Overview only on its own page, every other page of the portal is below
// /admin), and the narrow-screen drawer that opens the same sections.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

const navigation = vi.hoisted(() => ({ pathname: "/admin/setup/instance" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

import { AdminNav } from "./admin-nav.tsx";
import { ADMIN_NAV_ITEMS, isCurrentSection } from "./nav-items.ts";

// The shim of the setup file (matchMedia always "desktop"); a narrow-screen test replaces it and
// this puts it back.
const desktopMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = desktopMatchMedia;
  cleanup();
  navigation.pathname = "/admin/setup/instance";
});

function narrowScreen() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("767px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function renderAdminNav() {
  return render(
    <SidebarProvider>
      <AdminNav />
    </SidebarProvider>,
  );
}

describe("the sections of the portal", () => {
  // #168-T02
  it("are grouped and in order, and mark only the current one", () => {
    renderAdminNav();

    const nav = screen.getByRole("navigation", { name: "Admin" });
    const groups = Array.from(
      nav.querySelectorAll('[data-slot="sidebar-group"]'),
    );
    expect(
      groups.map(
        (group) =>
          group.querySelector('[data-slot="sidebar-group-label"]')?.textContent,
      ),
    ).toEqual(["Admin", "Setup", "Integrations"]);

    const links = Array.from(nav.querySelectorAll("a"));
    expect(links.map((link) => link.textContent)).toEqual([
      "Overview",
      "Approvals",
      "Runs",
      "Instance",
      "Sign-up",
      "Sign-in",
      "Integrations",
      "GitHub App",
      "Mail",
      "LLM keys",
      "Catalog",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      ADMIN_NAV_ITEMS.map((item) => item.href),
    );
    expect(
      links
        .filter((link) => link.getAttribute("aria-current") === "page")
        .map((link) => link.textContent),
    ).toEqual(["Instance"]);
  });

  // #491-T08
  it("has no Billing section until the new billing admin page exists", () => {
    expect(ADMIN_NAV_ITEMS.map((item) => item.label)).not.toContain("Billing");
    expect(
      ADMIN_NAV_ITEMS.filter((item) => /billing/i.test(item.href)),
    ).toEqual([]);
  });

  // #185: the nested GitHub App page under Integrations (#182 lead note).
  it("marks the nested GitHub App page and not the Integrations index", () => {
    navigation.pathname = "/admin/integrations/github";
    renderAdminNav();

    const nav = screen.getByRole("navigation", { name: "Admin" });
    const links = Array.from(nav.querySelectorAll("a"));
    expect(
      links
        .filter((link) => link.getAttribute("aria-current") === "page")
        .map((link) => link.textContent),
    ).toEqual(["GitHub App"]);
    expect(nav.querySelectorAll('[data-slot="sidebar-menu-sub"]').length).toBe(
      1,
    );
  });

  it("do not mark Overview on the other pages, which are all below /admin", () => {
    const [overview] = ADMIN_NAV_ITEMS;

    expect(isCurrentSection("/admin", overview)).toBe(true);
    expect(isCurrentSection("/admin/mail", overview)).toBe(false);
    expect(isCurrentSection(null, overview)).toBe(false);
  });
});

describe("the sections on a narrow screen", () => {
  // #168-T02, #168-T05
  it("open in the Sheet drawer from the trigger", async () => {
    const user = userEvent.setup();
    narrowScreen();
    render(
      <SidebarProvider>
        <AdminNav />
        <SidebarTrigger className="size-11" />
      </SidebarProvider>,
    );
    expect(screen.queryByRole("navigation", { name: "Admin" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Toggle Sidebar" }));

    const nav = screen.getByRole("navigation", { name: "Admin" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual([
      "Overview",
      "Approvals",
      "Runs",
      "Instance",
      "Sign-up",
      "Sign-in",
      "Integrations",
      "GitHub App",
      "Mail",
      "LLM keys",
      "Catalog",
    ]);
  });
});
