// SPDX-License-Identifier: Apache-2.0

// What the billing routes answer and the billing page shows (#504): plain data, no secret. It lives beside the page, not in
// `src/billing/`, because that module is server-only and a client component may not reach it. The service
// (`src/billing/admin-service.ts`) produces it; the forms read it. Every amount is a whole number of micro-USD, the factor A
// is in parts per 10,000; the page turns them into decimals (`billing-money.ts`).

export const BILLING_ADAPTER_CHOICES = ["manual", "stripe"] as const;
export type BillingAdapterChoice = (typeof BILLING_ADAPTER_CHOICES)[number];

export type StripeEnvironmentView = "test" | "live";

/** A stored credential as the page may know it: whether it is there, never its value. */
export type BillingSecretView =
  | { state: "not_configured" }
  | {
      state: "configured";
      /** The last four characters of a long value, or null. */
      lastFour: string | null;
    }
  | { state: "unreadable" };

/** Each item that keeps billing from being switched on, by its stable code (`src/billing/readiness.ts`). */
export type BillingMissingItemView =
  | "factor_a_missing"
  | "minute_rate_diff_missing"
  | "minute_rate_dynamic_missing"
  | "diff_ai_reserve_missing"
  | "stripe_api_key_missing"
  | "stripe_webhook_secret_missing"
  | "connection_check_missing"
  | "terms_url_missing";

export type BillingView = {
  /** The switch as it is stored. */
  enabled: boolean;
  /** Whether billing is on: the switch is set and the adapter is ready. */
  on: boolean;
  adapter: BillingAdapterChoice;
  /** What keeps billing from being switched on with the adapter in use (empty: nothing). */
  missing: BillingMissingItemView[];
  stripe: {
    apiKey: BillingSecretView;
    webhookSecret: BillingSecretView;
    /** From the prefix of the stored API key; null when no readable key is stored. */
    environment: StripeEnvironmentView | null;
    /** When the connection check last passed, or null. A new API key clears it. */
    checkedAt: string | null;
    /** The endpoint this app created at Stripe, if it did. */
    webhookEndpointId: string | null;
    /** The address Stripe is told to post its events to (the public address of this app plus the route). */
    webhookUrl: string;
    /** Whether Stripe can reach that address (https, not a private or local one). */
    webhookUrlPublic: boolean;
  };
  /** The links to the operator's terms and privacy statement (#626); null while not set. The terms link is needed to run Stripe. */
  legal: {
    termsUrl: string | null;
    privacyUrl: string | null;
  };
  rates: {
    /** Parts per 10,000 (12,000 is 1.2), or null while not set. */
    factorA: number | null;
    diffMinuteRateMicroUsd: number | null;
    dynamicMinuteRateMicroUsd: number | null;
    /** Micro-USD of real model cost, before A. */
    diffAiReserveMicroUsd: number | null;
  };
  /** The numbers with a default: what is in force (the stored value or the default) and whether it is stored. */
  numbers: {
    startCreditMicroUsd: number;
    lowBalanceMicroUsd: number;
    hourlyReviewLimit: number;
    startCreditStored: boolean;
    lowBalanceStored: boolean;
    hourlyReviewLimitStored: boolean;
  };
  /** The facts the enabling statement states. */
  workspaces: number;
  ownKeyWorkspaces: number;
  updatedAt: string | null;
};

/** A workspace of the manual credit's search. */
export type BillingWorkspaceView = { id: string; name: string; slug: string };

export type BillingJournalEntryView = {
  id: string;
  type: string;
  amountMicroUsd: number;
  provider: string | null;
  note: string | null;
  createdAt: string;
};

export type BillingWorkspaceBalanceView = {
  workspace: BillingWorkspaceView;
  balanceMicroUsd: number;
  reservedMicroUsd: number;
  entries: BillingJournalEntryView[];
};
