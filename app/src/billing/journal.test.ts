// SPDX-License-Identifier: Apache-2.0

// The entry types of the balance journal are one `as const` set that the table check, the repository and the types
// share (#495), and the rules an entry must satisfy before it is written (ADR 0006, 2.7).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BILLING_ENTRY_TYPES,
  BILLING_JOURNAL_ERROR_CODES,
  BillingJournalError,
  ENTRY_SIGNS,
  requireAppendable,
  validateEntry,
  type NewJournalEntry,
} from "./journal.ts";

const MIGRATION = readFileSync(
  new URL(
    "../db/migrations/20261019150000_create_billing_journal.ts",
    import.meta.url,
  ),
  "utf8",
);

const topUp: NewJournalEntry = {
  type: "top_up",
  amountMicroUsd: 10_000_000,
  refKey: "pi_1",
  provider: "stripe",
  providerRef: "pi_1",
};

function refusal(entry: NewJournalEntry): unknown {
  try {
    validateEntry(entry);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("the entry types of the journal", () => {
  // #495-T13
  it("are the eight types of ADR 0006 in one set", () => {
    expect([...BILLING_ENTRY_TYPES].sort()).toEqual(
      [
        "chargeback",
        "correction",
        "refund",
        "release",
        "reservation",
        "start_credit",
        "top_up",
        "usage",
      ].sort(),
    );
  });

  // #495-T13
  it("have a sign rule each, and no rule for a type outside the set", () => {
    expect(Object.keys(ENTRY_SIGNS).sort()).toEqual(
      [...BILLING_ENTRY_TYPES].sort(),
    );
    expect(ENTRY_SIGNS).toMatchObject({
      top_up: "positive",
      start_credit: "positive",
      release: "positive",
      reservation: "negative",
      usage: "negative",
      refund: "negative",
      chargeback: "negative",
      correction: "either",
    });
  });

  // #495-T13
  it("are the ones the table check of the migration names, with the same sign per type", () => {
    const typeCheck =
      /billing_journal_entries_type_check",\s*sql`([^`]*)`/.exec(
        MIGRATION,
      )?.[1];
    const listed = [...(typeCheck ?? "").matchAll(/'([a-z_]+)'/g)].map(
      (match) => match[1],
    );
    expect(listed.sort()).toEqual([...BILLING_ENTRY_TYPES].sort());

    const signCheck =
      /billing_journal_entries_sign_check",\s*sql`([^`]*)`/.exec(
        MIGRATION,
      )?.[1];
    const symbols: Record<string, string> = {};
    for (const [, list, single, symbol] of (signCheck ?? "").matchAll(
      /type (?:in \(([^)]*)\)|= '(\w+)') and amount_micro_usd (<>|>|<) 0/g,
    ))
      for (const type of (list ?? `'${single}'`).matchAll(/'(\w+)'/g))
        symbols[type[1] ?? ""] = symbol ?? "";
    const expected = { positive: ">", negative: "<", either: "<>" } as const;
    expect(symbols).toEqual(
      Object.fromEntries(
        BILLING_ENTRY_TYPES.map((type) => [type, expected[ENTRY_SIGNS[type]]]),
      ),
    );
  });

  // #495-T13
  it("come with a stable set of error codes the repository answers with", () => {
    expect(BILLING_JOURNAL_ERROR_CODES).toEqual(
      expect.arrayContaining([
        "invalid_entry",
        "idempotency_conflict",
        "already_reversed",
        "reservation_required",
        "job_entry_required",
        "reservation_released",
        "balance_exhausted",
        "balance_negative",
      ]),
    );
    const error = new BillingJournalError("invalid_entry", "why");
    expect(error.code).toBe("invalid_entry");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("validating an entry before it is written", () => {
  // #495-T07
  it("accepts a well formed entry of every type", () => {
    const entries: NewJournalEntry[] = [
      topUp,
      { ...topUp, type: "start_credit", refKey: "ws-1" },
      { type: "refund", amountMicroUsd: -5, refKey: "re_1" },
      { type: "chargeback", amountMicroUsd: -5, refKey: "dp_1" },
      { type: "correction", amountMicroUsd: 7, refKey: "c-1" },
      { type: "correction", amountMicroUsd: -7, refKey: "c-2" },
      {
        type: "usage",
        amountMicroUsd: -300,
        refKey: "job-1",
        jobId: "job-1",
        aiMicroUsd: 100,
        infraMicroUsd: 200,
        minutes: 3,
        reviewKind: "diff",
      },
    ];
    for (const entry of entries) expect(refusal(entry)).toBeUndefined();
  });

  // #495-T07
  it.each([
    ["a top-up that is negative", { ...topUp, amountMicroUsd: -1 }],
    ["a top-up of zero", { ...topUp, amountMicroUsd: 0 }],
    [
      "a refund that is positive",
      { type: "refund", amountMicroUsd: 1, refKey: "re_1" },
    ],
    [
      "a chargeback that is positive",
      { type: "chargeback", amountMicroUsd: 1, refKey: "dp_1" },
    ],
    [
      "a correction of zero",
      { type: "correction", amountMicroUsd: 0, refKey: "c-1" },
    ],
    ["an amount with a fraction", { ...topUp, amountMicroUsd: 1.5 }],
    [
      "an amount beyond the safe integers",
      { ...topUp, amountMicroUsd: 2 ** 60 },
    ],
    ["an empty key", { ...topUp, refKey: "" }],
    [
      "a usage whose parts do not add up",
      {
        type: "usage",
        amountMicroUsd: -300,
        refKey: "job-1",
        jobId: "job-1",
        aiMicroUsd: 100,
        infraMicroUsd: 100,
      },
    ],
    [
      "a usage without its parts",
      { type: "usage", amountMicroUsd: -300, refKey: "job-1", jobId: "job-1" },
    ],
    [
      "parts on a type that has none",
      { ...topUp, aiMicroUsd: 1, infraMicroUsd: 1 },
    ],
    [
      "a reversal on a type that is not a correction",
      { ...topUp, reversesEntryId: "e-1" },
    ],
    [
      "a job entry without its job",
      { type: "release", amountMicroUsd: 5, refKey: "job-1" },
    ],
    ["negative minutes", { ...topUp, minutes: -1 }],
  ] as const)("refuses %s with the code invalid_entry", (_name, entry) => {
    expect(refusal(entry as NewJournalEntry)).toMatchObject({
      code: "invalid_entry",
    });
  });
});

describe("the types a caller may append", () => {
  function refused(entry: NewJournalEntry): unknown {
    try {
      requireAppendable(entry);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  // #495-T01
  it("are all but the three that belong to a job's hold, which only reserve, release and settle write", () => {
    const entries: Record<
      (typeof BILLING_ENTRY_TYPES)[number],
      NewJournalEntry
    > = {
      top_up: topUp,
      start_credit: { ...topUp, type: "start_credit", refKey: "ws-1" },
      refund: { type: "refund", amountMicroUsd: -5, refKey: "re_1" },
      chargeback: { type: "chargeback", amountMicroUsd: -5, refKey: "dp_1" },
      correction: { type: "correction", amountMicroUsd: 7, refKey: "c-1" },
      reservation: {
        type: "reservation",
        amountMicroUsd: -5,
        jobId: "job-1",
      },
      release: { type: "release", amountMicroUsd: 5, jobId: "job-1" },
      usage: {
        type: "usage",
        amountMicroUsd: -300,
        jobId: "job-1",
        aiMicroUsd: 100,
        infraMicroUsd: 200,
      },
    };

    const codes = Object.fromEntries(
      BILLING_ENTRY_TYPES.map((type) => {
        const error = refused(entries[type]);
        return [type, error instanceof BillingJournalError ? error.code : null];
      }),
    );

    expect(codes).toEqual({
      top_up: null,
      start_credit: null,
      refund: null,
      chargeback: null,
      correction: null,
      reservation: "reservation_required",
      release: "job_entry_required",
      usage: "job_entry_required",
    });
  });
});
