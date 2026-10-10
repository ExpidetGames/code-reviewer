// The estimated cost of one review with the model (and the fallback model), and the warnings of the
// cost guard (src/review-settings/cost.ts): above the customer's limit, a model without a known
// price, a token budget that does not fit the model's context window. Warnings advise, they never
// block a save. Model names are typed by people, so they are rendered as text like everything else.
import {
  REVIEW_COST_LIMIT_USD,
  type ModelCostEstimate,
  type ReviewCostGuard,
} from "../cost.ts";

export function formatUsd(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : 3)}`;
}

const LIMIT_TEXT = `$${REVIEW_COST_LIMIT_USD.toFixed(2)}`;

function Estimate({
  label,
  estimate,
}: {
  label: string;
  estimate: ModelCostEstimate;
}) {
  return (
    <li>
      {label} <span className="mono">{estimate.model}</span>:{" "}
      {estimate.status === "estimated" ? (
        <>
          about {formatUsd(estimate.usd)}, at most{" "}
          {formatUsd(estimate.upperUsd)}
        </>
      ) : (
        <span className="muted">cannot be estimated</span>
      )}
    </li>
  );
}

function modelOf(cost: ReviewCostGuard, which: "primary" | "fallback") {
  return which === "primary" ? cost.primary.model : cost.fallback?.model;
}

function whichText(which: "primary" | "fallback"): string {
  return which === "primary" ? "model" : "fallback model";
}

export function CostSummary({ cost }: { cost: ReviewCostGuard | null }) {
  if (cost === null)
    return (
      <div className="cost-summary">
        <p className="muted">
          The estimated cost per review shows after the marked values are fixed.
        </p>
      </div>
    );
  return (
    <div className="cost-summary">
      <p>
        <strong>Estimated cost per review</strong> (a large pull request; the
        limit is {LIMIT_TEXT}):
      </p>
      <ul>
        <Estimate label="Model" estimate={cost.primary} />
        {cost.fallback !== null ? (
          <Estimate label="Fallback model" estimate={cost.fallback} />
        ) : null}
      </ul>
      {cost.warnings.map((warning) => (
        <div
          key={`${warning.model}-${warning.kind}`}
          role="status"
          className="alert alert-warning"
        >
          {warning.kind === "above_limit" ? (
            <>
              The estimated cost of the {whichText(warning.model)}{" "}
              <span className="mono">{modelOf(cost, warning.model)}</span> is
              above the limit of {LIMIT_TEXT} per review. You can still save it.
            </>
          ) : (
            <>
              No price is known for{" "}
              <span className="mono">{modelOf(cost, warning.model)}</span>, so
              its cost cannot be estimated.
            </>
          )}
        </div>
      ))}
      {cost.exceedsContext.map((which) => (
        <div
          key={`context-${which}`}
          role="status"
          className="alert alert-warning"
        >
          The token budget is larger than the context window of the{" "}
          {whichText(which)}{" "}
          <span className="mono">{modelOf(cost, which)}</span>. Reviews with it
          would fail.
        </div>
      ))}
    </div>
  );
}
