// SPDX-License-Identifier: Apache-2.0

// What a review cost, as the Runs list and the run detail say it (ADR 0006, 2.5; #505): the final AI price and the final
// infrastructure price, nothing else. A review on the workspace's own key has the infrastructure price alone, and a review that
// was settled and charged nothing is "Not charged". No rate, no minute count, no formula and no real cost of our key is ever
// written here: the component only receives the two final prices.
import { formatPrice } from "../money.ts";
import type { RunPriceView } from "../view.ts";

export const NOT_CHARGED_TEXT = "Not charged";

export function RunPriceText({ price }: { price: RunPriceView }) {
  if (price.state === "not_charged")
    return <span className="text-muted-foreground">{NOT_CHARGED_TEXT}</span>;
  return (
    <span data-slot="run-price" className="flex flex-col">
      {price.aiMicroUsd === null ? null : (
        <span>
          <span className="text-muted-foreground">AI</span>{" "}
          <span className="tabular-nums">{formatPrice(price.aiMicroUsd)}</span>
        </span>
      )}
      <span>
        <span className="text-muted-foreground">Infrastructure</span>{" "}
        <span className="tabular-nums">{formatPrice(price.infraMicroUsd)}</span>
      </span>
    </span>
  );
}
