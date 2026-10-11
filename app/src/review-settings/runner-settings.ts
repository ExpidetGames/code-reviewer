// Turns the settings of one review into the fields of a runner job. Pure: the settings go in, the
// `llm` fields, the `env` and the fallback models come out, and nothing else.
//
// What the runner accepts (runner/README.md, the job): `llm.model`, `llm.maxTokens` and an `env` of
// strings that may only hold options of the four tools, `PR_REVIEWER__*`, `PR_DESCRIPTION__*`,
// `PR_CODE_SUGGESTIONS__*` and `PR_QUESTIONS__*`. Anything that decides where a credential or a
// request goes (the LLM key, the token of GitHub, endpoints) has its own field of the job or is
// pinned by the runner, so it can never come out of here: this function does not even receive it.
//
// The names below are PR-Agent 0.47.0's settings (`pr_agent/settings/configuration.toml`), checked
// by `runner-settings.test.ts` against `fixtures/pr-agent-0.47.0-configuration.excerpt.toml`.
import type { ReviewSettings } from "./settings.ts";

export type RunnerSettings = {
  /** `llm.model` and `llm.maxTokens` of the job. The provider and the key come from the LLM configuration. */
  llm: { model: string; maxTokens: number };
  /** `env` of the job: only the options of the four tools, as strings. */
  env: Record<string, string>;
  /**
   * The fallback models, in order (none or one today). The contract has the field
   * (`llm.fallbackModels`), but the app does not send it in the MVP: no fallback chain is decided, and
   * `llm.maxTokens` would have to fit the smallest window of the chain. Do not put this into the job
   * until a chain is decided.
   */
  fallbackModels: string[];
};

/** The tools that take project rules. */
const INSTRUCTION_VARIABLES = [
  "PR_REVIEWER__EXTRA_INSTRUCTIONS",
  "PR_DESCRIPTION__EXTRA_INSTRUCTIONS",
  "PR_CODE_SUGGESTIONS__EXTRA_INSTRUCTIONS",
  "PR_QUESTIONS__EXTRA_INSTRUCTIONS",
] as const;

export const MAX_FINDINGS_VARIABLE = "PR_REVIEWER__NUM_MAX_FINDINGS";
export const LARGE_PR_CHUNKING_VARIABLE =
  "PR_REVIEWER__ENABLE_LARGE_PR_CHUNKING";
export const INLINE_KEY_ISSUES_VARIABLE = "PR_REVIEWER__INLINE_KEY_ISSUES";

/**
 * Every variable this module can produce, with the kind of value it holds in PR-Agent. The test
 * checks this table against PR-Agent's own configuration file.
 */
export const RUNNER_ENV_VARIABLES = [
  ...INSTRUCTION_VARIABLES.map((name) => ({ name, kind: "text" as const })),
  { name: MAX_FINDINGS_VARIABLE, kind: "integer" as const },
  { name: LARGE_PR_CHUNKING_VARIABLE, kind: "switch" as const },
  { name: INLINE_KEY_ISSUES_VARIABLE, kind: "switch" as const },
];

// PR-Agent reads its environment through Dynaconf, which interprets the text it finds. Free text is
// therefore not safe to hand over as it is (verified against PR-Agent 0.47.0 with Dynaconf 3.3.5):
//   - "@format {env[OPENROUTER__KEY]}" and "@jinja ..." at the start are *evaluated* and see the
//     whole process environment, which holds the LLM key and the GitHub token. The result goes into
//     the prompt (and so to the model and, through a reply, to the pull request).
//   - other "@..." converters (@merge, @json, @int, ...) change the type, "@get X" ends the run.
//   - the value is read as the right side of a TOML assignment, so a text that is a number, a date, a
//     quoted string, a list or a table ("123", "2026-10-10", "\"quoted\"", "[1, 2]", "{a = 1}") is
//     parsed into that value, and so is a text whose *first token* is "true", "false", "inf" or
//     "nan", whatever follows it: a "#" comment, or a line break and more lines ("true\nfoo = 1").
// All of that only happens when the text *starts* in a way that looks like such a value, and
// Dynaconf's check does not skip a leading line break. A text that starts with anything but a letter,
// or whose first token is one of those four words, therefore gets one line break in front: the prompt
// reads the same, and the text stays a plain string. Any other text is passed on exactly as it is.
const LITERAL_FIRST_TOKEN = /^(true|false|inf|nan)(?![\p{L}\p{N}_])/iu;

export function protectFromSettingsParser(text: string): string {
  if (text === "") return text;
  if (!/^\p{L}/u.test(text) || LITERAL_FIRST_TOKEN.test(text))
    return `\n${text}`;
  return text;
}

/**
 * The runner job fields for a review. Variables of settings that are off or empty are left out, not
 * set to an empty string or to "false": an empty text would replace what a repository's own
 * `.pr_agent.toml` says, and the switches are off in PR-Agent unless set.
 */
export function toRunnerSettings(settings: ReviewSettings): RunnerSettings {
  const env: Record<string, string> = {};

  if (settings.extraInstructions.trim() !== "") {
    const rules = protectFromSettingsParser(settings.extraInstructions);
    for (const name of INSTRUCTION_VARIABLES) env[name] = rules;
  }
  env[MAX_FINDINGS_VARIABLE] = String(settings.maxFindings);
  if (settings.largePrChunking) env[LARGE_PR_CHUNKING_VARIABLE] = "true";
  if (settings.inlineKeyIssues) env[INLINE_KEY_ISSUES_VARIABLE] = "true";

  return {
    llm: { model: settings.model, maxTokens: settings.maxTokens },
    env,
    fallbackModels:
      settings.fallbackModel === null ? [] : [settings.fallbackModel],
  };
}
