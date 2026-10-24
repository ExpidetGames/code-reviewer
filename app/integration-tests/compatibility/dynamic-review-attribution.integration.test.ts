// SPDX-License-Identifier: LicenseRef-Proprietary

// #198-T07: the packaged default skill and the fixed core carry exact, immutable upstream
// provenance, and every notice the adapted licenses require is present. The asset is the one the app
// ships (the embedded copy in default-skill.ts), so the audit covers what a user edits and the runner
// composes. The dependency license policy itself is checked by `make check-licenses`; this test only
// audits the adapted prompt text and its attribution.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_SKILL } from "../../src/review-settings/default-skill.ts";
import { CONTRACTS_DIRECTORY } from "../../src/test-support/runner-contract.ts";

// The repository root, from `app/integration-tests/compatibility/`.
const REPO_ROOT = join(CONTRACTS_DIRECTORY, "..");
const asset = readFileSync(
  join(CONTRACTS_DIRECTORY, "dynamic-review", "review-skill.md"),
  "utf8",
);
const notice = readFileSync(join(REPO_ROOT, "NOTICE"), "utf8");
const thirdParty = readFileSync(
  join(REPO_ROOT, "THIRD_PARTY_LICENSES.md"),
  "utf8",
);

// The exact upstream revisions the adapted passages were read at (#120, #198).
const CODEX_RUBRIC_BLOB = "85e89cb7eeadb97fa9e4868d2b9977c87225506d";
const CODEX_RUBRIC_COMMIT = "81de4f251cfdaf32ecb85e2160ebfc11a562d44b";
const CODEX_SKILL_BLOB = "c694020c1c5de0e8fee4e933f55e0f6b3d055d8a";
const CODEX_SKILL_COMMIT = "83a418783707f4446aa832b2799d6cacfef75011";
const GEMINI_BLOB = "af6079ff60f320c729e1da77d942173a90d63333";
const GEMINI_COMMIT = "3ca2577f2714990269a7378904cf70ae1e01e288";

describe("the Dynamic Review prompt attribution", () => {
  // #198-T07: the shipped asset is exactly the app's copy.
  it("is the skill the app ships", () => {
    expect(DEFAULT_REVIEW_SKILL.text).toBe(asset);
  });

  // #198-T07: the asset records the immutable upstream revisions and the LICENSE/notice duties.
  it("records the exact OpenAI Codex revisions and the modifications in the asset", () => {
    expect(asset).toContain(`codex-rs/prompts/templates/review/rubric.md`);
    expect(asset).toContain(
      `codex-rs/skills/src/assets/samples/review-agent/SKILL.md`,
    );
    for (const marker of [
      CODEX_RUBRIC_BLOB,
      CODEX_RUBRIC_COMMIT,
      CODEX_SKILL_BLOB,
      CODEX_SKILL_COMMIT,
      "Apache-2.0",
      "Copyright 2025 OpenAI",
      "Modifications for Code Reviewer",
    ])
      expect(asset).toContain(marker);
  });

  // #198-T07: NOTICE/THIRD_PARTY_LICENSES.md carry what the Apache-2.0 (Codex, run-gemini-cli) and
  // MIT (PR-Agent) licenses require, including the upstream Codex NOTICE.
  it("carries the required notices and the upstream NOTICE", () => {
    for (const marker of [
      "OpenAI Codex",
      "Copyright 2025 OpenAI",
      "Apache License, Version 2.0",
      "ratatui",
      "run-gemini-cli",
      "Input Demarcation",
      "untrusted",
    ])
      expect(notice).toContain(marker);

    for (const marker of [
      CODEX_RUBRIC_BLOB,
      CODEX_RUBRIC_COMMIT,
      CODEX_SKILL_BLOB,
      CODEX_SKILL_COMMIT,
      GEMINI_BLOB,
      GEMINI_COMMIT,
      "OpenAI Codex",
      "Apache-2.0",
      "run-gemini-cli",
      "pr_code_suggestions_prompts.toml",
    ])
      expect(thirdParty).toContain(marker);
  });
});
