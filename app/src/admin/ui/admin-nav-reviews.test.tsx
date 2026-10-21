// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down how the navigation of the portal shows the billing review rows (#603): a Payment reviews page below Billing, and the
// number of open rows on the Billing entry and on that page's entry, so a payment that was taken and not credited is seen
// without opening the list. Nothing is shown while no row is open.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";

const navigation = vi.hoisted(() => ({ pathname: "/admin" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

import { AdminNav } from "./admin-nav.tsx";

afterEach(() => {
  cleanup();
  navigation.pathname = "/admin";
});

function renderNav(reviewCount?: number) {
  render(
    <SidebarProvider>
      <AdminNav {...(reviewCount === undefined ? {} : { reviewCount })} />
    </SidebarProvider>,
  );
  return screen.getByRole("navigation", { name: "Admin" });
}

describe("the billing entries of the navigation", () => {
  // #603-T17
  it("link the Payment reviews page below Billing", () => {
    const nav = renderNav();

    const link = nav.querySelector('a[href="/admin/billing/reviews"]');
    expect(link?.textContent).toBe("Payment reviews");
    expect(link?.closest('[data-slot="sidebar-menu-sub"]')).not.toBeNull();
  });

  // #603-T17
  it("show the number of open rows on Billing and on Payment reviews, and say it in words", () => {
    const nav = renderNav(3);

    expect(
      screen.getByRole("link", { name: "Billing, 3 open payment reviews" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", {
        name: "Payment reviews, 3 open payment reviews",
      }),
    ).toBeTruthy();
    expect(nav.querySelectorAll('[data-slot="badge"]').length).toBe(2);
  });

  // #603-T17
  it("show nothing while no row is open", () => {
    const nav = renderNav(0);

    expect(nav.querySelectorAll('[data-slot="badge"]').length).toBe(0);
    expect(screen.getByRole("link", { name: "Billing" })).toBeTruthy();
  });

  // #603-T17
  it("mark Payment reviews and not Billing on the reviews page", () => {
    navigation.pathname = "/admin/billing/reviews";
    const nav = renderNav();

    expect(
      Array.from(nav.querySelectorAll("a"))
        .filter((link) => link.getAttribute("aria-current") === "page")
        .map((link) => link.textContent),
    ).toEqual(["Payment reviews"]);
  });
});
