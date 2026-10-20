// SPDX-License-Identifier: Apache-2.0

// The cost policy of a native job (#553), as the claim hands it to the runner (`dynamic.cost`, `DynamicCostPolicy` in
// contracts/runner-api.v1.json). Pure: the answers of the price service go in, a policy or a refusal comes out.
//
// - **Managed key (we pay).** Only a model that is enabled and has a confirmed price passes (`availability()` of #549, whose
//   refusal code is kept). The confirmed book is the runner's only price source. One more rule on the book, the decision
//   on the cache read of #569 N4: a model that sells a cache write has a cache read, and a run that read from the cache would
//   have to be billed at a price nobody confirmed (priced as input, an upper bound, it would overcharge the member). So a
//   book with a cache write and no cache read, at any level, or a level that drops the read the others state, is refused at
//   claim time with `catalog_price_unconfirmed` (reason `cache_read_unpriced`, internal). A model with no cache price at all
//   passes; if its provider reads from the cache anyway, the runner does not guess a price either: the call is unknown and
//   the run ends `dynamic_accounting_failed`, which is free.
// - **Own key (the user pays the provider).** No price blocks anything: the book is the catalog's price when it states one,
//   else none, and the token cap bounds the run once its cost is not known.
import type {
  ManagedAvailabilityJson,
  ManagedRefusalCode,
} from "../model-prices/availability.ts";
import type {
  PriceBookJson,
  PriceLevelJson,
} from "../model-prices/price-book.ts";

/** `dynamic.cost` as the contract describes it. */
export type CostPolicyJson =
  | { keyMode: "managed"; priceBook: PriceBookJson; maxTotalTokens: null }
  | { keyMode: "own"; priceBook: PriceBookJson | null; maxTotalTokens: number };

/** The internal reasons a managed policy is refused besides the ones of the price service (logged, never shown to a member). */
export const POLICY_REFUSAL_REASONS = ["cache_read_unpriced"] as const;

export type ManagedPolicyOutcome =
  | { ok: true; policy: Extract<CostPolicyJson, { keyMode: "managed" }> }
  | {
      ok: false;
      /** The stable code of the refusal. */
      code: ManagedRefusalCode;
      /** The internal reason: the price service's, or one of `POLICY_REFUSAL_REASONS`. */
      reason: string;
    };

function levelsOf(book: PriceBookJson): PriceLevelJson[] {
  return [
    book,
    ...(book.contextOver200k === null ? [] : [book.contextOver200k]),
    ...book.tiers,
  ];
}

/** Whether the book offers a cache read at some level and does not price it at every level that sells a cache write or a read. */
function cacheReadIncomplete(book: PriceBookJson): boolean {
  const levels = levelsOf(book);
  const anyRead = levels.some((level) => level.cacheRead !== null);
  return levels.some(
    (level) =>
      level.cacheRead === null &&
      (anyRead || level.cacheWrite5m !== null || level.cacheWrite1h !== null),
  );
}

export function managedPolicy(
  availability: ManagedAvailabilityJson,
): ManagedPolicyOutcome {
  if (!availability.selectable)
    return {
      ok: false,
      code: availability.code,
      reason: availability.reason,
    };
  if (cacheReadIncomplete(availability.book))
    return {
      ok: false,
      code: "catalog_price_unconfirmed",
      reason: "cache_read_unpriced",
    };
  return {
    ok: true,
    policy: {
      keyMode: "managed",
      priceBook: availability.book,
      maxTotalTokens: null,
    },
  };
}

export function ownPolicy(
  book: PriceBookJson | null,
  maxTotalTokens: number,
): Extract<CostPolicyJson, { keyMode: "own" }> {
  return { keyMode: "own", priceBook: book, maxTotalTokens };
}
