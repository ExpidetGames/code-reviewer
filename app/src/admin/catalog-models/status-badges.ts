// SPDX-License-Identifier: Apache-2.0

// The tone of each badge of the catalog screens (#554). The tone is never the only signal: every badge carries its words
// (messages.ts). Colours come from the badge variants, which take them from the tokens of theme.css.
import type { PriceStatus } from "../../model-prices/effective-price.ts";
import type { UrlState } from "../../models-dev/upstream-url.ts";
import type { ModelState } from "./messages.ts";

export type BadgeTone = "success" | "warning" | "info" | "neutral" | "danger";

export const STATUS_BADGE: Record<PriceStatus, BadgeTone> = {
  confirmed: "success",
  stale: "warning",
  unconfirmed: "info",
  unpriced: "neutral",
};

export const STATE_BADGE: Record<ModelState, BadgeTone> = {
  new: "info",
  enabled: "success",
  disabled: "neutral",
  undecided: "neutral",
};

export const URL_BADGE: Record<UrlState, BadgeTone> = {
  trusted: "success",
  url_changed: "warning",
  rejected: "danger",
};
