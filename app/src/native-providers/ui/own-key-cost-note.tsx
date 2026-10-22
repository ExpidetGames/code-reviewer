// SPDX-License-Identifier: Apache-2.0

// What a run on the workspace's own key costs and what bounds it (#555, #553): the explanation under the model picker. The
// provider bills the workspace's own account. With a listed price the cost limit of a run applies as before and the token cap
// bounds it as well; with none, the dollar limit cannot bind, so the run is bound by the token cap and the time limit and the
// cost limit does not apply. With billing on, a run on the own key is charged for infrastructure minutes only: no rate and no
// formula (#496, #505). The price is models.dev's, and says so.
import type { NativeModelPrice } from "../catalog.ts";

function priceText(price: NativeModelPrice): string {
  return `$${price.inputPerMillion} in / $${price.outputPerMillion} out per million tokens`;
}

export function OwnKeyCostNote({
  price,
  tokenCap,
  billingOn,
}: {
  /** The listed price of the chosen model, or null when none is listed (or the model is not in the catalog now). */
  price: NativeModelPrice | null;
  /** The token cap of a run on an own key (the instance setting); a member sees the cap, never a price of ours. */
  tokenCap: number;
  /** Whether billing is on for this instance. */
  billingOn: boolean;
}) {
  const cap = tokenCap.toLocaleString("en-US");
  return (
    <div
      data-testid="cost-note"
      className="flex flex-col gap-1 rounded-xl border border-border bg-background p-4 text-sm"
    >
      {price === null ? (
        <p>
          No price is listed for this model, so a run is bounded by a token cap
          of {cap} tokens (prompt, cache and completion tokens in all) and by
          the time limit. The cost limit does not apply to it.
        </p>
      ) : (
        <p>
          Listed price: {priceText(price)} (as listed by models.dev). A run
          stops at its cost limit, and a token cap of {cap} tokens bounds it as
          well.
        </p>
      )}
      <p className="text-muted-foreground">
        The provider bills your own account for the AI.
        {billingOn
          ? " Runs on your own key are charged for infrastructure minutes only."
          : ""}
      </p>
    </div>
  );
}
