// SPDX-License-Identifier: Apache-2.0

// What a run consumed, as the facts of the Runs pages say it (the detail page of a workspace and the job view of
// the admin portal): the model, the tokens and calls, the cost (not on a managed quality level, #283) and why a
// Dynamic Review stopped early. Plain data in, rows for a description list out; no state, so a server component
// can use it.
import type { StoppedEarly } from "../../runner-api/contract.ts";
import type { RunDetailView } from "../run-view.ts";

const COST = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const COUNT = new Intl.NumberFormat("en-US");
/** The smallest cost the display can tell from zero; a real cost below it must not read as $0. */
const COST_PRECISION = 0.0001;

function costText(costUsd: number): string {
  return costUsd > 0 && costUsd < COST_PRECISION
    ? `Less than ${COST.format(COST_PRECISION)}`
    : COST.format(costUsd);
}

/** What a Dynamic Review that was wrapped up at a limit says about itself (#293). */
export const STOPPED_EARLY_TEXT: Record<StoppedEarly, string> = {
  cost_limit:
    "The review reached the cost limit and was wrapped up; it may be incomplete.",
  time_limit:
    "The review reached its time limit and was wrapped up; it may be incomplete.",
};

/** The model, tokens, calls and cost the runner reported; a text from outside is rendered as text. */
export function usageItems(run: Pick<RunDetailView, "usage" | "costHidden">) {
  const usage = run.usage;
  if (usage === null) return { model: [], consumption: [] };
  const calls = usage.aiCalls === 1 ? "model call" : "model calls";
  return {
    model:
      usage.model === null
        ? []
        : [
            {
              term: "Model",
              description: (
                <span data-slot="run-model" className="break-words">
                  {usage.model}
                </span>
              ),
            },
          ],
    consumption: [
      {
        term: "Usage",
        description: `${COUNT.format(usage.totalTokens)} tokens in ${COUNT.format(usage.aiCalls)} ${calls}`,
      },
      // A run on a managed quality level shows no cost: with the tokens it would tell the model (#283).
      ...(run.costHidden
        ? []
        : [
            {
              term: "Cost",
              description:
                usage.costUsd === null ? (
                  <span className="text-muted-foreground">Not available</span>
                ) : (
                  costText(usage.costUsd)
                ),
            },
          ]),
      ...(usage.stoppedEarly === null
        ? []
        : [
            {
              term: "Stopped early",
              description: STOPPED_EARLY_TEXT[usage.stoppedEarly],
            },
          ]),
    ],
  };
}
