// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// #506: the banner an Owner or an Admin sees on the pages of the workspace while the balance is low, zero or below zero.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BalanceBannerView } from "../banner.ts";
import { BalanceBanner } from "./balance-banner.tsx";

afterEach(cleanup);

const HREF = "/w/acme/settings/billing";
const view = (overrides: Partial<BalanceBannerView>): BalanceBannerView => ({
  level: "low",
  balanceMicroUsd: 3_200_000,
  billingHref: HREF,
  ...overrides,
});

describe("the balance banner", () => {
  // #506-T10
  it("tells a low balance with the amount and a link to the billing page", () => {
    render(<BalanceBanner view={view({})} />);

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Your balance is low");
    expect(banner.textContent).toContain("$3.20");
    expect(
      screen.getByRole("link", { name: "Go to billing" }).getAttribute("href"),
    ).toBe(HREF);
  });

  // #506-T04
  it("tells an empty balance, and that new reviews wait for credit", () => {
    render(
      <BalanceBanner view={view({ level: "empty", balanceMicroUsd: 0 })} />,
    );

    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("No credit left");
    expect(banner.textContent).toContain("New reviews are not started");
    expect(banner.textContent).toContain("$0.00");
  });

  // #506-T05
  it("tells a balance below zero", () => {
    render(
      <BalanceBanner
        view={view({ level: "negative", balanceMicroUsd: -1_500_000 })}
      />,
    );

    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("The balance is below zero");
    expect(banner.textContent).toContain("-$1.50");
  });

  // #506-T07
  it.each(["low", "empty", "negative"] as const)(
    "names no rate, formula, model or provider in the %s state",
    (level) => {
      const { container } = render(<BalanceBanner view={view({ level })} />);

      expect(container.textContent).not.toMatch(
        /\b(rate|rates|factor|formula|model|provider|stripe|brake|minute|minutes)\b/i,
      );
    },
  );
});
