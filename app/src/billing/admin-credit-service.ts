// SPDX-License-Identifier: Apache-2.0

// The manual credit and correction of the admin page (ADR 0006, P10; #504): find a workspace by name, see its balance and its
// recent entries, and write a credit or a signed correction with a required note. The write is the manual adapter's
// (`manual-credit.ts`): one journal entry of the provider `manual` with the admin as the actor, so the immutable entry is the
// audit trail. It works with either adapter and whether billing is on or off (an operator may fund workspaces before the
// switch is set). Server-only; the routes check that the caller is an instance admin first.
import "server-only";
import type { Kysely } from "kysely";
import type {
  BillingWorkspaceBalanceView,
  BillingWorkspaceView,
} from "../admin/ui/billing-view.ts";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import {
  createWorkspacesRepository,
  type Workspace,
} from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import type { BillingIssue } from "./admin-service.ts";
import type { BillingIssueCode } from "./admin-errors.ts";
import {
  createManualCreditService,
  ManualCreditError,
  type ManualCreditErrorCode,
  type ManualCreditLogger,
} from "./manual-credit.ts";

/** The most the search lists. */
export const WORKSPACE_SEARCH_LIMIT = 10;
/** How many entries the page shows under a workspace's balance. */
export const RECENT_ENTRIES_LIMIT = 10;

export type CreditKind = "credit" | "correction";

export type CreditFailure =
  | { ok: false; error: "invalid_input"; issues: BillingIssue[] }
  | { ok: false; error: "workspace_not_found" }
  | { ok: false; error: "request_conflict" };
export type CreditResult =
  { ok: true; entryId: string; balanceMicroUsd: number } | CreditFailure;

export type BillingCreditService = {
  search(text: string): Promise<BillingWorkspaceView[]>;
  /** The workspace with its balance and recent entries, or undefined when there is none. */
  workspace(id: string): Promise<BillingWorkspaceBalanceView | undefined>;
  credit(
    adminId: string,
    workspaceId: string,
    input: unknown,
  ): Promise<CreditResult>;
};

const toView = (workspace: Workspace): BillingWorkspaceView => ({
  id: workspace.id,
  name: workspace.name,
  slug: workspace.slug,
});

/** The field of the form a refusal of the manual credit is about. */
const FIELD_OF: Record<
  Exclude<ManualCreditErrorCode, "workspace_not_found" | "request_conflict">,
  string
> = {
  actor_required: "actor",
  note_required: "note",
  note_too_long: "note",
  amount_invalid: "amountMicroUsd",
  amount_out_of_range: "amountMicroUsd",
  request_id_invalid: "requestId",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createBillingCreditService({
  db,
  now,
  logger,
}: {
  db: Kysely<Database>;
  now?: () => Date;
  logger?: ManualCreditLogger;
}): BillingCreditService {
  const workspaces = createWorkspacesRepository(db);
  const manual = createManualCreditService(db, {
    ...(now === undefined ? {} : { now }),
    ...(logger === undefined ? {} : { logger }),
  });

  return {
    async search(text) {
      return (await workspaces.search(text.trim(), WORKSPACE_SEARCH_LIMIT)).map(
        toView,
      );
    },

    async workspace(id) {
      const found = await workspaces.get(id);
      if (found === undefined) return undefined;
      const journal = createBillingJournalRepository(db, found.id, now);
      const [balance, page] = await Promise.all([
        journal.balance(),
        journal.entries({ limit: RECENT_ENTRIES_LIMIT }),
      ]);
      return {
        workspace: toView(found),
        balanceMicroUsd: balance.balanceMicroUsd,
        reservedMicroUsd: balance.reservedMicroUsd,
        entries: page.entries.map((entry) => ({
          id: entry.id,
          type: entry.type,
          amountMicroUsd: entry.amountMicroUsd,
          provider: entry.provider,
          note: entry.note,
          createdAt: entry.createdAt,
        })),
      };
    },

    async credit(adminId, workspaceId, input) {
      const issue = (field: string, code: BillingIssueCode): CreditFailure => ({
        ok: false,
        error: "invalid_input",
        issues: [{ field, code }],
      });
      if (!isRecord(input)) return issue("credit", "body_invalid");
      const { type, amountMicroUsd, note, requestId } = input;
      if (type !== "credit" && type !== "correction")
        return issue("type", "type_invalid");
      if (typeof amountMicroUsd !== "number")
        return issue("amountMicroUsd", "amount_invalid");
      if (typeof note !== "string") return issue("note", "note_required");
      if (requestId !== undefined && typeof requestId !== "string")
        return issue("requestId", "request_id_invalid");
      try {
        const write = type === "credit" ? manual.grant : manual.correct;
        const entry = await write({
          workspaceId,
          amount: amountMicroUsd,
          actor: adminId,
          note,
          requestId,
        });
        const balance = await createBillingJournalRepository(
          db,
          workspaceId,
          now,
        ).balance();
        return {
          ok: true,
          entryId: entry.id,
          balanceMicroUsd: balance.balanceMicroUsd,
        };
      } catch (error) {
        if (!(error instanceof ManualCreditError)) throw error;
        if (error.code === "workspace_not_found")
          return { ok: false, error: "workspace_not_found" };
        if (error.code === "request_conflict")
          return { ok: false, error: "request_conflict" };
        return issue(FIELD_OF[error.code], error.code);
      }
    },
  };
}
