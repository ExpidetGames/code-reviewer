// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment node
import { describe, expect, it } from "vitest";
import { describeErrorCode } from "../runs/error-copy.ts";
import { describeIssue } from "../review-settings/ui/messages.ts";
import { MEMBER_COPY_FORBIDDEN } from "./member-copy-scan.ts";
import { getProductIdentity } from "../product-identity/current.ts";
import * as choice from "./model-choice.ts";

/** Every string the module exports. */
function allStrings(): string[] {
  const found: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") found.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === "object" && value !== null)
      Object.values(value).forEach(visit);
  };
  visit(choice);
  visit(choice.modelChoiceWords(getProductIdentity()));
  return found;
}

/**
 * The sentences about the plan have to say "plan"; everything else about it is scanned as usual. The one note that names
 * the billing source (#675) has to say "billed"; it names no amount and no price.
 */
function withoutThePlanWord(text: string): string {
  return text
    .replace(choice.modelChoiceWords(getProductIdentity()).billedNote, "")
    .replace(/\bplan\b/gi, "");
}

describe("the copy of the generic chooser", () => {
  // #433-T08
  it("names no model, vendor, price or cost in any string it exports", () => {
    const strings = allStrings();
    expect(strings.length).toBeGreaterThan(8);
    for (const text of strings)
      for (const pattern of MEMBER_COPY_FORBIDDEN)
        expect(withoutThePlanWord(text)).not.toMatch(pattern);
  });

  // #433-T08
  it("has the sentences the chooser needs: the locked badge, the link to the plan and the unavailable choice", () => {
    expect(choice.MODEL_CHOICE_HEADING).toBe("Quality");
    expect(choice.MODEL_CHOICE_LOCKED_BADGE).toBe("Not included in your plan");
    expect(choice.MODEL_CHOICE_MANAGE_PLAN).toBe("Manage plan");
    expect(choice.MODEL_CHOICE_CHOSEN_UNAVAILABLE).toMatch(
      /reviews do not start/,
    );
    expect(choice.MODEL_CHOICE_RETIRED_BADGE.length).toBeGreaterThan(5);
  });

  // #433-T08
  it("also holds for the other sentences a member reads about this: the refused writes", () => {
    const sentences = [
      describeIssue("model", "MODEL_MANAGED_BY_INSTANCE"),
      describeIssue("dynamicModel", "MODEL_MANAGED_BY_INSTANCE"),
      describeIssue("provider", "MODEL_MANAGED_BY_INSTANCE"),
      describeIssue("catalogEntryDiff", "CATALOG_ENTRY_UNKNOWN"),
      describeIssue("catalogEntryDiff", "CATALOG_ENTRY_NOT_RELEASED"),
      describeIssue("catalogEntryDynamic", "CATALOG_ENTRY_KIND_MISMATCH"),
      describeIssue("catalogEntryDynamic", "CATALOG_ENTRY_NOT_ALLOWED"),
      describeErrorCode("managed_tier_unavailable").text,
    ];
    // "the AI models" and "no AI model was used" say that a model exists, not which one.
    const forbidden = [
      /\b(?<!AI )models?\b(?! (?:was|were) used)/i,
      ...MEMBER_COPY_FORBIDDEN.slice(1),
    ];
    for (const text of sentences) {
      expect(text.length).toBeGreaterThan(20);
      for (const pattern of forbidden)
        expect(withoutThePlanWord(text)).not.toMatch(pattern);
    }
  });
});
