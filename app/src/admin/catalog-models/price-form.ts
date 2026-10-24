// SPDX-License-Identifier: LicenseRef-Proprietary

// The form of a price correction (#554). An admin types dollars per million tokens as decimals ("2.5", "0.003"); the route
// takes whole micro-USD per million tokens as digit strings (src/model-prices/money.ts, price-book.ts). The conversion
// reads the text digit by digit, so no float takes part and a price finer than a micro-USD is refused instead of rounded.
// An empty optional field is "not priced" (null), never zero. This checks what the form can know; the route checks again
// and its codes come back as issues. Pure. Client safe.
import { microUsdPerMTokToUsd } from "../../model-prices/money.ts";
import type {
  PriceBookJson,
  PriceLevelJson,
} from "../../model-prices/price-book.ts";
import { microUsdOf } from "./format.ts";

/** One level of the book, typed: USD per million tokens as decimal text, empty for "not priced". */
export type LevelForm = {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite5m: string;
  cacheWrite1h: string;
  reasoning: string;
  inputAudio: string;
  outputAudio: string;
};
export type TierForm = LevelForm & {
  /** Whole tokens: the tier applies to a prompt above this size. */
  contextOver: string;
};
export type PriceForm = LevelForm & {
  /** The older `context_over_200k` tier; null when the book has none. */
  contextOver200k: LevelForm | null;
  tiers: TierForm[];
  reason: string;
  /** The admin said that a 0 for input or output is meant: the model is free. Only asked while such a 0 is typed. */
  freeConfirmed: boolean;
};

export const LEVEL_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite5m",
  "cacheWrite1h",
  "reasoning",
  "inputAudio",
  "outputAudio",
] as const satisfies ReadonlyArray<keyof LevelForm>;
export type LevelField = (typeof LEVEL_FIELDS)[number];
const REQUIRED: ReadonlySet<LevelField> = new Set(["input", "output"]);

/** As many tiers as the book holds (`PRICE_FORM_MAX_TIERS` of src/model-prices/price-book.ts, which this keeps out of the browser's bundle; a test keeps them together). */
export const PRICE_FORM_MAX_TIERS = 64;
/** As long as the route accepts (`MAX_REASON_LENGTH` of src/model-prices/service.ts; a test keeps them together). */
export const PRICE_FORM_MAX_REASON = 500;
/** The bound `price-book.ts` puts on the context size of a tier. */
const MAX_CONTEXT_OVER = 100_000_000;

export const PRICE_FORM_ISSUE_CODES = [
  "required",
  "negative",
  "not_a_price",
  "tier_context_invalid",
  "tiers_not_ascending",
  "too_many_tiers",
  "reason_invalid",
  /** Input or output is 0 and the admin has not confirmed that the model is free. */
  "free_not_confirmed",
] as const;
export type PriceFormIssueCode = (typeof PRICE_FORM_ISSUE_CODES)[number];
export type PriceFormIssue = { field: string; code: PriceFormIssueCode };

export type PriceFormResult =
  | { ok: true; price: PriceBookJson; reason: string }
  | { ok: false; issues: PriceFormIssue[] };

export function emptyLevelForm(): LevelForm {
  return {
    input: "",
    output: "",
    cacheRead: "",
    cacheWrite5m: "",
    cacheWrite1h: "",
    reasoning: "",
    inputAudio: "",
    outputAudio: "",
  };
}

function levelFormOf(level: PriceLevelJson): LevelForm {
  const shown = (micro: string | null) =>
    micro === null ? "" : microUsdPerMTokToUsd(BigInt(micro));
  return {
    input: shown(level.input),
    output: shown(level.output),
    cacheRead: shown(level.cacheRead),
    cacheWrite5m: shown(level.cacheWrite5m),
    cacheWrite1h: shown(level.cacheWrite1h),
    reasoning: shown(level.reasoning),
    inputAudio: shown(level.inputAudio),
    outputAudio: shown(level.outputAudio),
  };
}

/** The form for a book (the price to look at), or an empty one when there is none. The reason always starts empty. */
export function formFromBook(book: PriceBookJson | null): PriceForm {
  if (book === null)
    return {
      ...emptyLevelForm(),
      contextOver200k: null,
      tiers: [],
      reason: "",
      freeConfirmed: false,
    };
  return {
    ...levelFormOf(book),
    contextOver200k:
      book.contextOver200k === null ? null : levelFormOf(book.contextOver200k),
    tiers: book.tiers.map((tier) => ({
      ...levelFormOf(tier),
      contextOver: String(tier.contextOver),
    })),
    reason: "",
    freeConfirmed: false,
  };
}

/** Whether a typed amount reads as zero ("0", "0.0", " 0 "); an empty or wrong text does not. */
function isZero(text: string): boolean {
  const amount = amountOf(text, false);
  return amount.ok && amount.micro === "0";
}

/**
 * Whether input or output of any level (the price, the older price over 200k tokens, a tier) is typed as zero. A free model is
 * possible, but a zero is also what a slip of the finger makes, and the managed key would run the model without cost to
 * anybody noticing: the form asks once (`freeConfirmed`).
 */
export function hasFreeAmount(form: PriceForm): boolean {
  const levels: LevelForm[] = [
    form,
    ...(form.contextOver200k === null ? [] : [form.contextOver200k]),
    ...form.tiers,
  ];
  return levels.some((level) => isZero(level.input) || isZero(level.output));
}

/** One typed amount: its micro-USD as digits, null when it is empty and optional, or the reason it is refused. */
function amountOf(
  text: string,
  required: boolean,
):
  { ok: true; micro: string | null } | { ok: false; code: PriceFormIssueCode } {
  const typed = text.trim();
  if (typed === "")
    return required
      ? { ok: false, code: "required" }
      : { ok: true, micro: null };
  if (typed.startsWith("-")) return { ok: false, code: "negative" };
  const micro = microUsdOf(typed);
  return micro === null
    ? { ok: false, code: "not_a_price" }
    : { ok: true, micro: micro.toString() };
}

function levelOf(
  form: LevelForm,
  prefix: string,
  issues: PriceFormIssue[],
): PriceLevelJson {
  const level = {} as Record<LevelField, string | null>;
  for (const field of LEVEL_FIELDS) {
    const amount = amountOf(form[field], REQUIRED.has(field));
    if (amount.ok) level[field] = amount.micro;
    else {
      issues.push({ field: `${prefix}${field}`, code: amount.code });
      level[field] = null;
    }
  }
  return level as PriceLevelJson;
}

const CONTEXT = /^[1-9]\d{0,8}$/;
const NOT_ONE_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** The book and the reason the route takes, or every field that is wrong. */
export function bookFromForm(form: PriceForm): PriceFormResult {
  const issues: PriceFormIssue[] = [];
  const base = levelOf(form, "", issues);
  const older =
    form.contextOver200k === null
      ? null
      : levelOf(form.contextOver200k, "contextOver200k.", issues);
  if (form.tiers.length > PRICE_FORM_MAX_TIERS)
    issues.push({ field: "tiers", code: "too_many_tiers" });
  let previous = 0;
  const tiers = form.tiers.slice(0, PRICE_FORM_MAX_TIERS).map((tier, index) => {
    const prefix = `tiers.${String(index)}.`;
    const level = levelOf(tier, prefix, issues);
    const context = tier.contextOver.trim();
    const size = CONTEXT.test(context) ? Number(context) : 0;
    if (size < 1 || size > MAX_CONTEXT_OVER)
      issues.push({
        field: `${prefix}contextOver`,
        code: "tier_context_invalid",
      });
    else if (size <= previous)
      issues.push({
        field: `${prefix}contextOver`,
        code: "tiers_not_ascending",
      });
    else previous = size;
    return { contextOver: size, ...level };
  });
  if (hasFreeAmount(form) && !form.freeConfirmed)
    issues.push({ field: "freeConfirmed", code: "free_not_confirmed" });
  const reason = form.reason.trim();
  if (
    reason === "" ||
    Array.from(reason).length > PRICE_FORM_MAX_REASON ||
    NOT_ONE_LINE.test(reason)
  )
    issues.push({ field: "reason", code: "reason_invalid" });
  if (issues.length > 0) return { ok: false, issues };
  // The shape the route takes (price-form.test.ts parses what this makes with the route's own parser).
  const price: PriceBookJson = { ...base, contextOver200k: older, tiers };
  return { ok: true, price, reason };
}
