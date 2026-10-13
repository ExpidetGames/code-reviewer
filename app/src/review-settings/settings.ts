// SPDX-License-Identifier: Apache-2.0

// The review settings: what a review can be tuned by, their limits and their built-in values.
//
// Three layers decide what a review uses, from weakest to strongest: the built-in values (this
// file, plus the model from `LLM_MODEL`), the global defaults (a sparse set stored in `app_settings`)
// and the overrides of one project (a sparse set in `projects.settings`). A layer only holds the
// fields somebody changed; everything else is inherited, so a built-in value that changes later
// (the model comparison may change the default model) reaches everybody who did not choose one.
// A repository's own `.pr_agent.toml` can still set what the app does not send: the options sent in
// `job.env` win over the repository file (README.md, "Things to know"), so the file only reaches keys
// that are left out (empty project rules, switches that are off, everything else PR-Agent has).
import { REVIEW_COMMANDS, type ReviewCommand } from "../integrations/types.ts";
import { DEFAULT_LLM_MODEL } from "../llm/config.ts";

export type ReviewSettings = {
  /** The model reviews run with, as the provider spells it (no provider prefix). */
  model: string;
  /** Tried when the model fails; `null` means none. */
  fallbackModel: string | null;
  /** Project rules for the model, in free text. Empty means none. */
  extraInstructions: string;
  /** The most findings one review lists. */
  maxFindings: number;
  /** The token budget of a review: how much of a diff goes to the model at once. */
  maxTokens: number;
  /** Split a large pull request into chunks and review each, instead of leaving files out. */
  largePrChunking: boolean;
  /** Post every finding as an inline comment on its line as well. */
  inlineKeyIssues: boolean;
  /** Review a pull request when it is opened, reopened or marked ready for review. */
  autoReviewOnOpen: boolean;
  /** Review a pull request again when new commits are pushed. */
  autoReviewOnPush: boolean;
  /** The comment commands people may use. */
  allowedCommands: ReviewCommand[];
};

export type ReviewSettingField = keyof ReviewSettings;

/**
 * The one review kind a project selects (#193, #194). Diff Review is the existing PR-Agent review;
 * Dynamic Review is the read-only agent of the epic. A project has exactly one.
 */
export const PROJECT_REVIEW_KINDS = ["diff", "dynamic"] as const;
export type ProjectReviewKind = (typeof PROJECT_REVIEW_KINDS)[number];

/**
 * The default model of Dynamic Review. It is a **default, not an allow-list**: a project may name any
 * model the configured provider serves (#194-T08), and the operator's model/provider resolution is
 * #197's business, not a project setting. No hosting-provider or routing field exists.
 */
export const DEFAULT_DYNAMIC_MODEL = "deepseek-v4.1-flash";

/**
 * The settings that only a project has (#194): one review kind, the Dynamic model and an optional
 * skill override. They live in `projects.settings` next to the Diff overrides but are never workspace
 * defaults: the global layer cannot hold them (`validate.ts`, `REVIEW_SETTINGS_...`).
 */
export type ProjectDynamicSettings = {
  reviewKind: ProjectReviewKind;
  dynamicModel: string;
  /** The project's skill override, or `null` for the shipped default skill. */
  reviewSkill: string | null;
};

/** A project layer: only the fields somebody set. */
export type ProjectDynamicOverrides = Partial<ProjectDynamicSettings>;

export type ProjectDynamicSettingField = keyof ProjectDynamicSettings;

export const PROJECT_DYNAMIC_SETTING_FIELDS = [
  "reviewKind",
  "dynamicModel",
  "reviewSkill",
] as const satisfies readonly ProjectDynamicSettingField[];

export const REVIEW_SETTING_FIELDS = [
  "model",
  "fallbackModel",
  "extraInstructions",
  "maxFindings",
  "maxTokens",
  "largePrChunking",
  "inlineKeyIssues",
  "autoReviewOnOpen",
  "autoReviewOnPush",
  "allowedCommands",
] as const satisfies readonly ReviewSettingField[];

/** A layer: only the fields somebody set. */
export type ReviewSettingsOverrides = Partial<ReviewSettings>;

export const REVIEW_SETTING_LIMITS = {
  /** Characters of the project rules. PR-Agent puts them into every prompt, so they cost tokens on each call. */
  extraInstructionsMaxChars: 4000,
  maxFindings: { min: 1, max: 30 },
  /** Below the lower bound the prompts of PR-Agent leave no room for a diff; the upper bound is above every context window in use. */
  maxTokens: { min: 8_000, max: 2_000_000 },
} as const;

/** The limits of the project-only settings (#194): the skill override is data and is bounded in bytes. */
export const PROJECT_DYNAMIC_LIMITS = {
  /** UTF-8 bytes of a skill override. 16 KiB, inside the 64 KiB HTTP body bound. */
  reviewSkillMaxBytes: 16 * 1024,
} as const;

/** PR-Agent's own limit is 32000; the point of this setting is to go well beyond it. */
export const DEFAULT_MAX_TOKENS = 100_000;
export const DEFAULT_MAX_FINDINGS = 5;

/**
 * The project-only values nobody has changed: Diff Review, the shipped Dynamic model and the shipped
 * default skill.
 */
export function builtInProjectDynamicSettings(
  dynamicModel: string = DEFAULT_DYNAMIC_MODEL,
): ProjectDynamicSettings {
  return {
    reviewKind: "diff",
    dynamicModel,
    reviewSkill: null,
  };
}

/**
 * The values nobody has changed. `model` is the instance's model (`LLM_MODEL`, or the default
 * model), which the caller reads from the environment.
 */
export function builtInReviewSettings(
  model: string = DEFAULT_LLM_MODEL,
): ReviewSettings {
  return {
    model,
    fallbackModel: null,
    extraInstructions: "",
    maxFindings: DEFAULT_MAX_FINDINGS,
    maxTokens: DEFAULT_MAX_TOKENS,
    largePrChunking: true,
    inlineKeyIssues: false,
    autoReviewOnOpen: true,
    autoReviewOnPush: true,
    allowedCommands: [...REVIEW_COMMANDS],
  };
}
