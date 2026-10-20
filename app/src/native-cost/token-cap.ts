// SPDX-License-Identifier: Apache-2.0

// The token cap of a run on the workspace's own key (#553): when the price of the model is not known, the dollar limit of
// #540 cannot bind, so the run is bound by the tokens it uses in all (prompt, cache and completion) and by its time. An
// instance setting (`own_key_max_total_tokens`) that the admin changes within bounds; the default is about twice the 1.97M
// prompt tokens of the 55-call Sonnet run measured in #540. A stored value that is not valid reads as the default, never as
// no cap: a damaged setting must not unbind a run. Pure.

export const DEFAULT_OWN_KEY_TOKEN_CAP = 4_000_000;
/** Below this a run cannot finish a review: the prompt of one call can be larger. */
export const MIN_OWN_KEY_TOKEN_CAP = 100_000;
/** Far above any review; the bound only keeps the setting a number the runner and the database hold. */
export const MAX_OWN_KEY_TOKEN_CAP = 100_000_000;

export type TokenCapCheck =
  { ok: true; value: number } | { ok: false; code: "number_out_of_range" };

/** A whole number of tokens within the bounds, or `number_out_of_range`. */
export function checkOwnKeyTokenCap(value: unknown): TokenCapCheck {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_OWN_KEY_TOKEN_CAP ||
    value > MAX_OWN_KEY_TOKEN_CAP
  )
    return { ok: false, code: "number_out_of_range" };
  return { ok: true, value };
}

/** The cap a stored setting stands for: the value when valid, else the default. */
export function ownKeyTokenCapOf(stored: unknown): number {
  const checked = checkOwnKeyTokenCap(stored);
  return checked.ok ? checked.value : DEFAULT_OWN_KEY_TOKEN_CAP;
}
