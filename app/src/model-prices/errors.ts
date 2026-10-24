// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable codes the price confirmation answers with when a request is refused (#549). The admin portal translates them
// to copy (#554); nothing branches on a message. A code never contains a model id, a price or a provider answer.

export const MODEL_PRICE_ERROR_CODES = [
  /** Not the documented shape: a missing or unknown field, a field of the wrong type. */
  "request_invalid",
  /** The catalog has no such model. */
  "model_unknown",
  /** The override file blocks the model, so it cannot be enabled. */
  "model_blocked",
  /** The price is not a price book: a negative or non-integer amount, one above the sanity bound, a tier that goes backwards. */
  "price_invalid",
  /** Confirm as shown was asked for a model whose price the catalog does not state; the admin has to state it. */
  "price_missing",
  /** The catalog's price is not the one the admin saw (it changed meanwhile); nothing was written, read it again. */
  "price_changed",
  /** A correction needs a reason of one to 500 printable characters on one line. */
  "reason_invalid",
  /** The daily fetch holds the provider's lock for longer than the confirmation waits (5 seconds); nothing was written, try again. */
  "fetch_in_progress",
] as const;
export type ModelPriceErrorCode = (typeof MODEL_PRICE_ERROR_CODES)[number];

export const MODEL_PRICE_ERROR_STATUS: Record<ModelPriceErrorCode, number> = {
  request_invalid: 422,
  model_unknown: 404,
  model_blocked: 409,
  price_invalid: 422,
  price_missing: 409,
  price_changed: 409,
  reason_invalid: 422,
  fetch_in_progress: 409,
};
