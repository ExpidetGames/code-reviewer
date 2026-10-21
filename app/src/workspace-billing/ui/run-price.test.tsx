// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// #505: how the price of a review reads on the Runs pages. Two final prices for a managed review, the infrastructure price alone
// for a review on the workspace's own key, "Not charged" for a free one, and never a rate, a minute count or a formula.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunPriceText } from "./run-price.tsx";

afterEach(cleanup);

describe("the price of a review", () => {
  // #505-T05
  it("names the AI price and the infrastructure price", () => {
    render(
      <RunPriceText
        price={{ state: "charged", aiMicroUsd: 1_500_000, infraMicroUsd: 130_000 }}
      />,
    );

    expect(screen.getByText("AI")).toBeTruthy();
    expect(screen.getByText("$1.50")).toBeTruthy();
    expect(screen.getByText("Infrastructure")).toBeTruthy();
    expect(screen.getByText("$0.13")).toBeTruthy();
  });

  // #505-T07
  it("shows only the infrastructure price on the workspace's own key", () => {
    render(
      <RunPriceText
        price={{ state: "charged", aiMicroUsd: null, infraMicroUsd: 260_000 }}
      />,
    );

    expect(screen.queryByText("AI")).toBeNull();
    expect(screen.getByText("Infrastructure")).toBeTruthy();
    expect(screen.getByText("$0.26")).toBeTruthy();
  });

  // #505-T05
  it("says Not charged for a free review", () => {
    render(<RunPriceText price={{ state: "not_charged" }} />);

    expect(screen.getByText("Not charged")).toBeTruthy();
  });
});
