// SPDX-License-Identifier: Apache-2.0

// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MODEL_TIERS } from "../model-tiers/tiers.ts";
import { describeErrorCode } from "../runs/error-copy.ts";
import { describeIssue } from "../review-settings/ui/messages.ts";
import * as quality from "./model-quality.ts";

/** Every string the module exports, including the ones inside the levels. */
function allStrings(): string[] {
  const found: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") found.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === "object" && value !== null)
      Object.values(value).forEach(visit);
  };
  visit(quality);
  return found;
}

describe("the copy of the quality levels", () => {
  // #283-T03
  it("has a label and a sentence for each of the three levels", () => {
    expect(quality.QUALITY_LEVELS.map((level) => level.tier)).toEqual([
      ...MODEL_TIERS,
    ]);
    expect(quality.QUALITY_LEVELS.map((level) => level.label)).toEqual([
      "Low",
      "Medium",
      "High",
    ]);
    for (const level of quality.QUALITY_LEVELS)
      expect(level.description.length).toBeGreaterThan(20);
  });

  // #283-T03
  it("describes the levels by speed and depth only: no model, vendor, price or cost", () => {
    const forbidden = [
      /\bmodels?\b/i,
      /\bopenrouter\b|\bopenai\b|\banthropic\b|\bgoogle\b|\bgemini\b|\bclaude\b|\bgpt\b/i,
      /\bdeepseek\b|\bmeta\b|\bllama\b|\bmistral\b|\bqwen\b|\bhaiku\b|\bsonnet\b|\bopus\b/i,
      /[$€£]|\busd\b|\beur\b/i,
      /\bpric|\bcost|\bcheap|\bexpensive|\bfree\b|\bcredit|\btoken|\bbill|\bplan\b/i,
      // The shape of a provider's model id.
      /[a-z0-9-]+\/[a-z0-9][a-z0-9._:-]*/i,
    ];
    const strings = allStrings();
    expect(strings.length).toBeGreaterThan(6);
    for (const text of strings)
      for (const pattern of forbidden) expect(text).not.toMatch(pattern);
  });

  // #283-T03
  it("speaks of speed for the lighter level and of depth for the deeper one", () => {
    const [low, medium, high] = quality.QUALITY_LEVELS;
    expect(low?.description).toMatch(/faster/i);
    expect(low?.description).toMatch(/lighter/i);
    expect(medium?.description).toMatch(/balance/i);
    expect(high?.description).toMatch(/slower/i);
    expect(high?.description).toMatch(/deeper/i);
  });

  // #283-T03
  it("also holds for the other sentences a member reads about this: the refused model write and the unavailable level", () => {
    const sentences = [
      describeIssue("model", "MODEL_MANAGED_BY_INSTANCE"),
      describeIssue("dynamicModel", "MODEL_MANAGED_BY_INSTANCE"),
      describeErrorCode("managed_tier_unavailable").text,
    ];
    // "the AI models" and "no AI model was used" say that a model exists, not which one.
    const forbidden = [
      /\b(?<!AI )models?\b(?! (?:was|were) used)/i,
      /\bopenrouter\b|\bopenai\b|\banthropic\b|\bgoogle\b|\bgemini\b|\bclaude\b|\bgpt\b/i,
      /\bdeepseek\b|\bmeta\b|\bllama\b|\bmistral\b|\bqwen\b|\bhaiku\b|\bsonnet\b|\bopus\b/i,
      /[$€£]|\busd\b|\beur\b/i,
      /\bpric|\bcost|\bcheap|\bexpensive|\bcredit|\btoken|\bbill/i,
      /[a-z0-9-]+\/[a-z0-9][a-z0-9._:-]*/i,
    ];
    for (const text of sentences) {
      expect(text.length).toBeGreaterThan(20);
      for (const pattern of forbidden) expect(text).not.toMatch(pattern);
    }
  });
});
