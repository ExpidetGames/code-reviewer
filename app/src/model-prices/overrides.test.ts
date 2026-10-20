// SPDX-License-Identifier: Apache-2.0

// The committed override file (#549, part A): `contracts/model-overrides.v1.json`, the few fields models.dev lacks or gets
// wrong in a way that is a code matter, each with a reason. The app image holds `app/` only, so it reads an identical copy.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { usdPerMTokToMicroUsd } from "./money.ts";
import {
  ModelOverridesError,
  MODEL_OVERRIDES,
  createOverrideLookup,
  modelOverride,
  overrideProviderDrift,
  parseModelOverrides,
} from "./overrides.ts";

const REPOSITORY = join(import.meta.dirname, "..", "..", "..");
const contractText = readFileSync(
  join(REPOSITORY, "contracts", "model-overrides.v1.json"),
  "utf8",
);

const valid = {
  version: 1,
  providers: {
    anthropic: {
      models: {
        "claude-sonnet-5-5": {
          reason: "models.dev states no 1-hour cache write price.",
          cacheWrite1hPerMTok: "4",
        },
      },
    },
  },
};

const withEntry = (entry: Record<string, unknown>) => ({
  version: 1,
  providers: { anthropic: { models: { "claude-sonnet-5-5": entry } } },
});

describe("parseModelOverrides", () => {
  // #549-T01
  it("loads a valid file", () => {
    const parsed = parseModelOverrides(valid);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      parsed.overrides.providers.anthropic?.models["claude-sonnet-5-5"],
    ).toEqual({
      reason: "models.dev states no 1-hour cache write price.",
      cacheWrite1h: BigInt(4_000_000),
      retiresNotBefore: null,
      blocked: false,
    });
  });

  // #549-T01
  it("loads a retirement date and a block", () => {
    const parsed = parseModelOverrides({
      version: 1,
      providers: {
        deepseek: {
          models: {
            "deepseek-v4-pro": {
              reason: "Retired by the provider.",
              retiresNotBefore: "2027-01-31",
            },
            "deepseek-flash": {
              reason: "Wrong tool calling flag upstream.",
              blocked: true,
            },
          },
        },
      },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const models = parsed.overrides.providers.deepseek?.models;
    expect(models?.["deepseek-v4-pro"]?.retiresNotBefore).toBe("2027-01-31");
    expect(models?.["deepseek-flash"]?.blocked).toBe(true);
  });

  // #549-T01
  it.each([
    [
      "an unknown field",
      withEntry({
        reason: "x",
        cacheWrite1hPerMTok: "4",
        baseUrl: "https://a.example",
      }),
    ],
    ["a negative price", withEntry({ reason: "x", cacheWrite1hPerMTok: "-4" })],
    [
      "a price that is not a decimal",
      withEntry({ reason: "x", cacheWrite1hPerMTok: "4e0" }),
    ],
    [
      "a price finer than a micro-USD",
      withEntry({ reason: "x", cacheWrite1hPerMTok: "0.0000001" }),
    ],
    ["a price as a number", withEntry({ reason: "x", cacheWrite1hPerMTok: 4 })],
    ["a missing reason", withEntry({ cacheWrite1hPerMTok: "4" })],
    ["an empty reason", withEntry({ reason: "", cacheWrite1hPerMTok: "4" })],
    [
      "a reason on several lines",
      withEntry({ reason: "a\nb", cacheWrite1hPerMTok: "4" }),
    ],
    [
      "a reason that is too long",
      withEntry({ reason: "x".repeat(201), cacheWrite1hPerMTok: "4" }),
    ],
    ["an entry that states nothing", withEntry({ reason: "x" })],
    [
      "a date that is no date",
      withEntry({ reason: "x", retiresNotBefore: "2027-13-40" }),
    ],
    [
      "a date in another form",
      withEntry({ reason: "x", retiresNotBefore: "31.01.2027" }),
    ],
    ["blocked as text", withEntry({ reason: "x", blocked: "yes" })],
    ["blocked as false only", withEntry({ reason: "x", blocked: false })],
  ])("refuses %s", (_name, input) => {
    expect(parseModelOverrides(input)).toEqual({ ok: false });
  });

  // #549-T01
  it("refuses a wrong version and unknown top level fields", () => {
    expect(parseModelOverrides({ ...valid, version: 2 })).toEqual({
      ok: false,
    });
    expect(parseModelOverrides({ ...valid, extra: 1 })).toEqual({ ok: false });
    expect(parseModelOverrides(null)).toEqual({ ok: false });
  });

  // #549-T01
  it("names the providers of a file that the supported list lacks, as drift, instead of refusing the file", () => {
    const parsed = parseModelOverrides({
      version: 1,
      providers: {
        "amazon-bedrock": { models: { m: { reason: "x", blocked: true } } },
        "a-provider-from-next-week": {
          models: { m: { reason: "x", blocked: true } },
        },
        anthropic: valid.providers.anthropic,
      },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(overrideProviderDrift(parsed.overrides)).toEqual([
      "a-provider-from-next-week",
      "amazon-bedrock",
    ]);
  });

  // #549-T01
  it("refuses a provider entry with an unknown field, such as a pinned address", () => {
    expect(
      parseModelOverrides({
        version: 1,
        providers: { anthropic: { baseUrl: "https://a.example", models: {} } },
      }),
    ).toEqual({ ok: false });
  });
});

describe("the committed override file", () => {
  // #549-T01
  it("is valid", () => {
    expect(parseModelOverrides(JSON.parse(contractText))).toMatchObject({
      ok: true,
    });
  });

  // #549-T01
  it("is the same file as the contract, which the app image cannot read", () => {
    const copy = readFileSync(
      join(import.meta.dirname, "model-overrides.v1.json"),
      "utf8",
    );

    expect(copy).toBe(contractText);
  });

  // #549-T03
  it("agrees with the hand-kept Anthropic list on the 1-hour cache write, until that list is deleted (#556)", () => {
    const list = JSON.parse(
      readFileSync(
        join(REPOSITORY, "contracts", "anthropic-models.v1.json"),
        "utf8",
      ),
    ) as {
      models: Array<{ id: string; pricesUsdPerMTok: { cacheWrite1h: string } }>;
    };

    for (const model of list.models) {
      const override = modelOverride("anthropic", model.id);
      expect(override?.cacheWrite1h, model.id).toBe(
        usdPerMTokToMicroUsd(model.pricesUsdPerMTok.cacheWrite1h),
      );
    }
  });
});

describe("a provider that is no longer supported", () => {
  // #549-T01
  it("does not stop the app from loading, and fails at use with a stable code", () => {
    const parsed = parseModelOverrides(valid);
    if (!parsed.ok) throw new Error("the fixture is valid");

    const lookup = createOverrideLookup(parsed.overrides, () => false);

    expect(() => lookup("anthropic", "claude-sonnet-5-5")).toThrow(
      ModelOverridesError,
    );
    try {
      lookup("openai", "gpt-5.5");
      expect.unreachable("the lookup must throw");
    } catch (error) {
      expect(error).toMatchObject({
        code: "override_file_provider_unsupported",
        providers: ["anthropic"],
      });
    }
  });

  // #549-T01
  it("is a plain lookup while every provider of the file is supported", () => {
    const parsed = parseModelOverrides(valid);
    if (!parsed.ok) throw new Error("the fixture is valid");

    const lookup = createOverrideLookup(parsed.overrides, () => true);

    expect(lookup("anthropic", "claude-sonnet-5-5")?.cacheWrite1h).toBe(
      BigInt(4_000_000),
    );
    expect(lookup("anthropic", "nobody")).toBeUndefined();
  });

  // #549-T01
  it("is caught by the committed file's own test: it names no provider the supported list lacks", () => {
    expect(overrideProviderDrift(MODEL_OVERRIDES)).toEqual([]);
  });
});

describe("modelOverride", () => {
  // #549-T03
  it("finds the override of a model", () => {
    expect(modelOverride("anthropic", "claude-sonnet-5-5")?.cacheWrite1h).toBe(
      BigInt(4_000_000),
    );
    expect(MODEL_OVERRIDES.version).toBe(1);
  });

  it("has none for a model or provider that the file does not name, and ignores names from the prototype", () => {
    expect(modelOverride("anthropic", "claude-from-next-week")).toBeUndefined();
    expect(modelOverride("openai", "gpt-5.5")).toBeUndefined();
    expect(modelOverride("__proto__", "x")).toBeUndefined();
    expect(modelOverride("anthropic", "__proto__")).toBeUndefined();
    expect(modelOverride("anthropic", "constructor")).toBeUndefined();
  });
});
