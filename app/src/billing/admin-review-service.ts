// SPDX-License-Identifier: Apache-2.0

// The billing review rows of the admin page (#603): the events the webhook recorded as money that moved (or claimed to) and
// changed nothing in the ledger (`BILLING_REVIEW_OUTCOMES`, `billing_webhook_events`). The service lists them with what an
// operator needs to act (the outcome, the provider's object, the workspace and the top-up of ours when the application could
// attribute the event), closes one with a required note and the admin as the actor, and offers the two repairs that exist:
// a manual credit or correction through the manual adapter, and "Check payment" at the provider. Server-only; the routes
// check that the caller is an instance admin first.
//
//   - Closing a row changes no money by itself. When the admin credits from the row, the credit is the existing manual credit
//     (`admin-credit-service.ts`) for the workspace THE ROW names (never one the caller sends), under a request id derived from
//     the row, so the same row credits once however often it is sent: a repeat finds the same journal entry, a repeat with
//     another amount is `request_conflict`, and a close that was lost after the credit is closed by the retry.
//   - The row, not the caller, decides what is written: a credit (`top_up`) for a payment or an event about none, a signed
//     correction for a refund or a dispute. A request naming the other type is refused (`review_credit_type_mismatch`), and the
//     request id carries the type as well, so no input can make a second entry of another type for one row (the journal keys
//     an entry by workspace, type and request id).
//   - The credit carries the state of the row's top-up the admin saw (`intentState`); if the top-up has moved since (a webhook
//     paid it, the admin checked it), the credit is refused (`intent_state_changed`) and the admin looks again.
//   - The audit line names the actor and the event, never the note (it may name a customer); the row keeps the note, the actor,
//     the time and the journal entry.
//   - A row holds an id, an outcome and ids of our own: no payload, no buyer and no amount the provider sent.
import "server-only";
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type {
  BillingReviewListView,
  BillingReviewView,
  ReviewStateView,
  ReviewSubjectKind,
} from "../admin/ui/billing-review-view.ts";
import { createBillingTopUpIntentDirectory } from "../db/repositories/billing-topup-intent-directory-repository.ts";
import {
  createBillingWebhookEventsRepository,
  type ReviewRecord,
} from "../db/repositories/billing-webhook-events-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import type { BillingAdapter } from "./adapter.ts";
import type { BillingCreditService } from "./admin-credit-service.ts";
import type { BillingIssue } from "./admin-service.ts";
import type { BillingIssueCode } from "./admin-errors.ts";
import { MANUAL_NOTE_MAX_LENGTH } from "./manual-credit.ts";
import type { TopUpCheckService } from "./topup-check.ts";
import type { TopUpIntentState } from "./topup-intent.ts";

/** How many rows a page of the list holds. */
export const REVIEW_PAGE_SIZE = 25;

export type ReviewFailure =
  | { ok: false; error: "invalid_input"; issues: BillingIssue[] }
  | { ok: false; error: "review_not_found" }
  | { ok: false; error: "review_already_resolved" }
  | { ok: false; error: "review_workspace_unknown" }
  | { ok: false; error: "review_has_no_intent" }
  | { ok: false; error: "review_credit_type_mismatch" }
  | { ok: false; error: "intent_state_changed" }
  | { ok: false; error: "payment_check_not_possible" }
  | { ok: false; error: "payment_check_unavailable" }
  | { ok: false; error: "workspace_not_found" }
  | { ok: false; error: "request_conflict" };

export type ResolveResult =
  { ok: true; review: BillingReviewView } | ReviewFailure;
export type CheckResult =
  | { ok: true; intentState: TopUpIntentState; review: BillingReviewView }
  | ReviewFailure;

/** What "Check payment" needs: the adapter billing runs on (if it can look a payment up) and the check over it. */
export type ReviewCheck = {
  adapter(): Promise<BillingAdapter | undefined>;
  serviceFor(adapter: BillingAdapter): TopUpCheckService;
};

export type BillingReviewService = {
  list(input: {
    state: ReviewStateView;
    page: number;
  }): Promise<BillingReviewListView>;
  /** How many rows are open: the badge of the menu and the line of the overview. */
  openCount(): Promise<number>;
  /** Closes a row, optionally after crediting the workspace of the row by hand. `input` is the unchecked body. */
  resolve(adminId: string, input: unknown): Promise<ResolveResult>;
  /** Asks the provider about the top-up of the row and applies the answer like a webhook. `input` is the unchecked body. */
  check(adminId: string, input: unknown): Promise<CheckResult>;
};

const SUBJECT = /^(payment|refund|dispute):(.+)$/;

/** What a credit from a row writes: a credit for a payment (or an event about none), a correction for a refund or dispute. */
function creditTypeOf(
  subject: BillingReviewView["subject"],
): "credit" | "correction" {
  return subject === null || subject.kind === "payment"
    ? "credit"
    : "correction";
}

function subjectOf(subject: string | null): BillingReviewView["subject"] {
  const match = subject === null ? null : SUBJECT.exec(subject);
  return match === null
    ? null
    : { kind: match[1] as ReviewSubjectKind, ref: match[2]! };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The request id of the manual credit of a row: one per row, so the row credits once however often it is sent. */
export function reviewRequestId(
  provider: string,
  eventId: string,
  type: "credit" | "correction",
): string {
  return `review-${createHash("sha256").update(`${provider}\0${eventId}\0${type}`).digest("hex").slice(0, 40)}`;
}

export function createBillingReviewService({
  db,
  credit,
  check,
  now = () => new Date(),
  log = (line) => console.info(line),
}: {
  db: Kysely<Database>;
  credit: BillingCreditService;
  check?: ReviewCheck | undefined;
  now?: () => Date;
  log?: (line: string) => void;
}): BillingReviewService {
  const events = createBillingWebhookEventsRepository(db);
  const workspaces = createWorkspacesRepository(db);
  const intents = createBillingTopUpIntentDirectory(db);

  async function viewsOf(
    records: ReviewRecord[],
  ): Promise<BillingReviewView[]> {
    const workspaceIds = [
      ...new Set(records.flatMap((row) => row.workspaceId ?? [])),
    ];
    const userIds = [
      ...new Set(records.flatMap((row) => row.resolution?.resolvedBy ?? [])),
    ];
    const [found, users] = await Promise.all([
      Promise.all(workspaceIds.map((id) => workspaces.get(id))),
      userIds.length === 0
        ? Promise.resolve([])
        : db
            .selectFrom("users")
            .select(["id", "name"])
            .where("id", "in", userIds)
            .execute(),
    ]);
    const workspaceById = new Map(
      found.flatMap((workspace) =>
        workspace === undefined ? [] : [[workspace.id, workspace] as const],
      ),
    );
    const nameById = new Map(users.map((user) => [user.id, user.name]));

    return Promise.all(
      records.map(async (row): Promise<BillingReviewView> => {
        const workspace =
          row.workspaceId === null
            ? undefined
            : workspaceById.get(row.workspaceId);
        const intent =
          row.intentId === null || workspace === undefined
            ? undefined
            : await intents.findById(row.provider, row.intentId);
        const subject = subjectOf(row.subject);
        // A payment of an intent that is not paid yet is credited by what we asked for; anything else (a payment of a paid
        // intent, a refund or a dispute) the application cannot put a number on, and the admin types it.
        const suggestion: BillingReviewView["suggestion"] =
          workspace === undefined
            ? null
            : creditTypeOf(subject) === "credit"
              ? {
                  type: "credit",
                  amountMicroUsd:
                    intent !== undefined &&
                    intent.workspaceId === workspace.id &&
                    intent.state !== "paid"
                      ? intent.amountMicroUsd
                      : null,
                }
              : { type: "correction", amountMicroUsd: null };
        return {
          provider: row.provider,
          eventId: row.eventId,
          outcome: row.outcome,
          subject,
          workspace:
            workspace === undefined
              ? null
              : {
                  id: workspace.id,
                  name: workspace.name,
                  slug: workspace.slug,
                },
          intent:
            intent === undefined || intent.workspaceId !== workspace?.id
              ? null
              : {
                  id: intent.id,
                  state: intent.state,
                  amountMicroUsd: intent.amountMicroUsd,
                  checkoutRef: intent.checkoutRef,
                  paymentRef: intent.paymentRef,
                },
          receivedAt: row.receivedAt,
          state: row.reviewState,
          resolution:
            row.resolution === null
              ? null
              : {
                  at: row.resolution.at,
                  byName: nameById.get(row.resolution.resolvedBy) ?? null,
                  note: row.resolution.note,
                  entryId: row.resolution.entryId,
                },
          suggestion,
        };
      }),
    );
  }

  /** The provider and event id of a body that names exactly those (and `extra`), or the refusal. */
  function target(
    input: unknown,
    extra: readonly string[],
  ):
    | { provider: string; eventId: string; body: Record<string, unknown> }
    | ReviewFailure {
    const invalid = (field: string): ReviewFailure => ({
      ok: false,
      error: "invalid_input",
      issues: [{ field, code: "body_invalid" }],
    });
    if (!isRecord(input)) return invalid("");
    if (
      Object.keys(input).some(
        (key) =>
          key !== "provider" && key !== "eventId" && !extra.includes(key),
      )
    )
      return invalid("");
    const { provider, eventId } = input;
    if (typeof provider !== "string" || provider === "")
      return invalid("provider");
    if (typeof eventId !== "string" || eventId === "")
      return invalid("eventId");
    return { provider, eventId, body: input };
  }

  async function reload(
    provider: string,
    eventId: string,
  ): Promise<BillingReviewView> {
    const record = await events.getReview(provider, eventId);
    // Closed a moment ago by this request, so it is there; a vanished row is a broken database, not a refusal.
    if (record === undefined) throw new Error("the review row vanished");
    return (await viewsOf([record]))[0]!;
  }

  return {
    async list({ state, page }) {
      const [records, total, openTotal] = await Promise.all([
        events.listReviews({
          state,
          limit: REVIEW_PAGE_SIZE,
          offset: (page - 1) * REVIEW_PAGE_SIZE,
        }),
        events.countReviews(state),
        events.countReviews("open"),
      ]);
      return {
        state,
        page,
        pageSize: REVIEW_PAGE_SIZE,
        total,
        openTotal,
        rows: await viewsOf(records),
      };
    },

    openCount: () => events.countReviews("open"),

    async resolve(adminId, input) {
      const named = target(input, ["note", "credit"]);
      if ("ok" in named) return named;
      const { provider, eventId, body } = named;
      const noteIssue = (code: BillingIssueCode): ReviewFailure => ({
        ok: false,
        error: "invalid_input",
        issues: [{ field: "note", code }],
      });
      if (typeof body.note !== "string" || body.note.trim() === "")
        return noteIssue("note_required");
      const note = body.note.trim();
      if (note.length > MANUAL_NOTE_MAX_LENGTH)
        return noteIssue("note_too_long");
      const wanted = body.credit;
      if (
        wanted !== undefined &&
        (!isRecord(wanted) ||
          Object.keys(wanted).some(
            (key) =>
              key !== "type" &&
              key !== "amountMicroUsd" &&
              key !== "intentState",
          ))
      )
        return {
          ok: false,
          error: "invalid_input",
          issues: [{ field: "credit", code: "body_invalid" }],
        };

      if (
        wanted !== undefined &&
        wanted.intentState !== undefined &&
        typeof wanted.intentState !== "string"
      )
        return {
          ok: false,
          error: "invalid_input",
          issues: [{ field: "intentState", code: "body_invalid" }],
        };

      const row = await events.getReview(provider, eventId);
      if (row === undefined) return { ok: false, error: "review_not_found" };
      if (row.reviewState === "resolved")
        return { ok: false, error: "review_already_resolved" };

      let entryId: string | null = null;
      if (wanted !== undefined) {
        if (row.workspaceId === null)
          return { ok: false, error: "review_workspace_unknown" };
        const type = creditTypeOf(subjectOf(row.subject));
        if (wanted.type !== undefined && wanted.type !== type) {
          if (wanted.type !== "credit" && wanted.type !== "correction")
            return {
              ok: false,
              error: "invalid_input",
              issues: [{ field: "type", code: "type_invalid" }],
            };
          return { ok: false, error: "review_credit_type_mismatch" };
        }
        // What the admin saw of the top-up must still be so, or the credit might repeat what a payment applied since.
        const intent =
          row.intentId === null
            ? undefined
            : await intents.findById(provider, row.intentId);
        const seen =
          intent === undefined || intent.workspaceId !== row.workspaceId
            ? undefined
            : intent.state;
        if (seen !== undefined && wanted.intentState === undefined)
          return {
            ok: false,
            error: "invalid_input",
            issues: [{ field: "intentState", code: "body_invalid" }],
          };
        if (wanted.intentState !== seen)
          return { ok: false, error: "intent_state_changed" };
        const result = await credit.credit(adminId, row.workspaceId, {
          type,
          amountMicroUsd: wanted.amountMicroUsd,
          note,
          requestId: reviewRequestId(provider, eventId, type),
        });
        if (!result.ok) return result;
        entryId = result.entryId;
      }

      const closed = await events.resolveReview(provider, eventId, {
        resolvedBy: adminId,
        note,
        entryId,
        at: now().toISOString(),
      });
      // Another request closed it between the read and the write: its resolution stays, and a credit written here is the
      // same entry it wrote (one request id per row).
      if (!closed) return { ok: false, error: "review_already_resolved" };
      log(
        `billing_review_resolved provider=${provider} event=${eventId} actor=${adminId} entry=${entryId ?? "none"}`,
      );
      return { ok: true, review: await reload(provider, eventId) };
    },

    async check(adminId, input) {
      const named = target(input, []);
      if ("ok" in named) return named;
      const { provider, eventId } = named;
      const row = await events.getReview(provider, eventId);
      if (row === undefined) return { ok: false, error: "review_not_found" };
      if (row.workspaceId === null || row.intentId === null)
        return { ok: false, error: "review_has_no_intent" };
      const adapter = await check?.adapter();
      if (
        check === undefined ||
        adapter === undefined ||
        adapter.id !== provider ||
        adapter.lookupTopUp === undefined
      )
        return { ok: false, error: "payment_check_not_possible" };

      // The admin acts for the instance: the check is the one a workspace owner makes, over the workspace of the row.
      const result = await check
        .serviceFor(adapter)
        .check(
          { workspaceId: row.workspaceId, userId: adminId, role: "owner" },
          row.intentId,
        );
      log(
        `billing_review_checked provider=${provider} event=${eventId} actor=${adminId} result=${result.ok ? result.state : result.error}`,
      );
      if (!result.ok)
        return {
          ok: false,
          error:
            result.error === "provider_unavailable" ||
            result.error === "provider_rejected"
              ? "payment_check_unavailable"
              : "payment_check_not_possible",
        };
      return {
        ok: true,
        intentState: result.state,
        review: await reload(provider, eventId),
      };
    },
  };
}
