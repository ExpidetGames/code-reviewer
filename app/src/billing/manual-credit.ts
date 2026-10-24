// SPDX-License-Identifier: LicenseRef-Proprietary

// What an operator does with the `manual` adapter (ADR 0006, P10, 2.12; #497): grant credit by hand, or correct a balance,
// for any workspace. No payment provider is involved. Each call writes one journal entry with the provider `manual`, the
// operator's user id and a note, and the journal is append-only, so the entry IS the audit trail: who, when, how much and
// why. There is no page for it yet (#504); this is the service its forms will call, after they checked that the caller is
// an instance admin and that billing is on.
//
// A grant is a `top_up` keyed by a random reference, so granting twice is two grants, unless the caller passes a request
// id (a form token): then the same request makes one entry however often it is submitted. A correction is a
// `correction` of either sign and may take a balance below zero. An amount is a whole micro-USD amount, never zero, and
// at most `MANUAL_ADJUSTMENT_MAX_MICRO_USD`: an operator entering 10000 instead of 100 is stopped by a bound, not by luck.
import "server-only";
import type { Kysely } from "kysely";
import {
  createBillingJournalRepository,
  type JournalEntry,
} from "../db/repositories/billing-journal-repository.ts";
import {
  createWorkspacesRepository,
  isDeleted,
} from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import { BillingJournalError } from "./journal.ts";

/** The provider name of manual entries in the journal. */
export const MANUAL_PROVIDER = "manual";

/** The most an operator can grant or correct at once: 10,000 USD, in micro-USD. */
export const MANUAL_ADJUSTMENT_MAX_MICRO_USD = 10_000 * 1_000_000;

/** The longest note: it is read in a journal, not a document. */
export const MANUAL_NOTE_MAX_LENGTH = 500;

export const MANUAL_CREDIT_ERROR_CODES = [
  "workspace_not_found",
  "actor_required",
  "note_required",
  "note_too_long",
  /** The amount is not a whole micro-USD amount, or it is zero (or, for a grant, not positive). */
  "amount_invalid",
  "amount_out_of_range",
  "request_id_invalid",
  /** The request id was used before with another amount. */
  "request_conflict",
] as const;
export type ManualCreditErrorCode = (typeof MANUAL_CREDIT_ERROR_CODES)[number];

export class ManualCreditError extends Error {
  readonly code: ManualCreditErrorCode;

  constructor(code: ManualCreditErrorCode, message: string) {
    super(message);
    this.name = "ManualCreditError";
    this.code = code;
  }
}

export type ManualCreditInput = {
  workspaceId: string;
  /** Micro-USD. Positive for a grant; either sign, never zero, for a correction. */
  amount: number;
  /** The id of the signed-in operator. */
  actor: string;
  /** Why. Required. */
  note: string;
  /** A form token: the same request id makes one entry. */
  requestId?: string | undefined;
};

export type ManualCreditLogger = { info(line: string): void };

export type ManualCreditService = {
  grant(input: ManualCreditInput): Promise<JournalEntry>;
  correct(input: ManualCreditInput): Promise<JournalEntry>;
};

const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

function inTransaction<T>(
  db: Kysely<Database>,
  run: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? run(db) : db.transaction().execute(run);
}

export function createManualCreditService(
  db: Kysely<Database>,
  deps: {
    now?: () => Date;
    newRef?: () => string;
    logger?: ManualCreditLogger;
  } = {},
): ManualCreditService {
  const logger = deps.logger ?? { info: (line) => console.info(line) };
  const newRef = deps.newRef ?? (() => crypto.randomUUID());

  async function write(
    type: "top_up" | "correction",
    input: ManualCreditInput,
  ): Promise<JournalEntry> {
    const note = input.note.trim();
    if (input.actor.trim() === "")
      throw new ManualCreditError("actor_required", "an operator is named");
    if (note === "")
      throw new ManualCreditError("note_required", "a note says why");
    if (note.length > MANUAL_NOTE_MAX_LENGTH)
      throw new ManualCreditError("note_too_long", "the note is too long");
    if (
      !Number.isSafeInteger(input.amount) ||
      input.amount === 0 ||
      (type === "top_up" && input.amount < 0)
    )
      throw new ManualCreditError(
        "amount_invalid",
        "an amount is a whole micro-USD amount; a grant is positive",
      );
    if (Math.abs(input.amount) > MANUAL_ADJUSTMENT_MAX_MICRO_USD)
      throw new ManualCreditError(
        "amount_out_of_range",
        "the amount is more than an operator may enter at once",
      );
    if (input.requestId !== undefined && !REQUEST_ID.test(input.requestId))
      throw new ManualCreditError(
        "request_id_invalid",
        "a request id is letters, digits and -",
      );

    const ref = `manual_${input.requestId ?? newRef()}`;
    let entry: JournalEntry;
    try {
      // One transaction: the workspace is read `FOR SHARE` (like a top-up, `apply-event.ts`), so a deletion in flight (#658) has
      // ended before the workspace is read, and one that starts afterwards waits for this entry and then refuses on the balance.
      // A plain read outside the transaction would credit a workspace that was deleted in between.
      entry = await inTransaction(db, async (trx) => {
        const workspace = await createWorkspacesRepository(
          trx,
        ).getIncludingDeleted(input.workspaceId, { lock: true });
        if (workspace === undefined || isDeleted(workspace))
          throw new ManualCreditError(
            "workspace_not_found",
            "no such workspace",
          );
        return (
          await createBillingJournalRepository(
            trx,
            input.workspaceId,
            deps.now,
          ).append({
            type,
            amountMicroUsd: input.amount,
            refKey: ref,
            provider: MANUAL_PROVIDER,
            providerRef: ref,
            actorUserId: input.actor,
            note,
          })
        ).entry;
      });
    } catch (error) {
      if (
        error instanceof BillingJournalError &&
        error.code === "idempotency_conflict"
      )
        throw new ManualCreditError(
          "request_conflict",
          "this request id was used with another amount",
        );
      throw error;
    }
    // The entry is the audit trail; the line only points at it. Never the note, which may name a customer.
    logger.info(
      `billing_manual_credit type=${type} workspace=${input.workspaceId} entry=${entry.id}`,
    );
    return entry;
  }

  return {
    grant: (input) => write("top_up", input),
    correct: (input) => write("correction", input),
  };
}
