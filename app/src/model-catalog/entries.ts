// SPDX-License-Identifier: Apache-2.0

// The vocabulary of the model catalog (#425, docs/decisions/0005-providers-model-catalog-and-paddle-billing.md, 2.6): the
// operator's list of models that workspaces on the operator's key may use. An entry has a free **name** that members see
// and a provider and model id that only the operator sees. Pure: no database, no clock, no network.
import { mentionsModelOrPrice } from "../copy/member-copy-scan.ts";
import type { ProjectReviewKind } from "../review-settings/settings.ts";

/** `draft` is being prepared (and may be deleted), `released` may be chosen, `retired` stays for what already uses it. */
export const CATALOG_STATUSES = ["draft", "released", "retired"] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

/** The review kinds an entry can serve: the kinds of a project (a test compares the lists). */
export const CATALOG_KINDS = [
  "diff",
  "dynamic",
] as const satisfies readonly ProjectReviewKind[];

/** An entry as the operator sees it. Never handed to a member: see `member.ts`. */
export type CatalogEntry = {
  /** Opaque (`mce_` and random text), never reused, the only thing about an entry that leaves the server. */
  id: string;
  name: string;
  description: string | null;
  /** A provider of the registry. Operator only. */
  provider: string;
  /** The real model id. Operator only. */
  modelId: string;
  /** At least one. */
  kinds: ProjectReviewKind[];
  status: CatalogStatus;
  sortOrder: number;
  /** ISO 8601 text in UTC. */
  createdAt: string;
  updatedAt: string;
  /** The user who changed it last, or null (the system, or a user who was deleted since). */
  updatedBy: string | null;
};

/**
 * The instance default entry per kind: the value of the instance setting `catalog_defaults`. Each is the id of a
 * released entry that serves the kind, or null for none. There is no workspace level default (decision C3).
 */
export type CatalogDefaults = Record<ProjectReviewKind, string | null>;

export function isCatalogStatus(value: unknown): value is CatalogStatus {
  return CATALOG_STATUSES.some((status) => status === value);
}

/** Draft to released, released to retired, retired to released again. Nothing returns to draft. */
const TRANSITIONS: Readonly<Record<CatalogStatus, readonly CatalogStatus[]>> = {
  draft: ["released"],
  released: ["retired"],
  retired: ["released"],
};

export function canTransition(from: CatalogStatus, to: CatalogStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const MAX_NAME_CHARS = 40;
export const MAX_DESCRIPTION_CHARS = 160;

/** Printable: letters, digits, marks, punctuation, symbols and the plain space; no control, format or line character. */
const PRINTABLE = /^(?:[^\p{C}\p{Z}]| )+$/u;
const CONTROL_OR_LINE = /[\p{C}\p{Zl}\p{Zp}]/u;

function characters(text: string): number {
  return [...text].length;
}

/** What two names are compared by: the same for names that differ only in case or in compatibility forms. */
export function nameKeyOf(name: string): string {
  return name.normalize("NFKC").toLowerCase();
}

export type CheckNameResult =
  { ok: true; name: string; key: string } | { ok: false; code: "name_invalid" };

/** 1 to 40 printable characters with no space at either end. The entry's own model is checked by `nameRevealsModel`. */
export function checkEntryName(value: unknown): CheckNameResult {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    characters(value) < 1 ||
    characters(value) > MAX_NAME_CHARS ||
    !PRINTABLE.test(value)
  )
    return { ok: false, code: "name_invalid" };
  return { ok: true, name: value, key: nameKeyOf(value) };
}

/**
 * True when the name contains the entry's model id, the part of it after the last `/` or its provider (in any case).
 * Members see the name by design, so it must not give the model away; "Opus" naming a vendor family is the operator's
 * choice and is not checked.
 */
export function nameRevealsModel(
  name: string,
  behind: { provider: string; modelId: string },
): boolean {
  const lower = name.toLowerCase();
  const modelId = behind.modelId.toLowerCase();
  const slug = modelId.slice(modelId.lastIndexOf("/") + 1);
  return [modelId, slug, behind.provider.toLowerCase()].some(
    (secret) => secret !== "" && lower.includes(secret),
  );
}

export type CheckDescriptionResult =
  | { ok: true; description: string | null }
  | { ok: false; code: "description_invalid" };

/**
 * Optional: absent, null or blank is none. One line of at most 160 characters that says nothing about a model, a
 * vendor, a price or a cost (the scan of the quality levels' copy, `copy/member-copy-scan.ts`).
 */
export function checkDescription(value: unknown): CheckDescriptionResult {
  if (value === undefined || value === null)
    return { ok: true, description: null };
  if (typeof value !== "string")
    return { ok: false, code: "description_invalid" };
  const text = value.trim();
  if (text === "") return { ok: true, description: null };
  if (
    characters(text) > MAX_DESCRIPTION_CHARS ||
    CONTROL_OR_LINE.test(text) ||
    mentionsModelOrPrice(text)
  )
    return { ok: false, code: "description_invalid" };
  return { ok: true, description: text };
}
