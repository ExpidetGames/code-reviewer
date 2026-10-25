// SPDX-License-Identifier: LicenseRef-Proprietary

// The monthly total limit of a workspace for the code that serves a person (ADR 0006, 2.9; #499): who may read and set it, what
// is accepted, and the audit line of a change. Only an Owner and an Admin (`manage_billing`) reach it; a Member gets
// `forbidden` and nothing is stored or logged for them. The limit is the customer's own, optional (`null` is none, the default).
// It is stated in whole US cents, the unit a person types and the top-up takes; the claim compares micro-USD (a cent is 10,000).
// An error names a code, never a value.
import "server-only";
import type { Kysely } from "kysely";
import { createBillingWorkspaceSettingsRepository } from "../db/repositories/billing-workspace-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import { can } from "../workspaces/permissions.ts";
import type { BillingActor } from "./profile-service.ts";

/** One micro-USD is a millionth of a dollar: a cent is 10,000. */
const MICRO_USD_PER_CENT = 10_000;
/** The smallest limit: one US dollar. Anything below pauses reviews by accident rather than by decision. */
export const MONTHLY_LIMIT_MIN_CENTS = 100;
/** The largest limit: one million US dollars, far above any bill and well inside exact integers. */
export const MONTHLY_LIMIT_MAX_CENTS = 100_000_000;

export const MONTHLY_LIMIT_ERROR_CODES = [
  "forbidden",
  "limit_invalid",
  "limit_out_of_range",
] as const;
export type MonthlyLimitErrorCode = (typeof MONTHLY_LIMIT_ERROR_CODES)[number];

export type MonthlyLimitView = {
  /** Whole US cents, or null for no limit. */
  monthlyLimitCents: number | null;
};

export type MonthlyLimitResult =
  | ({ ok: true } & MonthlyLimitView)
  | { ok: false; error: MonthlyLimitErrorCode };

export type MonthlyLimitService = {
  get(actor: BillingActor): Promise<MonthlyLimitResult>;
  /** The body is what the person sent: `{ monthlyLimitCents: number | null }`. */
  set(actor: BillingActor, body: unknown): Promise<MonthlyLimitResult>;
};

const centsOf = (microUsd: number | null): number | null =>
  microUsd === null ? null : Math.round(microUsd / MICRO_USD_PER_CENT);

export function createMonthlyLimitService({
  db,
  now,
  log = (line) => console.info(line),
}: {
  db: Kysely<Database>;
  now?: () => Date;
  /** Receives the audit line: ids and a stable action only, no name and no address. */
  log?: (line: string) => void;
}): MonthlyLimitService {
  const repositoryOf = (workspaceId: string) =>
    createBillingWorkspaceSettingsRepository(db, workspaceId, now);
  return {
    async get(actor) {
      if (!can(actor.role, "manage_billing"))
        return { ok: false, error: "forbidden" };
      const limit = await repositoryOf(
        actor.workspaceId,
      ).monthlyLimitMicroUsd();
      return { ok: true, monthlyLimitCents: centsOf(limit) };
    },

    async set(actor, body) {
      if (!can(actor.role, "manage_billing"))
        return { ok: false, error: "forbidden" };
      const requested =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? (body as Record<string, unknown>).monthlyLimitCents
          : undefined;
      if (requested !== null) {
        if (typeof requested !== "number" || !Number.isSafeInteger(requested))
          return { ok: false, error: "limit_invalid" };
        if (
          requested < MONTHLY_LIMIT_MIN_CENTS ||
          requested > MONTHLY_LIMIT_MAX_CENTS
        )
          return { ok: false, error: "limit_out_of_range" };
      }
      const stored = await repositoryOf(actor.workspaceId).setMonthlyLimit(
        requested === null ? null : requested * MICRO_USD_PER_CENT,
        actor.userId,
      );
      // The audit line points at who changed what; the row keeps who and when too.
      log(
        requested === null
          ? `[billing] MONTHLY_LIMIT_CHANGED workspace=${actor.workspaceId} user=${actor.userId} action=cleared`
          : `[billing] MONTHLY_LIMIT_CHANGED workspace=${actor.workspaceId} user=${actor.userId} action=set limit_cents=${String(requested)}`,
      );
      return {
        ok: true,
        monthlyLimitCents: centsOf(stored.monthlyLimitMicroUsd),
      };
    },
  };
}
