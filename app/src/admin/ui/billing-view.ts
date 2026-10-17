// SPDX-License-Identifier: Apache-2.0

// What the billing settings route answers and the billing page shows (#437): plain data, no secret. It lives
// beside the page, not in `src/billing/`, because that module is server-only and a client component may not reach
// it. The service (`src/billing/settings-service.ts`) produces it; the form (`billing-form.tsx`) reads it.

export const BILLING_ENVIRONMENTS = ["sandbox", "live"] as const;
export type BillingEnvironment = (typeof BILLING_ENVIRONMENTS)[number];

/** A stored Paddle credential as the page may know it: whether it is there, never its value. */
export type BillingSecretView =
  | { state: "not_configured" }
  | {
      state: "configured";
      /** The last four characters of a long value, or null. */
      lastFour: string | null;
    }
  | { state: "unreadable" };

export type BillingView = {
  environment: BillingEnvironment;
  /** Paddle's client-side token: public by design, so the page may show it. */
  clientToken: string;
  graceDays: number;
  enabled: boolean;
  apiKey: BillingSecretView;
  webhookSecret: BillingSecretView;
  /**
   * The workspaces that hold a stored own key and would stop reviewing on it once billing is on (their key mode
   * becomes the one of the Free plan, which is managed; a workspace with an entitlements row of the operator is
   * not counted).
   */
  ownKeyWorkspaces: number;
  updatedAt: string | null;
};
