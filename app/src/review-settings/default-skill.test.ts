// SPDX-License-Identifier: Apache-2.0

// Pins down the shipped default-skill seam (#194): the identity the app exposes must match the text,
// and the placeholder text must itself fit the size limit a project override is held to. #198 replaces
// the text with the attributed asset; this test keeps the identity and the reader honest.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_SKILL,
  readDefaultReviewSkill,
} from "./default-skill.ts";
import { PROJECT_DYNAMIC_LIMITS } from "./settings.ts";

describe("the shipped default review skill", () => {
  it("has a hash that matches its text", () => {
    const hash = createHash("sha256")
      .update(DEFAULT_REVIEW_SKILL.text, "utf8")
      .digest("hex");

    expect(DEFAULT_REVIEW_SKILL.hash).toBe(hash);
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
    expect(DEFAULT_REVIEW_SKILL.id).not.toBe("");
    expect(DEFAULT_REVIEW_SKILL.version).not.toBe("");
  });
});
