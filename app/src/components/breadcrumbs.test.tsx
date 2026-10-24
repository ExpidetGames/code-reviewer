// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins the shared breadcrumbs wrapper (#179): one navigation landmark named "breadcrumb", a link for
// every ancestor, and only the last crumb marked as the current page without a link. An earlier crumb
// without an `href` stays plain text and is not marked as the current page.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Breadcrumbs } from "./breadcrumbs.tsx";

afterEach(cleanup);

describe("the breadcrumbs", () => {
  it("links the ancestors and marks the last crumb as the current page", () => {
    render(
      <Breadcrumbs
        items={[
          { label: "Projects", href: "/w/acme/projects" },
          { label: "acme/widgets" },
        ]}
      />,
    );

    const nav = screen.getByRole("navigation", { name: "breadcrumb" });
    const ancestor = within(nav).getByRole("link", { name: "Projects" });
    expect(ancestor.getAttribute("href")).toBe("/w/acme/projects");
    const current = within(nav).getByText("acme/widgets");
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.closest("a")).toBeNull();
  });

  it("marks only the last crumb as the current page", () => {
    render(
      <Breadcrumbs
        items={[{ label: "Projects" }, { label: "acme/widgets" }]}
      />,
    );

    const nav = screen.getByRole("navigation", { name: "breadcrumb" });
    const first = within(nav).getByText("Projects");
    expect(first.getAttribute("aria-current")).toBeNull();
    expect(first.closest("a")).toBeNull();
    expect(
      within(nav).getByText("acme/widgets").getAttribute("aria-current"),
    ).toBe("page");
  });

  it("renders a single current crumb without a trail", () => {
    render(<Breadcrumbs items={[{ label: "Account" }]} />);

    const nav = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(nav).getByText("Account").getAttribute("aria-current")).toBe(
      "page",
    );
  });
});
