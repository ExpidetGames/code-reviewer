// SPDX-License-Identifier: Apache-2.0

// @vitest-environment node
import { describe, expect, expectTypeOf, it } from "vitest";
import { MEMBER_COPY_FORBIDDEN } from "../copy/member-copy-scan.ts";
import {
  CATALOG_STATUSES,
  canTransition,
  checkDescription,
  checkEntryName,
  nameKeyOf,
  nameRevealsModel,
  type CatalogEntry,
} from "./entries.ts";
import { toMemberEntry, type MemberCatalogEntry } from "./member.ts";

const BEHIND = { provider: "openrouter", modelId: "acme-labs/deep-thinker-4" };

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
