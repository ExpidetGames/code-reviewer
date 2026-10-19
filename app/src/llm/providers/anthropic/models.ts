// SPDX-License-Identifier: Apache-2.0

// The models of the Anthropic (Claude API) adapter: a fixed, curated list defined here, in code (the catalog
// decision of 2026-10-18). A person only picks from it; nobody can add a model, so every id that reaches a job has
// a known price, window and parameter rules. Data only and safe for a client component to import.
//
// **Source and date.** Read on 2026-10-19 from Anthropic's documentation:
//   - https://platform.claude.com/docs/en/about-claude/models/overview   (ids, windows, output limits)
//   - https://platform.claude.com/docs/en/about-claude/pricing           (prices, cache multipliers, Haiku 5.5 tier)
//   - https://platform.claude.com/docs/en/about-claude/model-deprecations (what is active, deprecated, retired)
//   - https://platform.claude.com/docs/en/build-with-claude/thinking     (which models accept `thinking: disabled`)
//   - https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools (which models take a forced tool choice)
//   - https://platform.claude.com/docs/en/api/openai-sdk, .../models/<model>/migration-guide (sampling parameters)
// The list is every model that was active on that day, without the ones Anthropic lists as deprecated
// (`claude-sonnet-4-5-20250929`, `claude-mythos-preview`), retired, or open only to verified organizations
// (`claude-mythos-5-1`, `claude-mythos-5`). `contracts/anthropic-models.v1.json` records the same list for the
// runner, which keeps its own copy to price calls (runner/src/code_reviewer_runner/anthropic_models.py); a
// test compares both with the file. To update: read the three pages, change the list, the file and the runner's
// copy together, change `ANTHROPIC_MODELS_AS_OF` and run the tests.
//
// **The flags decide, not the name.** Whether a request may carry `temperature` or `top_p`, a forced tool
// choice or `thinking: disabled` is a fact about the model recorded below. No code guesses it from an id: Opus
// 4.7 and every later model answer a non-default `temperature` or `top_p` with a 400, and Opus 5.5, Sonnet 5.5
// and Fable 5.1 answer a forced `tool_choice` with a 400.
//
// A Dynamic Review needs three things of a model: tools, a forced tool choice (the pinned engine returns its findings
// through a forced `StructuredOutput` call) and a way to run without thinking blocks (the engine's chat history
// cannot carry them back, so the runner asks for `thinking: disabled`). `reviewKinds` says which models qualify.
import type { ReviewKind } from "../../../contracts/runner-api.ts";

/** USD per million tokens, as a decimal string so that no float rounding enters a price. */
export type AnthropicPrices = {
  readonly input: string;
  readonly output: string;
  readonly cacheRead: string;
  readonly cacheWrite5m: string;
  readonly cacheWrite1h: string;
};

export type AnthropicModel = {
  /** The exact id of the Claude API. The dateless ids are pinned snapshots; the dated ones are as Anthropic names them. */
  readonly id: string;
  /** How Anthropic names the model. Operator-side copy; a member never sees a model name. */
  readonly displayName: string;
  readonly contextWindowTokens: number;
  /** The most one synchronous Messages call may generate. */
  readonly maxOutputTokens: number;
  /** Anthropic's retirement commitment: not before this day (ISO date). */
  readonly retiresNotBefore: string;
  readonly supports: {
    /** A non-default `temperature` is accepted (it is a 400 from Opus 4.7 on). */
    readonly temperature: boolean;
    /** A non-default `top_p` is accepted. Never sent together with `temperature`. */
    readonly topP: boolean;
    readonly tools: boolean;
    /** `tool_choice` `any` or a named tool is accepted (a 400 on Fable 5.1, Opus 5.5 and Sonnet 5.5). */
    readonly forcedToolChoice: boolean;
    /** `thinking: {type: "disabled"}` is accepted at the model's default effort. */
    readonly thinkingDisabled: boolean;
  };
  readonly reviewKinds: readonly ReviewKind[];
  readonly pricesUsdPerMTok: AnthropicPrices;
  /**
   * Higher prices for a request whose prompt (input, cache reads and cache writes together) is over
   * `overInputTokens`; each request is priced on its own. Null for the models that charge one price at every length.
   */
  readonly longPrompt: {
    readonly overInputTokens: number;
    readonly pricesUsdPerMTok: AnthropicPrices;
  } | null;
};

/** The day the list and its prices were read. */
export const ANTHROPIC_MODELS_AS_OF = "2026-10-19";

const prices = (
  input: string,
  output: string,
  cacheRead: string,
  cacheWrite5m: string,
  cacheWrite1h: string,
): AnthropicPrices => ({
  input,
  output,
  cacheRead,
  cacheWrite5m,
  cacheWrite1h,
});

const NO_SAMPLING = { temperature: false, topP: false } as const;
const SAMPLING = { temperature: true, topP: true } as const;

/** The current generation first, then the models still offered, newest first. */
export const ANTHROPIC_MODELS: readonly AnthropicModel[] = [
  {
    id: "claude-fable-5-1",
    displayName: "Claude Fable 5.1",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    retiresNotBefore: "2027-09-01",
    supports: {
      ...NO_SAMPLING,
      tools: true,
      forcedToolChoice: false,
      thinkingDisabled: false,
    },
    reviewKinds: ["diff"],
    pricesUsdPerMTok: prices("10", "50", "0.25", "12.50", "20"),
    longPrompt: null,
  },
  {
    id: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    retiresNotBefore: "2027-09-22",
    supports: {
      ...NO_SAMPLING,
      tools: true,
      forcedToolChoice: false,
      thinkingDisabled: false,
    },
    reviewKinds: ["diff"],
    pricesUsdPerMTok: prices("4", "20", "0.20", "5", "8"),
    longPrompt: null,
  },
  {
    id: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    retiresNotBefore: "2027-09-28",
    supports: {
      ...NO_SAMPLING,
      tools: true,
      forcedToolChoice: false,
      thinkingDisabled: false,
    },
    reviewKinds: ["diff"],
    pricesUsdPerMTok: prices("2", "10", "0.10", "2.50", "4"),
    longPrompt: null,
  },
  {
    id: "claude-haiku-5-5",
    displayName: "Claude Haiku 5.5",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    retiresNotBefore: "2027-10-07",
    supports: {
      ...NO_SAMPLING,
      tools: true,
      forcedToolChoice: true,
      thinkingDisabled: true,
    },
    reviewKinds: ["diff", "dynamic"],
    pricesUsdPerMTok: prices("0.10", "0.50", "0.01", "0.125", "0.20"),
    longPrompt: {
      overInputTokens: 100_000,
      pricesUsdPerMTok: prices("0.50", "2.50", "0.05", "0.625", "1"),
    },
  },
  {
    id: "claude-fable-5",
    displayName: "Claude Fable 5",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    retiresNotBefore: "2027-06-09",
    supports: {
      ...NO_SAMPLING,
      tools: true,
      forcedToolChoice: true,
      thinkingDisabled: false,
    },
    reviewKinds: ["diff"],
    pricesUsdPerMTok: prices("10", "50", "1", "12.50", "20"),
    longPrompt: null,
  },
  {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    retiresNotBefore: "2027-07-24",
    supports: {
      ...NO_SAMPLING,
      tools: true,
      forcedToolChoice: true,
      thinkingDisabled: true,
    },
    reviewKinds: ["diff", "dynamic"],
    pricesUsdPerMTok: prices("5", "25", "0.50", "6.25", "10"),
    longPrompt: null,
  },
  {
    id: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    retiresNotBefore: "2027-05-28",
    supports: {
      ...NO_SAMPLING,
      tools: true,
      forcedToolChoice: true,
      thinkingDisabled: true,
    },
    reviewKinds: ["diff", "dynamic"],
    pricesUsdPerMTok: prices("5", "25", "0.50", "6.25", "10"),
    longPrompt: null,
  },
  {
    id: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    retiresNotBefore: "2027-04-16",
    supports: {
      ...NO_SAMPLING,
      tools: true,
      forcedToolChoice: true,
      thinkingDisabled: true,
    },
    reviewKinds: ["diff", "dynamic"],
    pricesUsdPerMTok: prices("5", "25", "0.50", "6.25", "10"),
    longPrompt: null,
  },
  {
    id: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    retiresNotBefore: "2027-02-05",
    supports: {
      ...SAMPLING,
      tools: true,
      forcedToolChoice: true,
      thinkingDisabled: true,
    },
    reviewKinds: ["diff", "dynamic"],
    pricesUsdPerMTok: prices("5", "25", "0.50", "6.25", "10"),
    longPrompt: null,
  },
  {
    id: "claude-opus-4-5-20251101",
    displayName: "Claude Opus 4.5",
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    retiresNotBefore: "2026-11-24",
    supports: {
      ...SAMPLING,
      tools: true,
      forcedToolChoice: true,
      thinkingDisabled: true,
    },
    reviewKinds: ["diff", "dynamic"],
    pricesUsdPerMTok: prices("5", "25", "0.50", "6.25", "10"),
    longPrompt: null,
  },
  {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    retiresNotBefore: "2027-06-30",
    supports: {
      ...NO_SAMPLING,
      tools: true,
      forcedToolChoice: true,
      thinkingDisabled: true,
    },
    reviewKinds: ["diff", "dynamic"],
    pricesUsdPerMTok: prices("2", "10", "0.20", "2.50", "4"),
    longPrompt: null,
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    retiresNotBefore: "2027-02-17",
    supports: {
      ...SAMPLING,
      tools: true,
      forcedToolChoice: true,
      thinkingDisabled: true,
    },
    reviewKinds: ["diff", "dynamic"],
    pricesUsdPerMTok: prices("3", "15", "0.30", "3.75", "6"),
    longPrompt: null,
  },
  {
    id: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    retiresNotBefore: "2026-10-15",
    supports: {
      ...SAMPLING,
      tools: true,
      forcedToolChoice: true,
      thinkingDisabled: true,
    },
    reviewKinds: ["diff", "dynamic"],
    pricesUsdPerMTok: prices("1", "5", "0.10", "1.25", "2"),
    longPrompt: null,
  },
];

/**
 * The model used when nobody chose one.
 *
 * - **Diff: Haiku 5.5**, at $0.10 / $0.50 per MTok: the recommendation of the model comparison, and the cheapest
 *   current model.
 * - **Dynamic: Sonnet 5.** A Dynamic Review is a tool loop: the model explores a checkout and returns its findings
 *   through a forced `StructuredOutput` call. That excludes Sonnet 5.5, Opus 5.5 and Fable 5.1 (a forced tool choice
 *   is a 400) until the engine can steer with `auto`, and Fable 5 (thinking cannot be switched off). Among the models
 *   that remain, Sonnet 5 is the one Anthropic describes for agentic tool use and the least expensive of that kind
 *   ($2 / $10 per MTok, the price of Sonnet 5.5, one price at every prompt length). Haiku 5.5 qualifies technically
 *   but is Anthropic's model for classification, extraction and routing. Anthropic commits to serve Sonnet 5 until at
 *   least 2027-06-30; the default moves to Sonnet 5.5 when the engine no longer forces the tool choice.
 */
export const ANTHROPIC_DEFAULT_MODELS = {
  diff: "claude-haiku-5-5",
  dynamic: "claude-sonnet-5",
} as const;

const BY_ID: ReadonlyMap<string, AnthropicModel> = new Map(
  ANTHROPIC_MODELS.map((model) => [model.id, model]),
);

/** The model with exactly this id, or undefined: no alias, no prefix, no case folding. */
export function anthropicModel(id: string): AnthropicModel | undefined {
  return BY_ID.get(id);
}

export function isAnthropicModelId(id: string): boolean {
  return BY_ID.has(id);
}
