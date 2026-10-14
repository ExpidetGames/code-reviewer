// SPDX-License-Identifier: Apache-2.0

// Pins down the shipped default-skill seam (#194, completed by #198): the identity the app exposes
// must match the text, the text must be the one canonical asset the app and the runner share
// (`contracts/dynamic-review/review-skill.md`, embedded because the app image ships only `app/`), and
// it must carry the upstream provenance and its size limit.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACTS_DIRECTORY } from "../test-support/runner-contract.ts";
import {
  DEFAULT_REVIEW_SKILL,
  readDefaultReviewSkill,
} from "./default-skill.ts";
import { PROJECT_DYNAMIC_LIMITS } from "./settings.ts";

const CANONICAL_ASSET = join(
  CONTRACTS_DIRECTORY,
  "dynamic-review",
  "review-skill.md",
);
const canonicalText = readFileSync(CANONICAL_ASSET, "utf8");

describe("the shipped default review skill", () => {
  it("has a hash that matches its text", () => {
    const hash = createHash("sha256")
      .update(DEFAULT_REVIEW_SKILL.text, "utf8")
      .digest("hex");

    expect(DEFAULT_REVIEW_SKILL.hash).toBe(hash);
  });

  // #198-T01: the app and the runner share one asset; the embedded copy must be that asset exactly.
  it("is the canonical asset under contracts/dynamic-review, byte for byte", () => {
    expect(Buffer.from(DEFAULT_REVIEW_SKILL.text, "utf8")).toStrictEqual(
      Buffer.from(canonicalText, "utf8"),
    );
  });

  it("fits the size limit a project override is held to", () => {
    const bytes = Buffer.byteLength(DEFAULT_REVIEW_SKILL.text, "utf8");

    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(
      PROJECT_DYNAMIC_LIMITS.reviewSkillMaxBytes,
    );
  });

  it("is handed out by the reader seam with a stable id and version", () => {
    expect(readDefaultReviewSkill()).toBe(DEFAULT_REVIEW_SKILL);
    expect(DEFAULT_REVIEW_SKILL.id).toBe("codex-review-skill");
    expect(DEFAULT_REVIEW_SKILL.version).toMatch(/^\d+$/);
  });
});
