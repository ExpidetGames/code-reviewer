// SPDX-License-Identifier: LicenseRef-Proprietary

// The cost policy of a native job (#553), as the claim hands it to the runner (`dynamic.cost`, `DynamicCostPolicy` in
// contracts/runner-api.v1.json). Pure: the answers of the price service go in, a policy or a refusal comes out.
//
// - **Managed key (we pay).** Only a model that is enabled and has a confirmed price passes (`availability()` of #549, whose
//   refusal code is kept). The confirmed book is the runner's only price source. What makes a model selectable, the
//   completeness of its cache prices included (#569 N4: no cache read is guessed), is defined once, in `availability()`.
// - **Own key (the user pays the provider).** No price blocks anything: the book is the catalog's price when it states one,
//   else none, and the token cap bounds the run once its cost is not known.
import type {
  ManagedAvailabilityJson,
  ManagedRefusalCode,
  ManagedUnavailableReason,
} from "../model-prices/availability.ts";
import type { PriceBookJson } from "../model-prices/price-book.ts";

/** `dynamic.cost` as the contract describes it. */
export type CostPolicyJson =
  | { keyMode: "managed"; priceBook: PriceBookJson; maxTotalTokens: null }
  | { keyMode: "own"; priceBook: PriceBookJson | null; maxTotalTokens: number };

export type ManagedPolicyOutcome =
  | {
      ok: true;
      policy: Extract<CostPolicyJson, { keyMode: "managed" }>;
      /** Which confirmation priced the run: for the log of the claim. */
      confirmation: { id: number; hashVersion: number };
    }
  | {
      ok: false;
      /** The stable code of the refusal. */
      code: ManagedRefusalCode;
      /** The internal reason of the price service (`availability()`): logged, never shown to a member. */
      reason: ManagedUnavailableReason;
    };

export function managedPolicy(
  availability: ManagedAvailabilityJson,
): ManagedPolicyOutcome {
  if (!availability.selectable)
    return {
      ok: false,
      code: availability.code,
      reason: availability.reason,
    };
  return {
    ok: true,
    policy: {
      keyMode: "managed",
      priceBook: availability.book,
      maxTotalTokens: null,
    },
    confirmation: {
      id: availability.confirmationId,
      hashVersion: availability.hashVersion,
    },
  };
}

export function ownPolicy(
  book: PriceBookJson | null,
  maxTotalTokens: number,
): Extract<CostPolicyJson, { keyMode: "own" }> {
  return { keyMode: "own", priceBook: book, maxTotalTokens };
}
