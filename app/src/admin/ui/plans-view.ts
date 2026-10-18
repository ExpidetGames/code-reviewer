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

export type PlanVersionView = PlanTerms & {
  number: number;
  role: PlanVersionRole;
  createdAt: string;
};

export type PlanView = PlanMetadata & {
  planKey: string;
  kind: PlanKind;
  archived: boolean;
  /** Newest first. Empty for a `contact` plan. */
  versions: PlanVersionView[];
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
