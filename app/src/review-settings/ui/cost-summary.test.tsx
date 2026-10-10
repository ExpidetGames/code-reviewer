// @vitest-environment jsdom
// Pins down how the estimated cost of a review is shown: the amount for the model (and the fallback
// model), a warning above the customer's limit of 0.10 USD, a warning for a model without a known
// price, and a warning when the token budget does not fit the model's context window. A warning
// advises; it never blocks anything.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { estimateReviewCost } from "../cost.ts";
import { builtInReviewSettings } from "../settings.ts";
import { CostSummary, formatUsd } from "./cost-summary.tsx";

afterEach(cleanup);

const base = builtInReviewSettings("anthropic/claude-haiku-5.5");

describe("the cost summary", () => {
  // CR-34-T05
  it("shows the estimate of the default model without a warning", () => {
    const cost = estimateReviewCost(base);
    render(<CostSummary cost={cost} />);
    if (cost.primary.status !== "estimated") throw new Error("price expected");

    expect(screen.getByText(/Estimated cost per review/)).toBeTruthy();
    expect(screen.getByRole("list").textContent).toContain(
      formatUsd(cost.primary.usd),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("warns above_limit for a model that is estimated above the limit, naming the model and the limit", () => {
    render(
      <CostSummary
        cost={estimateReviewCost({
          ...base,
          model: "anthropic/claude-sonnet-5.5",
        })}
      />,
    );

    const warning = screen.getByRole("status");
    expect(warning.textContent).toContain("anthropic/claude-sonnet-5.5");
    expect(warning.textContent).toContain("$0.10");
    expect(warning.textContent).toMatch(/above the limit/i);
  });

  it("warns cost_unknown for a model the price table does not know", () => {
    render(
      <CostSummary
        cost={estimateReviewCost({ ...base, model: "acme/mystery-1" })}
      />,
    );

    expect(screen.getByRole("status").textContent).toMatch(
      /No price is known for acme\/mystery-1/,
    );
    expect(screen.getAllByText(/cannot be estimated/)).toHaveLength(2);
  });

  it("lists the fallback model as not used yet, with no estimate and no cost warning", () => {
    render(
      <CostSummary
        cost={estimateReviewCost({
          ...base,
          fallbackModel: "anthropic/claude-sonnet-5.5",
        })}
      />,
    );

    expect(screen.getByText(/not used yet, so not counted/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("gives an unknown fallback model no warning either", () => {
    render(
      <CostSummary
        cost={estimateReviewCost({ ...base, fallbackModel: "acme/mystery-1" })}
      />,
    );

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("warns when the token budget is larger than the context window of the model", () => {
    render(
      <CostSummary
        cost={estimateReviewCost({
          ...base,
          model: "deepseek/deepseek-v3.2",
          maxTokens: 500_000,
        })}
      />,
    );

    const warning = screen.getByRole("status").textContent;
    expect(warning).toMatch(/context window/);
    expect(warning).toMatch(/Saving is refused/);
  });

  it("still warns when the fallback model's context window is too small, because the save is refused for it too", () => {
    render(
      <CostSummary
        cost={estimateReviewCost({
          ...base,
          fallbackModel: "deepseek/deepseek-v3.2",
          maxTokens: 500_000,
        })}
      />,
    );

    expect(screen.getByRole("status").textContent).toMatch(/fallback model/);
  });

  it("renders a model name with HTML as text", () => {
    const { container } = render(
      <CostSummary cost={estimateReviewCost({ ...base, model: "<b>x</b>" })} />,
    );

    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<b>x</b>");
  });

  it("shows nothing about the cost while the values are wrong", () => {
    const { container } = render(<CostSummary cost={null} />);

    expect(container.textContent).toMatch(/after the marked values are fixed/i);
  });
});

describe("a dollar amount", () => {
  it("keeps four decimals for fractions of a cent and three above", () => {
    expect(formatUsd(0.006)).toBe("$0.0060");
    expect(formatUsd(0.114)).toBe("$0.114");
    expect(formatUsd(0.1)).toBe("$0.100");
  });
});
