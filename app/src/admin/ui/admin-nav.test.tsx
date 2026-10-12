// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the navigation of the portal on the shadcn Sidebar: the grouped sections in order, and
// the current one marked, with Overview current only on its own page (every other page of the portal
// is below /admin).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";

const navigation = vi.hoisted(() => ({ pathname: "/admin/setup" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

import { AdminNav } from "./admin-nav.tsx";
import { ADMIN_NAV_ITEMS, isCurrentSection } from "./nav-items.ts";

afterEach(() => {
  cleanup();
  navigation.pathname = "/admin/setup";
});

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
      "Setup",
      "Limits",
      "Integrations",
      "Mail",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      ADMIN_NAV_ITEMS.map((item) => item.href),
    );
    expect(
      links
        .filter((link) => link.getAttribute("aria-current") === "page")
        .map((link) => link.textContent),
    ).toEqual(["Setup"]);
  });

  it("do not mark Overview on the other pages, which are all below /admin", () => {
    const [overview] = ADMIN_NAV_ITEMS;

    expect(isCurrentSection("/admin", overview)).toBe(true);
    expect(isCurrentSection("/admin/mail", overview)).toBe(false);
    expect(isCurrentSection(null, overview)).toBe(false);
  });
});
