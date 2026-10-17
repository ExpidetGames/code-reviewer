// SPDX-License-Identifier: Apache-2.0

// @vitest-environment node
import { describe, expect, expectTypeOf, it } from "vitest";
import { MEMBER_COPY_FORBIDDEN } from "../copy/member-copy-scan.ts";
import {
  CATALOG_STATUSES,
  canTransition,
  checkDescription,
  checkEntryName,
  descriptionRevealsModel,
  nameKeyOf,
  nameRevealsModel,
  type CatalogEntry,
} from "./entries.ts";
import { toMemberEntry, type MemberCatalogEntry } from "./member.ts";

const BEHIND = { provider: "openrouter", modelId: "acme-labs/deep-thinker-4" };
const SONNET = {
  provider: "openrouter",
  modelId: "anthropic/claude-sonnet-5-5",
};
const GROK = { provider: "openrouter", modelId: "x-ai/grok-4-fast:free" };

describe("the name of a catalog entry", () => {
  it("accepts 1 to 40 printable characters, trimmed, and keys it case-insensitively", () => {
    expect(checkEntryName("Fast")).toEqual({
      ok: true,
      name: "Fast",
      key: "fast",
    });
    expect(checkEntryName("x".repeat(40))).toMatchObject({ ok: true });
    expect(checkEntryName("Größe Ⅷ")).toMatchObject({ ok: true });
    expect(nameKeyOf("FAST")).toBe(nameKeyOf("fast"));
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["too long", "x".repeat(41)],
    ["padded", " Fast"],
    ["a line break", "Fast\nDeep"],
    ["a control character", "Fast\u0007"],
    ["a zero width character", "Fa​st"],
    ["not a string", 7],
  ])("refuses a name that is %s", (_label, value) => {
    expect(checkEntryName(value)).toEqual({ ok: false, code: "name_invalid" });
  });

  // #425-T05
  it.each([
    ["the model id", "Acme-Labs/Deep-Thinker-4 plus"],
    ["the slug", "My DEEP-thinker-4"],
    ["the provider", "OpenRouter fast"],
  ])("is refused when it contains %s of the entry", (_label, name) => {
    expect(nameRevealsModel(name, BEHIND)).toBe(true);
  });

  // #425-T05
  it("is not refused for a name that shares nothing with the model", () => {
    expect(nameRevealsModel("Deep", BEHIND)).toBe(false);
    expect(nameRevealsModel("Thorough", BEHIND)).toBe(false);
    expect(nameRevealsModel("Medium", SONNET)).toBe(false);
    expect(nameRevealsModel("Medium", GROK)).toBe(false);
  });

  // #425-T05
  it.each([
    ["spaces for dashes", "Claude Sonnet 5 5"],
    ["a dot for the last dash", "Claude Sonnet 5.5"],
    ["underscores", "claude_sonnet_5_5"],
    ["fullwidth letters", "ｃｌａｕｄｅ-ｓｏｎｎｅｔ-５-５"],
    ["the vendor and the model id", "anthropic/claude-sonnet-5-5"],
    ["extra words around it", "The Claude-Sonnet 5.5 option"],
  ])("is refused for a model id written with %s", (_label, name) => {
    expect(nameRevealsModel(name, SONNET)).toBe(true);
  });

  // #425-T05
  it.each([
    ["the slug without its variant", "grok-4-fast"],
    ["the slug without its variant, spelled with spaces", "Grok 4 Fast"],
    ["the slug with its variant", "grok-4-fast:free"],
    ["the id without its variant", "x-ai/grok-4-fast"],
  ])("is refused for %s of an id with a :variant", (_label, name) => {
    expect(nameRevealsModel(name, GROK)).toBe(true);
  });

  // #425-T05
  it("does not let a very short model id block names (below four letters and digits nothing is compared)", () => {
    const short = { provider: "openrouter", modelId: "vendor/o1" };
    expect(nameRevealsModel("Solo one", short)).toBe(false);
  });
});

describe("the description of a catalog entry against its own model", () => {
  // #425-T06
  it.each([
    ["the slug", "Runs grok-4-fast for quick feedback", GROK],
    [
      "a name that is the slug in other letters",
      "Grok 4 Fast, always on",
      GROK,
    ],
    ["the family name alone", "Powered by Grok 4", GROK],
    ["the vendor", "From xAI", GROK],
    ["the vendor spelled with a dash", "Built by x-ai", GROK],
    ["the vendor spelled apart", "Made by X AI", GROK],
    [
      "a token of the slug",
      "qwen3 coder",
      {
        provider: "openrouter",
        modelId: "qwen/qwen3-coder",
      },
    ],
    [
      "the vendor of a model with a dash",
      "Llama based",
      {
        provider: "openrouter",
        modelId: "meta-llama/llama-4-maverick",
      },
    ],
    ["the brand in the slug", "A Sonnet for your code", SONNET],
    ["the vendor", "Anthropic's pick", SONNET],
    ["fullwidth letters", "ｇｒｏｋ", GROK],
  ])("is refused when it names %s", (_label, text, behind) => {
    expect(descriptionRevealsModel(text, behind)).toBe(true);
  });

  // #425-T06
  it("compares the slug as a whole as well, for a slug whose single words are too short to be compared", () => {
    const short = { provider: "openrouter", modelId: "vendor/abc-12" };
    expect(descriptionRevealsModel("Our abc 12 option", short)).toBe(true);
    expect(descriptionRevealsModel("Our abc option", short)).toBe(false);
  });

  // #425-T06
  it.each([
    ["Medium reviews with a good balance", SONNET],
    ["Fast and thorough", GROK],
    [
      "Quick reviews that point out the obvious problems.",
      {
        provider: "openrouter",
        modelId: "acme/quick-1",
      },
    ],
    ["Deep analysis of larger changes", BEHIND],
  ])("is not refused for a plain sentence: %s", (text, behind) => {
    expect(descriptionRevealsModel(text, behind)).toBe(false);
  });

  // #425-T06
  it("does not cover a brand that the model id does not contain", () => {
    // Documented limit: only what is derivable from the id (provider, vendor, slug) is compared. The generic scan
    // of the copy (copy/member-copy-scan.ts) knows the common brand names, nothing knows all of them.
    expect(
      descriptionRevealsModel("Made by Moonshot", {
        provider: "openrouter",
        modelId: "acme/rocket-1",
      }),
    ).toBe(false);
  });
});

describe("the description of a catalog entry", () => {
  it("is optional: absent, null and blank read as none", () => {
    for (const value of [undefined, null, "", "   "])
      expect(checkDescription(value)).toEqual({ ok: true, description: null });
  });

  it("accepts a sentence about speed and depth", () => {
    expect(
      checkDescription("  Quick reviews that look at the obvious problems. "),
    ).toEqual({
      ok: true,
      description: "Quick reviews that look at the obvious problems.",
    });
  });

  // #425-T06
  it.each([
    "Runs the Claude family of models",
    "Powered by OpenAI",
    "Costs a few cents per review",
    "Cheap and fast",
    "About $2 per run",
    "Uses acme-labs/deep-thinker-4",
    "Included in the Pro plan",
    "Burns fewer tokens",
  ])(
    "is refused when it speaks of a vendor, a price or a model: %s",
    (text) => {
      expect(checkDescription(text)).toEqual({
        ok: false,
        code: "description_invalid",
      });
    },
  );

  // #425-T06
  it("is scanned with the very patterns that scan the copy of the quality levels", () => {
    expect(MEMBER_COPY_FORBIDDEN.length).toBeGreaterThan(4);
    for (const pattern of MEMBER_COPY_FORBIDDEN)
      expect(pattern.global || pattern.sticky).toBe(false);
  });

  it.each([
    ["too long", "x".repeat(161)],
    ["on several lines", "Fast.\nDeep."],
    ["not a string", 3],
  ])("is refused when it is %s", (_label, value) => {
    expect(checkDescription(value)).toEqual({
      ok: false,
      code: "description_invalid",
    });
  });
});

describe("the status of a catalog entry", () => {
  it("moves draft to released, released to retired and retired to released", () => {
    expect(CATALOG_STATUSES).toEqual(["draft", "released", "retired"]);
    expect(canTransition("draft", "released")).toBe(true);
    expect(canTransition("released", "retired")).toBe(true);
    expect(canTransition("retired", "released")).toBe(true);
  });

  it("never goes back to draft, never skips release and never stays", () => {
    expect(canTransition("draft", "retired")).toBe(false);
    expect(canTransition("released", "draft")).toBe(false);
    expect(canTransition("retired", "draft")).toBe(false);
    for (const status of CATALOG_STATUSES)
      expect(canTransition(status, status)).toBe(false);
  });
});

describe("what a member sees of a catalog entry", () => {
  const entry: CatalogEntry = {
    id: "mce_0123456789abcdef0123456789abcdef",
    name: "Deep",
    description: "Slower, deeper reviews.",
    provider: "sentinel-provider",
    modelId: "sentinel-vendor/sentinel-model",
    kinds: ["diff", "dynamic"],
    status: "released",
    sortOrder: 2,
    createdAt: "2026-10-17T10:00:00.000Z",
    updatedAt: "2026-10-17T10:00:00.000Z",
    updatedBy: "user-1",
  };

  // #425-T07
  it("has no provider and no model id in its type", () => {
    expectTypeOf<MemberCatalogEntry>().not.toHaveProperty("provider");
    expectTypeOf<MemberCatalogEntry>().not.toHaveProperty("modelId");
    expectTypeOf<MemberCatalogEntry>().not.toHaveProperty("model_id");
    expectTypeOf<keyof MemberCatalogEntry>().toEqualTypeOf<
      "id" | "name" | "description" | "kinds" | "status" | "sortOrder"
    >();
  });

  // #425-T07
  it("has no provider and no model id in the object, whatever the entry carried", () => {
    const projected = toMemberEntry(entry);

    expect(Object.keys(projected).sort()).toEqual([
      "description",
      "id",
      "kinds",
      "name",
      "sortOrder",
      "status",
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/sentinel/);
    expect(projected).toEqual({
      id: entry.id,
      name: "Deep",
      description: "Slower, deeper reviews.",
      kinds: ["diff", "dynamic"],
      status: "released",
      sortOrder: 2,
    });
  });
});
