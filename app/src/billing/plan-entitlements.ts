// SPDX-License-Identifier: Apache-2.0

// From a plan version to the entitlements it writes (ADR 0005, 2.13; the acceptance criteria of #438 from the review of
// #428). Pure. The operator API keeps "an omitted `modelAccess` keeps the stored one" for compatibility, so the billing
// writer must never rely on it: a workspace row or the default overrides the instance default entirely, and a paid to
// Free or Free to paid change must replace the list, not keep the other plan's. This function therefore cannot build a
// payload without `modelAccess`: the field is required in the result type, and a managed version that has none throws.
import "server-only";
import type { PlanTerms } from "../admin/ui/plans-view.ts";
import type {
  EntitlementsData,
  ModelAccess,
} from "../workspaces/entitlements.ts";

/** Entitlements that state their model access: the only shape billing writes. */
export type PlanEntitlements = EntitlementsData & { modelAccess: ModelAccess };

function modelAccessOf(terms: PlanTerms): ModelAccess {
  // An `own` workspace never evaluates the list (ADR 0005, 2.9), but the write still states one, so no earlier list
  // is kept behind it. `null` is every released entry, the value a later switch back to `managed` starts from.
  if (terms.keyMode === "own") return { catalogEntries: null };
  const access = terms.modelAccess;
  if (
    access === null ||
    access === undefined ||
    access.catalogEntries === undefined
  )
    throw new Error(
      "A managed plan version must state its modelAccess (a list, [] for none or null for every released entry).",
    );
  return {
    catalogEntries:
      access.catalogEntries === null ? null : [...access.catalogEntries],
  };
}

/**
 * The entitlements of one plan version. `periodStart` is the start of the usage period the caller decided on; the
 * label is the name of the plan. A suspension is never part of a plan.
 */
export function planEntitlements({
  name,
  terms,
  periodStart,
}: {
  name: string;
  terms: PlanTerms;
  periodStart: string;
}): PlanEntitlements {
  return {
    planLabel: name,
    keyMode: terms.keyMode,
    limits: { ...terms.limits },
    periodStart,
    suspended: false,
    suspensionCode: null,
    modelAccess: modelAccessOf(terms),
  };
}
