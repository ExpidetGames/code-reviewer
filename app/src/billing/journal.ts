// SPDX-License-Identifier: Apache-2.0

// The vocabulary of the balance journal (ADR 0006, 2.7; #495): the entry types, the sign each one carries, the stable
// error codes, and the rules an entry satisfies before it is written. Money is an integer in micro-USD (millionths of a
// US dollar), never a float. The table checks of `20261019150000_create_billing_journal` restate the type and sign rules
// in SQL (a check cannot take bound values, and a migration does not import app code that may change later);
// `journal.test.ts` fails when the two drift apart.
import "server-only";
import type { ProjectReviewKind } from "../review-settings/settings.ts";

/** What can happen to a balance. The one set the table check, the repository and the types share. */
export const BILLING_ENTRY_TYPES = [
  "top_up",
  "start_credit",
  "reservation",
  "usage",
  "release",
  "refund",
  "chargeback",
  "correction",
] as const;

export type BillingEntryType = (typeof BILLING_ENTRY_TYPES)[number];

/** The sign an amount of each type has; a `correction` is either (never zero: no entry changes nothing). */
export const ENTRY_SIGNS = {
  top_up: "positive",
  start_credit: "positive",
  release: "positive",
  reservation: "negative",
  usage: "negative",
  refund: "negative",
  chargeback: "negative",
  correction: "either",
} as const satisfies Record<
  BillingEntryType,
  "positive" | "negative" | "either"
>;

/** The types that belong to one job: they carry its id, and the id is their key (D14). */
export const JOB_ENTRY_TYPES = ["reservation", "usage", "release"] as const;

/**
 * What a caller of the repository branches on. `invalid_entry`, `idempotency_conflict` and `already_reversed` are
 * thrown (the caller has a bug or a replay with other numbers); the rest come back as the answer of `reserve`,
 * `settle` and `release`.
 */
export const BILLING_JOURNAL_ERROR_CODES = [
  "invalid_entry",
  "idempotency_conflict",
  "already_reversed",
  "reversed_entry_not_found",
  "reservation_required",
  "reservation_not_found",
  "job_already_released",
  "insufficient_balance",
  "balance_negative",
] as const;

export type BillingJournalErrorCode =
  (typeof BILLING_JOURNAL_ERROR_CODES)[number];

/** Why `reserve` refuses: the balance is below the hold, or below zero (a refund or chargeback took it there: the workspace is blocked). */
export type ReserveRefusal = Extract<
  BillingJournalErrorCode,
  "insufficient_balance" | "balance_negative"
>;

export class BillingJournalError extends Error {
  readonly code: BillingJournalErrorCode;

  constructor(code: BillingJournalErrorCode, message: string) {
    super(message);
    this.name = "BillingJournalError";
    this.code = code;
  }
}

/** An entry to append. `refKey` is the job id or the provider reference (D14); a job entry may leave it out. */
export type NewJournalEntry = {
  type: BillingEntryType;
  /** Signed, in micro-USD: a credit is positive, a debit negative. */
  amountMicroUsd: number;
  /** With `type` and the workspace the idempotency key. Defaults to `jobId` for the entries of a job. */
  refKey?: string | undefined;
  jobId?: string | null | undefined;
  reviewKind?: ProjectReviewKind | null | undefined;
  minutes?: number | null | undefined;
  /** A `usage` carries both parts, which add up to its amount. */
  aiMicroUsd?: number | null | undefined;
  infraMicroUsd?: number | null | undefined;
  /** The entry a `correction` reverses (once). */
  reversesEntryId?: string | null | undefined;
  provider?: string | null | undefined;
  providerRef?: string | null | undefined;
  actorUserId?: string | null | undefined;
  note?: string | null | undefined;
};

function refuse(message: string): never {
  throw new BillingJournalError("invalid_entry", message);
}

function requireSafeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) refuse(`${what} must be a safe integer`);
}

/** The key of an entry: its own, else the job id. Empty when neither is there. */
export function refKeyOf(entry: NewJournalEntry): string {
  return entry.refKey ?? entry.jobId ?? "";
}

/**
 * Throws `invalid_entry` when an entry breaks a rule the table checks too: a known type, a non-zero integer amount with
 * the sign of its type, a key, parts only on a `usage` and adding up to its amount, a reversal only on a `correction`,
 * a job on every job entry. The repository calls it before any statement, so the caller gets a code, not a driver error.
 */
export function validateEntry(entry: NewJournalEntry): void {
  if (!BILLING_ENTRY_TYPES.includes(entry.type))
    refuse(`unknown entry type ${String(entry.type)}`);
  requireSafeInteger(entry.amountMicroUsd, "the amount");
  const sign = ENTRY_SIGNS[entry.type];
  if (entry.amountMicroUsd === 0) refuse("the amount must not be zero");
  if (sign === "positive" && entry.amountMicroUsd < 0)
    refuse(`a ${entry.type} is positive`);
  if (sign === "negative" && entry.amountMicroUsd > 0)
    refuse(`a ${entry.type} is negative`);
  if (refKeyOf(entry) === "") refuse("an entry needs a key");
  if (
    (JOB_ENTRY_TYPES as readonly string[]).includes(entry.type) &&
    (entry.jobId ?? "") === ""
  )
    refuse(`a ${entry.type} belongs to a job`);
  if (entry.minutes != null) {
    requireSafeInteger(entry.minutes, "the minutes");
    if (entry.minutes < 0) refuse("the minutes must not be negative");
  }
  if (entry.reversesEntryId != null && entry.type !== "correction")
    refuse("only a correction reverses an entry");

  const ai = entry.aiMicroUsd ?? null;
  const infra = entry.infraMicroUsd ?? null;
  if (entry.type !== "usage") {
    if (ai !== null || infra !== null) refuse("only a usage has parts");
    return;
  }
  if (ai === null || infra === null) refuse("a usage carries both parts");
  requireSafeInteger(ai, "the AI part");
  requireSafeInteger(infra, "the infrastructure part");
  if (ai < 0 || infra < 0) refuse("the parts must not be negative");
  if (ai + infra !== -entry.amountMicroUsd)
    refuse("the parts of a usage must add up to its amount");
}
