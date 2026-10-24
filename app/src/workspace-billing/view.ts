// SPDX-License-Identifier: LicenseRef-Proprietary

// What the billing page of a workspace knows (#505): plain data the server works out and the browser renders. This is the
// boundary between the journal, the profile and the settings and the person looking at them. Amounts are whole micro-USD
// (integers, 1 USD = 1,000,000). Only FINAL prices leave the server: a review's AI price and infrastructure price, never a rate,
// a minute count, the factor A, the cost of our key, a model or a provider (T06). The money of the page is written as text by
// `money.ts`. Free of server code, because client components import it.

/** The journal entries a customer reads. A hold and its release are not among them (src/billing/README.md, "The workspace page"). */
export const JOURNAL_ROW_KINDS = [
  "top_up",
  "start_credit",
  "usage",
  "refund",
  "chargeback",
  "correction",
] as const;
export type JournalRowKind = (typeof JOURNAL_ROW_KINDS)[number];

export type JournalRowView = {
  /** The entry's id: a stable key, nothing else of it. */
  id: string;
  kind: JournalRowKind;
  /** Signed: credit is positive, a charge, a refund and a chargeback are negative. */
  amountMicroUsd: number;
  createdAt: string;
  /** A charge: the run it was for. Null for every other row, and for a run that is gone. */
  run: { id: string; label: string } | null;
  /** A charge: the AI part of the price; null when the review ran on the workspace's own key (no AI price) and for other rows. */
  aiMicroUsd: number | null;
  /** A charge: the infrastructure part of the price; null for other rows. */
  infraMicroUsd: number | null;
};

export type JournalPageView = {
  rows: JournalRowView[];
  /** The cursor of the next page (opaque text), or null on the last page. */
  next: string | null;
};

/** Where the balance stands: reviews start with any positive balance, and are refused at zero and below. */
export const BALANCE_STATES = ["ok", "empty", "negative"] as const;
export type BalanceState = (typeof BALANCE_STATES)[number];

export type PendingTopUpView = {
  id: string;
  amountMicroUsd: number;
  createdAt: string;
  /** "Check payment" can be asked: the adapter can look the payment up and the buyer has a payment page. */
  canCheck: boolean;
};

/** The billing profile as the form holds it (customer data: only an Owner and an Admin ever receive it). */
export type BillingProfileFormView = {
  legalName: string;
  country: string;
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
  city: string;
  vatId: string | null;
  businessConfirmed: boolean;
};

/** Whose key the workspace's reviews run on. `none` is a workspace with no usable key mode (the LLM access page says why). */
export const KEY_MODES = ["managed", "own", "none"] as const;
export type WorkspaceKeyMode = (typeof KEY_MODES)[number];

export type WorkspaceBillingView = {
  /** An Owner or an Admin (`manage_billing`): top up, profile, limit. A Member reads. */
  canManage: boolean;
  balanceMicroUsd: number;
  /** Held by running reviews (a hold of an earlier release, #605); 0 for every review since. */
  heldMicroUsd: number;
  state: BalanceState;
  /** The active adapter has a checkout page. False (the manual adapter): no form, "ask your operator". */
  topUpAvailable: boolean;
  /** The adapter keeps a billing profile (legal name, address, VAT ID) and asks the business to confirm at the first top-up. */
  profileRequired: boolean;
  /** Owner and Admin only; empty for a Member. */
  pendingTopUps: PendingTopUpView[];
  /** Owner and Admin only; null for a Member and for a workspace that has not saved one. */
  profile: BillingProfileFormView | null;
  /** Owner and Admin only. Whole US cents, or null for no limit. */
  monthlyLimitCents: number | null;
  /** Owner and Admin only: this UTC month's actual charges, which the limit is compared with. */
  chargedThisMonthMicroUsd: number | null;
  keyMode: WorkspaceKeyMode;
  journal: JournalPageView;
};

/** What a review cost, as a customer may read it. */
export type RunPriceView =
  /** Charged: the final price in two parts. `aiMicroUsd` is null on the workspace's own key (infrastructure only). */
  | {
      state: "charged";
      aiMicroUsd: number | null;
      infraMicroUsd: number;
    }
  /** The review was settled and nothing was charged (free because of an error on our side, or priced to nothing). */
  | { state: "not_charged" };

/** The statuses an invoice of the list can have; a draft is never listed. */
export const INVOICE_STATUSES = [
  "paid",
  "open",
  "void",
  "uncollectible",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** One invoice of the workspace (Owner and Admin only): what the provider issued, and where to read and keep it. */
export type InvoiceView = {
  /** The provider's id of the invoice: a stable key, nothing else of it. */
  id: string;
  /** The number on the invoice, or null. */
  number: string | null;
  createdAt: string;
  /** Whole cents of `currency` (the provider's own unit). */
  amountMinor: number;
  /** Three lower case letters. */
  currency: string;
  status: InvoiceStatus;
  /** The provider's page of the invoice, and its PDF; null when it gave none. Plain http(s) addresses. */
  viewUrl: string | null;
  downloadUrl: string | null;
};

export type InvoiceListView = { invoices: InvoiceView[] };
