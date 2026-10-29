// SPDX-License-Identifier: LicenseRef-Proprietary

// The vocabulary of the model catalog (#425, ADR 0005, 2.6): the
// operator's list of models that workspaces on the operator's key may use. An entry has a free **name** that members see
// and a provider and model id that only the operator sees. Pure: no database, no clock, no network.
import { mentionsModelOrPrice } from "../copy/member-copy-scan.ts";
import type { ProjectReviewKind } from "../job-kind/job-kind.ts";

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
  /** Opaque (`mce_` and random text; the entries of the tier migration have a digest of their slug), never reused, the only thing about an entry that leaves the server. */
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
 * What the comparison below ignores: the compatibility forms of letters (fullwidth, ligatures), the case, and every
 * character that is not a letter or a digit. "Claude Sonnet 5.5", "claude_sonnet_5_5" and "ｃｌａｕｄｅ-sonnet-5-5" are one
 * text.
 */
function foldedWords(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}
const squash = (text: string): string => foldedWords(text).join("");

/** Below this many letters and digits a piece of a model id is not compared: it would block half of all names. */
const MIN_COMPARED_LENGTH = 4;

/** The model id, its slug (the part after the last `/`) and both again without the `:variant` of the slug. */
function modelForms(modelId: string): string[] {
  const slug = modelId.slice(modelId.lastIndexOf("/") + 1);
  const variantAt = slug.indexOf(":");
  const bare = variantAt === -1 ? slug : slug.slice(0, variantAt);
  const vendorEnd = modelId.lastIndexOf("/");
  const bareId =
    variantAt === -1 ? modelId : `${modelId.slice(0, vendorEnd + 1)}${bare}`;
  return [modelId, bareId, slug, bare];
}

/** The id and the slug of the model, the provider: what a name or a description must not contain, in folded form. */
function secretsOf(behind: { provider: string; modelId: string }): string[] {
  return [...modelForms(behind.modelId), behind.provider]
    .map(squash)
    .filter((secret) => secret.length >= MIN_COMPARED_LENGTH);
}

/**
 * True when the name contains the entry's model id, the slug of it (with or without its vendor prefix and with or
 * without a `:variant` such as `:free`) or its provider, compared as lower-case letters and digits only (so spaces,
 * dots, dashes, underscores and fullwidth forms do not hide it). Members see the name by design, so it must not give the
 * model away; "Opus" naming a vendor family is the operator's choice and is not checked. A piece shorter than four
 * letters and digits (the slug of `vendor/o1`) is not compared.
 */
export function nameRevealsModel(
  name: string,
  behind: { provider: string; modelId: string },
): boolean {
  const text = squash(name);
  return secretsOf(behind).some((secret) => text.includes(secret));
}

/**
 * Words of a model id that say what a model is like, not which one it is. A description may use them ("Fast and
 * thorough" for `x-ai/grok-4-fast`), so they are not blocked as pieces of the slug.
 */
const DESCRIPTIVE_WORDS: ReadonlySet<string> = new Set([
  "fast",
  "quick",
  "swift",
  "rapid",
  "deep",
  "think",
  "thinking",
  "reasoning",
  "mini",
  "nano",
  "small",
  "large",
  "medium",
  "light",
  "lite",
  "flash",
  "turbo",
  "ultra",
  "plus",
  "base",
  "chat",
  "instruct",
  "preview",
  "latest",
  "code",
  "coder",
  "free",
  "online",
  "extended",
  "high",
  "balanced",
  "smart",
]);

const isMixed = (word: string): boolean =>
  /\p{L}/u.test(word) && /\p{N}/u.test(word);

/**
 * The words of the vendor prefix and of the slug that point at a model: the vendor as a whole (`x-ai` is "xai") and
 * each of its words, and each word of the slug (without its variant) that is at least four characters or mixes letters
 * and digits (`qwen3`), except the descriptive words above.
 */
function pointersOf(modelId: string): string[] {
  const vendorEnd = modelId.lastIndexOf("/");
  const vendor = vendorEnd === -1 ? "" : modelId.slice(0, vendorEnd);
  const slug = modelId.slice(vendorEnd + 1);
  const bare = slug.split(":")[0] ?? slug;
  const words = [...foldedWords(vendor), ...foldedWords(bare)].filter(
    (word) =>
      !DESCRIPTIVE_WORDS.has(word) &&
      (word.length >= MIN_COMPARED_LENGTH || isMixed(word)),
  );
  const wholeVendor = squash(vendor);
  return wholeVendor.length >= 3 ? [wholeVendor, ...words] : words;
}

/**
 * True when the description gives the entry's model away: everything `nameRevealsModel` compares, plus the vendor
 * prefix of the id (as "xAI", "x-ai" or "X AI" for `x-ai/...`) and the words of the slug that name a model family or
 * version ("Grok", "qwen3", "sonnet"), as whole words (up to three words written apart count as one). Not covered, by
 * design: a brand that the id does not contain (a lab that is not the vendor prefix, a nickname) and the descriptive
 * words of the slug ("fast", "coder"). The scan of the copy (`copy/member-copy-scan.ts`) catches the common brand
 * names, nothing can know all of them.
 */
export function descriptionRevealsModel(
  description: string,
  behind: { provider: string; modelId: string },
): boolean {
  if (nameRevealsModel(description, behind)) return true;
  const words = foldedWords(description);
  const written = new Set(words);
  for (let size = 2; size <= 3; size += 1)
    for (let at = 0; at + size <= words.length; at += 1)
      written.add(words.slice(at, at + size).join(""));
  return pointersOf(behind.modelId).some((pointer) => written.has(pointer));
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
