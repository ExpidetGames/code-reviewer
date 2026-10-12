// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the navigation of the portal: the sections in order, and the current one marked, with
// Overview current only on its own page (every other page of the portal is below /admin).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SectionLinks } from "./admin-nav.tsx";
import { ADMIN_NAV_ITEMS, isCurrentSection } from "./nav-items.ts";

afterEach(cleanup);

describe("the sections of the portal", () => {
  // #98-AD-03
  it("are Overview, Setup, Integrations, Approvals, Mail and Limits, in that order", () => {
    render(<SectionLinks pathname={null} />);

    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(
      ["Overview", "Setup", "Integrations", "Approvals", "Mail", "Limits"],
    );
    expect(
      screen.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).toEqual(ADMIN_NAV_ITEMS.map((item) => item.href));
  });

  it("mark the current section only", () => {
    render(<SectionLinks pathname="/admin/setup" />);

    const current = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual(["Setup"]);
  });

  it("do not mark Overview on the other pages, which are all below /admin", () => {
    const [overview] = ADMIN_NAV_ITEMS;

    expect(isCurrentSection("/admin", overview)).toBe(true);
    expect(isCurrentSection("/admin/mail", overview)).toBe(false);
    expect(isCurrentSection(null, overview)).toBe(false);
  });
});
