// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how review settings become runner job fields: each setting lands in the PR-Agent variable
// it belongs to (names checked against the settings file of the pinned PR-Agent version), switches
// that are off leave no variable, free text stays one value and cannot be read as anything else, and
// the result holds nothing a runner job must not get from here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INLINE_KEY_ISSUES_VARIABLE,
  LARGE_PR_CHUNKING_VARIABLE,
  MAX_FINDINGS_VARIABLE,
  RUNNER_ENV_VARIABLES,
  protectFromSettingsParser,
  toRunnerSettings,
} from "./runner-settings.ts";
import { RUNNER_ENV_KEY_PATTERN } from "../runner-api/contract.ts";
import { builtInReviewSettings, type ReviewSettings } from "./settings.ts";

const base = builtInReviewSettings("deepseek/deepseek-v3.2");
const withSettings = (changes: Partial<ReviewSettings>): ReviewSettings => ({
  ...base,
  ...changes,
});

// Section -> key -> the default as written in PR-Agent's file (comments cut off).
function readExcerpt(): Map<string, Map<string, string>> {
  const text = readFileSync(
    join(
      import.meta.dirname,
      "fixtures/pr-agent-0.47.0-configuration.excerpt.toml",
    ),
    "utf8",
  );
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const line of text.split("\n")) {
    const header = /^\[([a-z_]+)\]$/.exec(line);
    if (header?.[1] !== undefined) {
      current = new Map();
      sections.set(header[1], current);
      continue;
    }
    const entry = /^([a-z_]+)\s*=\s*(.*?)\s*(#.*)?$/.exec(line);
    if (entry?.[1] !== undefined && entry[2] !== undefined && current)
      current.set(entry[1], entry[2]);
  }
  return sections;
}

describe("the PR-Agent variable names", () => {
  // CR-25-T03
  it.each(RUNNER_ENV_VARIABLES)(
    "$name is an option of the pinned PR-Agent version with the kind of value we send",
    ({ name, kind }) => {
      const [prefix = "", ...rest] = name.split("__");
      const section = prefix.toLowerCase();
      const key = rest.join("__").toLowerCase();

      const fallback = readExcerpt().get(section)?.get(key);

      expect(
        fallback,
        `${section}.${key} in PR-Agent's settings`,
      ).toBeDefined();
      if (kind === "text") expect(fallback).toBe('""');
      if (kind === "integer") expect(fallback).toMatch(/^-?\d+$/);
      // A switch that is off sets no variable, which only means "off" while PR-Agent's own value is off.
      if (kind === "switch") expect(fallback).toBe("false");
    },
  );

  // CR-46-T06
  it("never include an option the runner reserves for itself", () => {
    // The runner pins these (CR-45, `RESERVED_OPTIONS`) and refuses a job that sets them.
    const reserved = [
      "PR_REVIEWER__FINAL_UPDATE_MESSAGE",
      "PR_DESCRIPTION__FINAL_UPDATE_MESSAGE",
      "PR_REVIEWER__ENABLE_REVIEW_LABELS_SECURITY",
      "PR_REVIEWER__ENABLE_REVIEW_LABELS_EFFORT",
    ];
    const names = RUNNER_ENV_VARIABLES.map(({ name }) => name);

    for (const name of reserved) expect(names).not.toContain(name);
  });

  it("are accepted by the runner's allowlist of job variables", () => {
    for (const { name } of RUNNER_ENV_VARIABLES)
      expect(name).toMatch(RUNNER_ENV_KEY_PATTERN);
  });
});

describe("mapping review settings to a runner job", () => {
  // CR-25-T03
  it("sends the model and the token budget as the llm fields of the job", () => {
    const result = toRunnerSettings(
      withSettings({ model: "qwen/qwen3-coder", maxTokens: 150_000 }),
    );

    expect(result.llm).toEqual({
      model: "qwen/qwen3-coder",
      maxTokens: 150_000,
    });
  });

  // CR-25-T03
  it("keeps the fallback model apart from the job, which has no field for it", () => {
    const result = toRunnerSettings(
      withSettings({ fallbackModel: "qwen/qwen3-coder" }),
    );

    expect(result.fallbackModels).toEqual(["qwen/qwen3-coder"]);
    expect(JSON.stringify(result.env)).not.toContain("qwen/qwen3-coder");
    expect(Object.keys(result.llm)).toEqual(["model", "maxTokens"]);
  });

  // CR-25-T03
  it.each([1, 5, 30])("sends %i as the maximum number of findings", (count) => {
    const result = toRunnerSettings(withSettings({ maxFindings: count }));

    expect(result.env[MAX_FINDINGS_VARIABLE]).toBe(String(count));
  });

  // CR-25-T03, #203
  it("sends the project rules to the review tool", () => {
    const result = toRunnerSettings(
      withSettings({ extraInstructions: "Check the tests." }),
    );

    expect(result.env).toMatchObject({
      PR_REVIEWER__EXTRA_INSTRUCTIONS: "Check the tests.",
    });
    expect(
      Object.keys(result.env).filter((name) => name.includes("EXTRA")),
    ).toEqual(["PR_REVIEWER__EXTRA_INSTRUCTIONS"]);
  });

  // CR-25-T04
  it.each([
    ["largePrChunking", LARGE_PR_CHUNKING_VARIABLE],
    ["inlineKeyIssues", INLINE_KEY_ISSUES_VARIABLE],
  ] as const)(
    "sets %s's variable when the switch is on and leaves it out when it is off",
    (field, variable) => {
      expect(
        toRunnerSettings(withSettings({ [field]: true })).env[variable],
      ).toBe("true");
      expect(
        variable in toRunnerSettings(withSettings({ [field]: false })).env,
      ).toBe(false);
    },
  );

  // CR-25-T04
  it("does not send triggers or commands to PR-Agent, whatever they are", () => {
    for (const changes of [
      { autoReviewOnOpen: false, autoReviewOnPush: false, allowedCommands: [] },
      { autoReviewOnOpen: true, autoReviewOnPush: true },
      { allowedCommands: ["review" as const] },
    ] as Partial<ReviewSettings>[]) {
      const withChange = toRunnerSettings(withSettings(changes));

      expect(withChange).toEqual(toRunnerSettings(base));
    }
  });

  // CR-25-T05
  it("leaves out the variables of rules and a fallback that are not set, and never sends an empty string", () => {
    const result = toRunnerSettings(
      withSettings({ extraInstructions: "", fallbackModel: null }),
    );

    expect(result.fallbackModels).toEqual([]);
    expect(
      Object.keys(result.env).filter((name) => name.includes("EXTRA")),
    ).toEqual([]);
    for (const value of Object.values(result.env)) expect(value).not.toBe("");
  });

  it("treats rules that are only spaces and line breaks as none", () => {
    const result = toRunnerSettings(
      withSettings({ extraInstructions: " \n " }),
    );

    expect(Object.keys(result.env)).toEqual([
      MAX_FINDINGS_VARIABLE,
      LARGE_PR_CHUNKING_VARIABLE,
    ]);
  });

  // CR-25-T06
  it.each([
    ["line breaks", "First rule.\nSecond rule.\r\nThird rule."],
    ["quotes", "Never write \"TODO\" or 'FIXME'."],
    ["equals signs", "Names must be a=b style: key = value, x==y."],
    ["Unicode", "Prüfe die Übersetzung ✓ 🚀 中文"],
    [
      "hash signs and braces",
      "Flag # comments and {{ templates }} and ${vars}",
    ],
  ])("passes project rules with %s on unchanged", (_label, text) => {
    const result = toRunnerSettings(withSettings({ extraInstructions: text }));

    expect(result.env.PR_REVIEWER__EXTRA_INSTRUCTIONS).toBe(text);
  });

  // CR-25-T09
  it.each([
    "x\nCONFIG.MODEL=evil",
    "Rules\nOPENROUTER__KEY=stolen\nGITHUB__BASE_URL=http://evil",
    "$(rm -rf /)",
    "; env",
    "`id` && cat /etc/passwd",
    "Rules\n\n[config]\nmodel = 'evil'",
  ])(
    "keeps the rules %j as one value and creates no other variable",
    (text) => {
      const result = toRunnerSettings(
        withSettings({ extraInstructions: text }),
      );

      expect(Object.keys(result.env).sort()).toEqual(
        [
          LARGE_PR_CHUNKING_VARIABLE,
          MAX_FINDINGS_VARIABLE,
          "PR_REVIEWER__EXTRA_INSTRUCTIONS",
        ].sort(),
      );
      // The whole text is the value; at most one line break is put in front of it (see below).
      expect(
        result.env.PR_REVIEWER__EXTRA_INSTRUCTIONS?.replace(/^\n/, ""),
      ).toBe(text);
      expect(result.llm.model).toBe(base.model);
    },
  );

  // CR-25-T10
  it("holds only variables of the four tools and the llm fields, for any combination of settings", () => {
    const models = ["deepseek/deepseek-v3.2", "qwen/qwen3-coder"];
    const rules = ["", "Be strict.", "@format {env[X]}", "OPENROUTER__KEY=x"];
    const switches = [true, false];

    for (const model of models)
      for (const extraInstructions of rules)
        for (const flag of switches) {
          const result = toRunnerSettings(
            withSettings({
              model,
              extraInstructions,
              fallbackModel: flag ? "qwen/qwen3-coder" : null,
              largePrChunking: flag,
              inlineKeyIssues: !flag,
              autoReviewOnOpen: flag,
              allowedCommands: flag ? ["review"] : [],
            }),
          );

          expect(Object.keys(result).sort()).toEqual([
            "env",
            "fallbackModels",
            "llm",
          ]);
          expect(Object.keys(result.llm)).toEqual(["model", "maxTokens"]);
          for (const name of Object.keys(result.env))
            expect(name).toMatch(RUNNER_ENV_KEY_PATTERN);
        }
  });

  it("returns a new object each time and does not change its input", () => {
    const settings = withSettings({ extraInstructions: "Be strict." });
    const before = structuredClone(settings);

    const first = toRunnerSettings(settings);
    first.env.PR_REVIEWER__EXTRA_INSTRUCTIONS = "changed";

    expect(settings).toEqual(before);
    expect(toRunnerSettings(settings).env.PR_REVIEWER__EXTRA_INSTRUCTIONS).toBe(
      "Be strict.",
    );
  });
});

describe("protecting free text from PR-Agent's settings parser", () => {
  // CR-25-T09. The table is what PR-Agent 0.47.0 with Dynaconf 3.3.5 does with such an environment
  // value (measured with its own settings loader): the left column is turned into something else,
  // the right column of "safe" texts stays a string.
  it.each([
    "@format {env[OPENROUTER__KEY]}",
    "@jinja {{ env.OPENROUTER__KEY }}",
    "@merge a=1",
    "@get X",
    "@int 5",
    "123",
    "1.5",
    "0x10",
    "1_000",
    "+5",
    "-5",
    "2026-10-10",
    '"quoted"',
    "'single'",
    "[1, 2]",
    "{a = 1}",
    "true",
    "false",
    "True",
    "False",
    "inf",
    "nan",
    "true # a comment",
    "true\nfoo = 1",
    "nan\n\nA=1",
    "nan # c\nz=3",
    "True\nb = 2",
    "inf\nx",
    "true story",
    "true.",
    "123 abc",
    "false\n",
    "  true",
    "\ttrue",
    "-inf",
    "@",
    "# comment",
    "✓ starts with a symbol",
  ])("puts a line break in front of %j", (text) => {
    expect(protectFromSettingsParser(text)).toBe(`\n${text}`);
  });

  it.each([
    "plain text",
    "trueish\nfoo = 1",
    "information\nfoo = 1",
    "nancy",
    "Use {env[OPENROUTER__KEY]} here",
    "Check this.\n@format {env[OPENROUTER__KEY]}",
    "x @format {env[OPENROUTER__KEY]}",
    "a = 1",
    "none and some more",
    'Über "quotes"',
    "line1\nline2",
    "rm -rf / is not a command here",
  ])("passes %j on as it is", (text) => {
    expect(protectFromSettingsParser(text)).toBe(text);
  });

  it("leaves an empty text empty", () => {
    expect(protectFromSettingsParser("")).toBe("");
  });

  it("protects a text that starts with an evaluated converter when it is sent as project rules", () => {
    const result = toRunnerSettings(
      withSettings({ extraInstructions: "@format {env[OPENROUTER__KEY]}" }),
    );

    expect(result.env.PR_REVIEWER__EXTRA_INSTRUCTIONS).toBe(
      "\n@format {env[OPENROUTER__KEY]}",
    );
  });
});
