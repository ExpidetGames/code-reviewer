// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the banner of the admin portal while billing is switched on but its setup is not complete (#632): every review of
// the instance is refused then, so the operator must see it on every admin page, with what is missing and where to fix it, and
// never while billing is off or running.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BillingIncompleteBanner } from "./billing-incomplete-banner.tsx";

afterEach(cleanup);

describe("the banner of an incomplete billing setup", () => {
  // #632-T06
  it("says that every review is refused, names what is missing and links to the Billing page", () => {
    render(<BillingIncompleteBanner missing={["terms_url_missing"]} />);

    const banner = screen.getByRole("region", {
      name: /Billing is switched on but not complete/,
    });
    expect(banner.textContent).toMatch(/every review is refused/i);
    expect(
      within(banner)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["The link to your terms"]);
    expect(
      within(banner)
        .getByRole("link", { name: /Billing/ })
        .getAttribute("href"),
    ).toBe("/admin/billing");
  });

  // #632-T06
  it("lists every missing item in the order it is given", () => {
    render(
      <BillingIncompleteBanner
        missing={["factor_a_missing", "connection_check_missing"]}
      />,
    );

    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(["The factor A", "A passing connection check"]);
  });

  // #632-T06
  it("shows nothing while nothing is missing", () => {
    const { container } = render(<BillingIncompleteBanner missing={[]} />);

    expect(container.textContent).toBe("");
  });
});
