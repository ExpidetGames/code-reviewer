// SPDX-License-Identifier: LicenseRef-Proprietary

// The model catalog as far as the selection settings of a project need it (#430, ADR 0005, 2.7): which entries a
// workspace on the operator's key may pick from, and whether one may be chosen for a review kind. Everything here
// works on `MemberCatalogEntry` and on the status and kinds of an entry: the provider and the model id of an entry
// are never read, so no view built from here can carry them. The review settings read it only for a workspace on
// the operator's key; a workspace on its own key never touches the catalog.
import type { CatalogStatus } from "../model-catalog/entries.ts";
import type { MemberCatalogEntry } from "../model-catalog/member.ts";
import type { CatalogService } from "../model-catalog/service.ts";
import { PROJECT_REVIEW_KINDS, type ProjectReviewKind } from "./settings.ts";

/** What a check of a choice needs to know about an entry, and nothing about the model behind it. */
export type CatalogEntryFacts = {
  status: CatalogStatus;
  kinds: readonly ProjectReviewKind[];
};

export type CatalogSelectionSource = {
  /** The released and the retired entries as a member sees them (a draft is never listed), in the picker's order. */
  entries(): Promise<readonly MemberCatalogEntry[]>;
  /** The status and kinds of any entry, a draft included, or undefined for an id that is no entry. */
  find(id: string): Promise<CatalogEntryFacts | undefined>;
  /** Whether the workspace's plan allows the entry (`modelAccess`, #428). */
  allowed(id: string): Promise<boolean>;
};

/**
 * The selection source on top of the catalog service. `allowed` is the plan's side of the choice: the entitlements
 * decide it (`modelAccess`), the catalog does not know it.
 */
export function catalogSelectionFrom(
  catalog: Pick<CatalogService, "get" | "memberEntries">,
  allowed: (id: string) => Promise<boolean>,
): CatalogSelectionSource {
  return {
    entries: () => catalog.memberEntries(),
    async find(id) {
      const entry = await catalog.get(id);
      return entry === undefined
        ? undefined
        : { status: entry.status, kinds: entry.kinds };
    },
    allowed,
  };
}

/** The codes a check of a choice answers with: the ones of the settings write. */
export type CatalogEntryRefusal =
  | "CATALOG_ENTRY_UNKNOWN"
  | "CATALOG_ENTRY_NOT_RELEASED"
  | "CATALOG_ENTRY_KIND_MISMATCH"
  | "CATALOG_ENTRY_NOT_ALLOWED";

/**
 * Why a project may not select this entry for a kind, or null when it may: it exists, is released, serves the
 * kind and is allowed by the plan. Checked in that order, so an id that is no entry says only that.
 */
export async function refusalOfChoice(
  source: CatalogSelectionSource,
  kind: ProjectReviewKind,
  id: string,
): Promise<CatalogEntryRefusal | null> {
  const facts = await source.find(id);
  if (facts === undefined) return "CATALOG_ENTRY_UNKNOWN";
  if (facts.status !== "released") return "CATALOG_ENTRY_NOT_RELEASED";
  if (!facts.kinds.includes(kind)) return "CATALOG_ENTRY_KIND_MISMATCH";
  if (!(await source.allowed(id))) return "CATALOG_ENTRY_NOT_ALLOWED";
  return null;
}

/** Why a listed entry cannot be chosen now. Reasons are codes; the page translates them (C4: shown locked). */
export type CatalogChoiceReason = Extract<
  CatalogEntryRefusal,
  "CATALOG_ENTRY_NOT_RELEASED" | "CATALOG_ENTRY_NOT_ALLOWED"
>;

/** One entry of the picker: what a member may know of it, whether it can be chosen, and why not. */
export type CatalogChoice = {
  id: string;
  name: string;
  description: string | null;
  available: boolean;
  reason: CatalogChoiceReason | null;
};

export type CatalogChoices = Record<ProjectReviewKind, CatalogChoice[]>;

/** The entry id the project selects per kind, or null for none (the instance default applies at the claim, #432). */
export type CatalogSelection = Record<ProjectReviewKind, string | null>;

/**
 * The picker of a managed workspace: per kind the entries that serve it. A released entry is available unless the
 * plan does not allow it (then it is listed locked, C4). A retired entry stays listed, locked, while the project has
 * it selected, so the page can say why the choice no longer works (C5), and is left out otherwise. Copies fields one
 * by one, so nothing else an entry carries can come along.
 */
export async function catalogChoices(
  source: CatalogSelectionSource,
  selection: CatalogSelection,
): Promise<CatalogChoices> {
  const entries = await source.entries();
  const choices = {} as CatalogChoices;
  for (const kind of PROJECT_REVIEW_KINDS) {
    choices[kind] = [];
    for (const entry of entries) {
      if (!entry.kinds.includes(kind)) continue;
      const base = {
        id: entry.id,
        name: entry.name,
        description: entry.description,
      };
      if (entry.status === "released") {
        const allowed = await source.allowed(entry.id);
        choices[kind].push({
          ...base,
          available: allowed,
          reason: allowed ? null : "CATALOG_ENTRY_NOT_ALLOWED",
        });
      } else if (entry.status === "retired" && selection[kind] === entry.id) {
        choices[kind].push({
          ...base,
          available: false,
          reason: "CATALOG_ENTRY_NOT_RELEASED",
        });
      }
    }
  }
  return choices;
}
