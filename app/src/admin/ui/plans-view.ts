// SPDX-License-Identifier: Apache-2.0

// What the plans route answers and the plans page shows (#438): plain data. It lives beside the page, not in
// `src/billing/`, because that module is server-only and a client component may not reach it. The service
// (`src/billing/plans-service.ts`) produces it; the form (`plans-form.tsx`) reads it. Money is always an integer in
// minor units (USD cents); the page turns it into text with `plan-money.ts`.
import type {
  EntitlementLimits,
  KeyMode,
  ModelAccess,
} from "../../workspaces/entitlements.ts";

/** `free` is the one seeded Free plan, `paid` is sold through a checkout, `contact` is the Enterprise call to action. */
export const PLAN_KINDS = ["free", "paid", "contact"] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

/** `current` is what a new subscriber gets; `legacy` stays for the subscribers who bought it. */
export const PLAN_VERSION_ROLES = ["current", "legacy"] as const;
export type PlanVersionRole = (typeof PLAN_VERSION_ROLES)[number];

/** The fields of a plan that are edited in place (no new version). */
export type PlanMetadata = {
  name: string;
  description: string;
  /** The display order of the plan screen, ascending; ties go by plan key. */
  sort: number;
  offered: boolean;
  /** The "Popular" badge: at most one plan has it, and only a paid plan. */
  popular: boolean;
  /** An https link or a `mailto:` address behind the "Contact us" button; kind `contact` only. */
  contactTarget: string | null;
};

/** What makes a version: saving a change of any of it creates the next version. */
export type PlanTerms = {
  keyMode: KeyMode;
  limits: EntitlementLimits;
  /** `null` for an `own` version (it has none); an object for `managed`, where `catalogEntries: null` is every released entry. */
  modelAccess: ModelAccess | null;
  /** USD minor units, tax inclusive; a paid plan only. */
  monthlyAmountMinor: number | null;
  /** USD minor units; `null` is no yearly option. An amount, never a percentage. */
  yearlyAmountMinor: number | null;
};

/**
 * A Paddle price linked to a slot of a version (#439), as Paddle last said it (`snapshotAt`): shown read-only next to the
 * amount the operator entered, which belongs to the version. Amounts are Paddle's own strings of minor units.
 */
export type PriceLinkView = {
  paddlePriceId: string;
  interval: string;
  frequency: number;
  currency: string;
  taxMode: string;
  amount: string;
  status: string;
  /** The trial in days, as the price has it at Paddle; the app sets none on a linked price. */
  trialDays: number | null;
  snapshotAt: string | null;
  /**
   * The rule the cached price breaks now (`price_not_active`, `price_amount_mismatch`, `price_environment_mismatch`, ...),
   * or null when it is exactly the price of its slot. A drift blocks offering; it is never fixed by changing Paddle.
   */
  drift: string | null;
  /** For a drift that has two values (an amount, a currency, an interval, a tax mode): the entered one and Paddle's. */
  driftEntered?: string;
  driftPaddle?: string;
};

/**
 * An attempt to create a Paddle price through the app (#440) that no version is sold with: one that is still running
 * (`pending`), one that failed (`failed`, with its code; the next "Create prices" retries it), or a price that was created but
 * could not be linked, for example because the plan was saved again meanwhile (`ready` with a Paddle price id: an orphan the
 * operator can archive). Linked attempts are not listed; their price is on the version.
 */
export type PriceAttemptView = {
  /** `month` or `year`. */
  interval: string;
  /** The amount the attempt asked for, minor units as text. */
  amount: string;
  trialDays: number | null;
  state: "pending" | "failed" | "ready";
  /** The stable code of the last failure; null unless the attempt failed. */
  errorCode: string | null;
  /** The price Paddle made for it; null while it has none. */
  paddlePriceId: string | null;
  /** When the app last started on it. */
  attemptedAt: string | null;
};

export type PlanVersionView = PlanTerms & {
  number: number;
  role: PlanVersionRole;
  createdAt: string;
  /** The price the monthly slot is sold with; null until one is linked. Paid plans only. */
  monthlyPrice: PriceLinkView | null;
  /** The price of the yearly slot; null until linked, and always null on a version without a yearly amount. */
  yearlyPrice: PriceLinkView | null;
  /**
   * Whether the version can be sold: every slot it has an entered amount for is linked to a price that is exactly that
   * price now (no drift). A version without a yearly amount needs no yearly price.
   */
  sellable: boolean;
};

export type PlanView = PlanMetadata & {
  planKey: string;
  kind: PlanKind;
  archived: boolean;
  /** The Paddle product the plan's prices belong to: set by the first price that is linked (#439). */
  paddleProductId: string | null;
  /** Newest first. Empty for a `contact` plan. */
  versions: PlanVersionView[];
  /** Attempts to create a price that no version is sold with (#440), oldest first. */
  priceAttempts: PriceAttemptView[];
};

/** A catalog entry as the instance admin picks it for `modelAccess`: the member-facing name and the admin's own view. */
export type CatalogChoice = {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  status: string;
};

export const PLAN_WARNINGS = ["own_key_workspaces_without_own_plan"] as const;
export type PlanWarning = (typeof PLAN_WARNINGS)[number];

export type PlansView = {
  /** In display order: ascending by `sort`, ties by plan key. */
  plans: PlanView[];
  catalog: CatalogChoice[];
  /** The workspaces that hold a stored own key and have no entitlements row of the operator. */
  ownKeyWorkspaces: number;
  warnings: PlanWarning[];
};
