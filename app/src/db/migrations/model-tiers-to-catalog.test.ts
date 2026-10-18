// SPDX-License-Identifier: Apache-2.0

// The pure mapper of the tier migration (#434, `model-tiers-to-catalog.ts`): which catalog entries the old tier
// configuration becomes, which are the instance defaults, and how a project's stored settings change. No database here;
// `migrate-model-tiers-to-catalog.integration.test.ts` runs the migration on both engines.
import { describe, expect, it } from "vitest";
import {
  checkDescription,
  checkEntryName,
  descriptionRevealsModel,
  nameRevealsModel,
} from "../../model-catalog/entries.ts";
import { migrationProvider } from "./index.ts";
import {
  entryIdsOf,
  planDefaults,
  planEntries,
  readTierConfiguration,
  rewriteSettings,
  workspaceTierOf,
} from "./model-tiers-to-catalog.ts";

const SAME = {
  low: { diff: "acme/low-1", dynamic: "acme/low-1" },
  medium: { diff: "acme/mid-1", dynamic: "acme/mid-1" },
  high: { diff: "acme/high-1", dynamic: "acme/high-1" },
};

describe("planEntries", () => {
  // #434-T01
  it("makes one entry per tier, named Low, Medium and High, when a tier has one model for both kinds", () => {
    const entries = planEntries(readTierConfiguration(SAME));
    expect(
      entries.map(({ name, kinds, modelId, tier }) => ({
        tier,
        name,
        kinds,
        modelId,
      })),
    ).toEqual([
      {
        tier: "low",
        name: "Low",
        kinds: ["diff", "dynamic"],
        modelId: "acme/low-1",
      },
      {
        tier: "medium",
        name: "Medium",
        kinds: ["diff", "dynamic"],
        modelId: "acme/mid-1",
      },
      {
        tier: "high",
        name: "High",
        kinds: ["diff", "dynamic"],
        modelId: "acme/high-1",
      },
    ]);
  });

  // #434-T01
  it("makes two entries, `<Tier> (Diff)` and `<Tier> (Dynamic)`, when the two kinds differ", () => {
    const entries = planEntries(
      readTierConfiguration({
        medium: { diff: "acme/d-1", dynamic: "acme/y-1" },
      }),
    );
    expect(
      entries.map(({ name, kinds, modelId }) => ({ name, kinds, modelId })),
    ).toEqual([
      { name: "Medium (Diff)", kinds: ["diff"], modelId: "acme/d-1" },
      { name: "Medium (Dynamic)", kinds: ["dynamic"], modelId: "acme/y-1" },
    ]);
  });

  // #434-T01
  it("makes one entry for the one kind a tier has", () => {
    const entries = planEntries(
      readTierConfiguration({
        low: { diff: "acme/d-1" },
        high: { dynamic: "acme/y-1" },
      }),
    );
    expect(entries.map(({ name, kinds }) => ({ name, kinds }))).toEqual([
      { name: "Low (Diff)", kinds: ["diff"] },
      { name: "High (Dynamic)", kinds: ["dynamic"] },
    ]);
  });

  // #434-T01
  it("orders Low, Medium, High whatever the order of the stored object", () => {
    const entries = planEntries(
      readTierConfiguration({
        high: { diff: "acme/h-1" },
        low: { diff: "acme/l-1" },
        medium: { diff: "acme/m-1" },
      }),
    );
    expect(entries.map(({ tier }) => tier)).toEqual(["low", "medium", "high"]);
  });

  // #434-T01
  it("plans nothing for a missing, damaged or empty configuration", () => {
    for (const stored of [
      undefined,
      null,
      "text",
      [],
      42,
      {},
      { low: null, medium: "x", high: [] },
      { low: {}, medium: { diff: null } },
    ])
      expect(planEntries(readTierConfiguration(stored))).toEqual([]);
  });

  // #434-T01
  it("drops a model id the old reader would not have accepted, and keeps the rest of the tier", () => {
    const entries = planEntries(
      readTierConfiguration({
        low: { diff: "has space", dynamic: "acme/y-1" },
        medium: { diff: 7, dynamic: "" },
        high: { diff: `acme/${"x".repeat(300)}` },
      }),
    );
    expect(entries.map(({ name, modelId }) => ({ name, modelId }))).toEqual([
      { name: "Low (Dynamic)", modelId: "acme/y-1" },
    ]);
  });

  // #434-T01
  it("gives every entry a stable, opaque id that is the same on every run", () => {
    const first = planEntries(readTierConfiguration(SAME));
    const second = planEntries(readTierConfiguration(SAME));
    expect(first.map(({ id }) => id)).toEqual(second.map(({ id }) => id));
    expect(new Set(first.map(({ id }) => id)).size).toBe(3);
    for (const { id } of first) expect(id).toMatch(/^mce_[0-9a-f]{32}$/);
  });

  // #434-T01
  it("hides the model: the name and the description pass the catalog's own checks and name no model", () => {
    const stored = {
      low: { diff: "vendor/lite-x", dynamic: "vendor/lite-y" },
      medium: { diff: "vendor/model-m", dynamic: "vendor/model-m" },
      high: { diff: "vendor/big-h", dynamic: "vendor/big-i" },
    };
    for (const entry of planEntries(readTierConfiguration(stored))) {
      expect(checkEntryName(entry.name)).toMatchObject({ ok: true });
      expect(checkDescription(entry.description)).toMatchObject({ ok: true });
      const behind = { provider: "openrouter", modelId: entry.modelId };
      expect(nameRevealsModel(entry.name, behind)).toBe(false);
      expect(descriptionRevealsModel(entry.description, behind)).toBe(false);
      expect(entry.description.length).toBeLessThanOrEqual(160);
    }
  });
});

describe("planDefaults", () => {
  // #434-T01
  it("makes the entries of the medium tier the default of each kind", () => {
    const entries = planEntries(readTierConfiguration(SAME));
    const medium = entries.find((entry) => entry.tier === "medium");
    expect(planDefaults(entries)).toEqual({
      diff: medium?.id,
      dynamic: medium?.id,
    });
  });

  // #434-T01
  it("keeps the kinds apart when the medium tier has an entry for each", () => {
    const entries = planEntries(
      readTierConfiguration({
        medium: { diff: "acme/d-1", dynamic: "acme/y-1" },
      }),
    );
    expect(planDefaults(entries)).toEqual({
      diff: entries[0]?.id,
      dynamic: entries[1]?.id,
    });
  });

  // #434-T01
  it("has no default for a kind the medium tier has no model for", () => {
    expect(
      planDefaults(
        planEntries(
          readTierConfiguration({
            medium: { diff: "acme/d-1" },
            high: { dynamic: "acme/y-1" },
          }),
        ),
      ),
    ).toEqual({ diff: expect.stringMatching(/^mce_/), dynamic: null });
    expect(planDefaults([])).toEqual({ diff: null, dynamic: null });
  });
});

describe("rewriteSettings", () => {
  const ids = entryIdsOf(planEntries(readTierConfiguration(SAME)));
  const idOf = (tier: "low" | "medium" | "high") => ids[tier]?.diff;

  // #434-T01
  it("turns a project's tier into the entries of that tier for both kinds, and keeps the old field", () => {
    const result = rewriteSettings(
      JSON.stringify({ modelTier: "high", maxFindings: 9 }),
      { workspaceTier: undefined, ids },
    );
    expect(result.kind).toBe("changed");
    if (result.kind !== "changed") return;
    expect(JSON.parse(result.text)).toEqual({
      modelTier: "high",
      maxFindings: 9,
      catalogEntryDiff: idOf("high"),
      catalogEntryDynamic: idOf("high"),
    });
  });

  // #434-T12
  it("writes the workspace's tier into a project that inherits it, when it differs from the default", () => {
    const result = rewriteSettings("{}", { workspaceTier: "low", ids });
    expect(result.kind).toBe("changed");
    if (result.kind !== "changed") return;
    expect(JSON.parse(result.text)).toEqual({
      catalogEntryDiff: idOf("low"),
      catalogEntryDynamic: idOf("low"),
    });
  });

  // #434-T12
  it("leaves a project that inherits the default tier alone", () => {
    expect(rewriteSettings("{}", { workspaceTier: "medium", ids })).toEqual({
      kind: "unchanged",
    });
    expect(rewriteSettings("{}", { workspaceTier: undefined, ids })).toEqual({
      kind: "unchanged",
    });
  });

  // #434-T12
  it("lets the project's own tier win over the workspace's, and pins an explicit default tier", () => {
    const own = rewriteSettings(JSON.stringify({ modelTier: "medium" }), {
      workspaceTier: "high",
      ids,
    });
    expect(own.kind).toBe("changed");
    if (own.kind !== "changed") return;
    expect(JSON.parse(own.text)).toMatchObject({
      catalogEntryDiff: idOf("medium"),
      catalogEntryDynamic: idOf("medium"),
    });
  });

  // #434-T01
  it("never replaces an entry the project already selected", () => {
    const result = rewriteSettings(
      JSON.stringify({
        modelTier: "high",
        catalogEntryDiff: "mce_chosen",
      }),
      { workspaceTier: undefined, ids },
    );
    expect(result.kind).toBe("changed");
    if (result.kind !== "changed") return;
    expect(JSON.parse(result.text)).toMatchObject({
      catalogEntryDiff: "mce_chosen",
      catalogEntryDynamic: idOf("high"),
    });
  });

  // #434-T01
  it("writes only the kinds the tier has an entry for", () => {
    const partial = entryIdsOf(
      planEntries(readTierConfiguration({ high: { diff: "acme/h-1" } })),
    );
    const result = rewriteSettings(JSON.stringify({ modelTier: "high" }), {
      workspaceTier: undefined,
      ids: partial,
    });
    expect(result.kind).toBe("changed");
    if (result.kind !== "changed") return;
    const written: Record<string, unknown> = JSON.parse(result.text);
    expect(written.catalogEntryDiff).toBe(partial.high?.diff);
    expect(written).not.toHaveProperty("catalogEntryDynamic");
  });

  // #434-T02
  it("is a no-op on its own output", () => {
    const first = rewriteSettings(JSON.stringify({ modelTier: "low" }), {
      workspaceTier: undefined,
      ids,
    });
    if (first.kind !== "changed") throw new Error("expected a change");
    expect(
      rewriteSettings(first.text, { workspaceTier: undefined, ids }),
    ).toEqual({ kind: "unchanged" });
  });

  // #434-T01
  it("ignores a tier name that is not one", () => {
    for (const modelTier of ["ultra", "", 3, null, ["high"], "HIGH"])
      expect(
        rewriteSettings(JSON.stringify({ modelTier }), {
          workspaceTier: undefined,
          ids,
        }),
      ).toEqual({ kind: "unchanged" });
  });

  // #434-T01
  it("does nothing when the tier has no entry at all", () => {
    expect(
      rewriteSettings(JSON.stringify({ modelTier: "high" }), {
        workspaceTier: undefined,
        ids: {},
      }),
    ).toEqual({ kind: "unchanged" });
  });

  // #434-T05
  it("reports damaged text, or text that is no object, as damaged", () => {
    for (const text of ["{not json", "[]", "null", "42", '"high"', ""])
      expect(rewriteSettings(text, { workspaceTier: "low", ids })).toEqual({
        kind: "damaged",
      });
  });
});

describe("workspaceTierOf", () => {
  // #434-T12
  it("reads the tier of the stored workspace defaults, and nothing else", () => {
    expect(workspaceTierOf(JSON.stringify({ modelTier: "high" }))).toEqual({
      kind: "tier",
      tier: "high",
    });
    expect(workspaceTierOf(JSON.stringify({ maxFindings: 3 }))).toEqual({
      kind: "none",
    });
    expect(workspaceTierOf(JSON.stringify({ modelTier: "nope" }))).toEqual({
      kind: "none",
    });
  });

  // #434-T05
  it("reports damaged defaults as damaged", () => {
    expect(workspaceTierOf("{broken")).toEqual({ kind: "damaged" });
    expect(workspaceTierOf("[1]")).toEqual({ kind: "damaged" });
  });
});

describe("the tier migration", () => {
  const KEY = "20261018170000_migrate_model_tiers_to_catalog";

  // #434-T08
  it("is registered and sorts after the newest migration that was merged before it", async () => {
    const names = Object.keys(await migrationProvider.getMigrations());
    expect(names).toContain(KEY);
    expect(KEY > "20261018160000_create_billing_plan_prices").toBe(true);
    expect(names.filter((name) => name < KEY)).toContain(
      "20261018160000_create_billing_plan_prices",
    );
  });
});
