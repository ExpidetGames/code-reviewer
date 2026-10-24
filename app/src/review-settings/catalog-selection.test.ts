// SPDX-License-Identifier: Apache-2.0

// The pure rules of the catalog selection (#430): why an entry may not be chosen, what the picker lists, and that the
// names of the settings are the ones the catalog counts the projects by.
import { describe, expect, it } from "vitest";
import { CATALOG_SELECTION_KEYS } from "../db/repositories/catalog-repository.ts";
import type { MemberCatalogEntry } from "../model-catalog/member.ts";
import {
  catalogChoices,
  refusalOfChoice,
  type CatalogSelectionSource,
} from "./catalog-selection.ts";
import { CATALOG_FIELD_OF_KIND, PROJECT_CATALOG_FIELDS } from "./settings.ts";

function entry(
  id: string,
  overrides: Partial<MemberCatalogEntry> = {},
): MemberCatalogEntry {
  return {
    id,
    name: id,
    description: null,
    providerLabel: "Anthropic",
    kinds: ["diff", "dynamic"],
    status: "released",
    sortOrder: 0,
    ...overrides,
  };
}

function sourceOf(
  entries: MemberCatalogEntry[],
  options: { forbidden?: string[] } = {},
): CatalogSelectionSource {
  return {
    entries: async () => entries,
    find: async (id) => {
      const found = entries.find((candidate) => candidate.id === id);
      return found === undefined
        ? undefined
        : { status: found.status, kinds: found.kinds };
    },
    allowed: async (id) => !(options.forbidden ?? []).includes(id),
  };
}

describe("the settings that hold a catalog entry", () => {
  // #430-T01
  it("are the ones the catalog counts the projects that select an entry by", () => {
    expect([...CATALOG_SELECTION_KEYS]).toEqual([...PROJECT_CATALOG_FIELDS]);
    expect(CATALOG_FIELD_OF_KIND).toEqual({
      diff: "catalogEntryDiff",
      dynamic: "catalogEntryDynamic",
    });
  });
});

describe("whether a project may choose an entry", () => {
  const source = sourceOf(
    [
      entry("ok"),
      entry("draft", { status: "draft" }),
      entry("retired", { status: "retired" }),
      entry("diff-only", { kinds: ["diff"] }),
      entry("locked"),
    ],
    { forbidden: ["locked"] },
  );

  // #430-T07
  it.each([
    ["ok", "diff", null],
    ["ok", "dynamic", null],
    ["nothing", "diff", "CATALOG_ENTRY_UNKNOWN"],
    ["draft", "diff", "CATALOG_ENTRY_NOT_RELEASED"],
    ["retired", "dynamic", "CATALOG_ENTRY_NOT_RELEASED"],
    ["diff-only", "dynamic", "CATALOG_ENTRY_KIND_MISMATCH"],
    ["diff-only", "diff", null],
    ["locked", "diff", "CATALOG_ENTRY_NOT_ALLOWED"],
  ] as const)("%s for %s: %s", async (id, kind, code) => {
    expect(await refusalOfChoice(source, kind, id)).toBe(code);
  });

  // #430-T07
  it("says that an entry does not exist before anything else, and not released before the kind and the plan", async () => {
    const both = sourceOf(
      [entry("old", { status: "retired", kinds: ["diff"] })],
      { forbidden: ["old"] },
    );

    expect(await refusalOfChoice(both, "dynamic", "old")).toBe(
      "CATALOG_ENTRY_NOT_RELEASED",
    );
  });
});

describe("the picker of a managed workspace", () => {
  // #430-T08
  it("copies an id, a name, a description, the provider label and the availability, and nothing else an entry carries", async () => {
    const carrying = {
      ...entry("a", { name: "Alpha", description: "Quick." }),
      provider: "sentinel-provider",
      modelId: "sentinel/model",
    };

    const choices = await catalogChoices(sourceOf([carrying]), {
      diff: null,
      dynamic: null,
    });

    expect(choices.diff).toEqual([
      {
        id: "a",
        name: "Alpha",
        description: "Quick.",
        providerLabel: "Anthropic",
        available: true,
        reason: null,
      },
    ]);
    expect(JSON.stringify(choices)).not.toContain("sentinel");
  });

  // #430-T08
  it("lists a retired entry only for the kind that has it selected, locked", async () => {
    const source = sourceOf([entry("old", { status: "retired" })]);

    const selectedForDiff = await catalogChoices(source, {
      diff: "old",
      dynamic: null,
    });
    const unselected = await catalogChoices(source, {
      diff: null,
      dynamic: null,
    });

    expect(selectedForDiff.diff).toEqual([
      expect.objectContaining({
        id: "old",
        available: false,
        reason: "CATALOG_ENTRY_NOT_RELEASED",
      }),
    ]);
    expect(selectedForDiff.dynamic).toEqual([]);
    expect(unselected).toEqual({ diff: [], dynamic: [] });
  });

  // #430-T08
  it("lists an entry per kind it serves, keeping the order of the catalog", async () => {
    const source = sourceOf([
      entry("first", { kinds: ["dynamic"] }),
      entry("second"),
      entry("third", { kinds: ["diff"] }),
    ]);

    const choices = await catalogChoices(source, { diff: null, dynamic: null });

    expect(choices.diff.map((choice) => choice.id)).toEqual([
      "second",
      "third",
    ]);
    expect(choices.dynamic.map((choice) => choice.id)).toEqual([
      "first",
      "second",
    ]);
  });
});
