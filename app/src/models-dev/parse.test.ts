// SPDX-License-Identifier: LicenseRef-Proprietary

// Reading a models.dev body (#548, part A): untrusted data, validated by a strict tolerant schema, filtered to the
// supported providers and to models with tool calling, and reduced to the fields a job needs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_MODELS_PER_PROVIDER,
  MAX_NAME_LENGTH,
  parseModelsDev,
} from "./parse.ts";

const FIXTURE = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "fakes",
      "fixtures",
      "models-dev",
      "api.json",
    ),
    "utf8",
  ),
) as Record<
  string,
  { models: Record<string, Record<string, unknown>> } & Record<string, unknown>
>;

function parse(body: unknown) {
  const result = parseModelsDev(body);
  if (!result.ok) throw new Error(`not parsed: ${result.code}`);
  return result;
}

function modelsOf(result: ReturnType<typeof parse>) {
  return result.models.map((model) => `${model.providerId}/${model.id}`).sort();
}

/** A body with one supported provider and the given model objects. */
function bodyWith(
  models: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    deepseek: {
      id: "deepseek",
      name: "DeepSeek",
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.deepseek.com",
      models,
      ...extra,
    },
  };
}

function goodModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "m",
    name: "M",
    tool_call: true,
    reasoning: false,
    temperature: true,
    attachment: false,
    limit: { context: 128000, output: 8192 },
    modalities: { input: ["text"], output: ["text"] },
    ...overrides,
  };
}

describe("reading a models.dev body", () => {
  // #548-T01
  it("keeps only the models with tool calling of the providers the pinned OpenCode can drive", () => {
    const result = parse(FIXTURE);

    expect(modelsOf(result)).toEqual([
      "anthropic/claude-fable-5-1",
      "anthropic/claude-haiku-5-5",
      "anthropic/claude-sonnet-5-5",
      "deepseek/deepseek-flash",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-vision-exp",
      "deepseek/deepseek-v4-pro",
      "google/gemini-3.5-flash",
      "openai/gpt-5-mini",
      "openai/gpt-5.5",
      "openrouter/mistralai/mistral-medium-3-5",
      "openrouter/mistralai/mistral-saba",
      "xai/grok-4.5",
    ]);
    expect(result.providers.map((provider) => provider.id).sort()).toEqual([
      "anthropic",
      "deepseek",
      "google",
      "openai",
      "openrouter",
      "xai",
    ]);
  });

  // #548-T01
  it("counts what it left out, by the reason", () => {
    const { skipped } = parse(FIXTURE);

    expect(skipped).toEqual({
      invalid: 0,
      noToolCalling: 4,
      notLanguageModel: 0,
      modelProviderOverride: 2,
      unsupportedProviders: 3,
      unknownProviders: 0,
      oversizedProviders: 0,
    });
  });

  // #548-T01
  it("keeps the fields of a model exactly, and drops the rest", () => {
    const model = parse(FIXTURE).models.find(
      (candidate) =>
        candidate.providerId === "deepseek" &&
        candidate.id === "deepseek-v4-pro",
    );
    const upstream = FIXTURE.deepseek?.models["deepseek-v4-pro"];

    expect(model).toEqual({
      providerId: "deepseek",
      id: "deepseek-v4-pro",
      name: upstream?.name,
      family: upstream?.family,
      limit: upstream?.limit,
      reasoning: upstream?.reasoning,
      temperature: upstream?.temperature,
      attachment: upstream?.attachment,
      modalities: upstream?.modalities,
      status: null,
      cost: expect.objectContaining({
        input: expect.any(String),
        output: expect.any(String),
      }),
      lastUpdated: upstream?.last_updated,
      interleaved: { field: "reasoning_content" },
    });
    // The description, the knowledge cut-off and every other field are not kept.
    expect(JSON.stringify(model)).not.toContain("knowledge");
    expect(model).not.toHaveProperty("description");
  });

  // #548-T01
  it.each([
    [{ field: "reasoning_content" }, { field: "reasoning_content" }],
    [{ field: "reasoning_details" }, { field: "reasoning_details" }],
    ["reasoning_content", { field: "reasoning_content" }],
    [true, true],
    // The pinned engine hands the reasoning back in any name it is given; only the two names models.dev uses are kept.
    [{ field: "reasoning_text" }, null],
    [{ field: "reasoning" }, null],
    [{ field: "reasoning_summary" }, null],
    [{ field: "<script>" }, null],
    [{ field: "" }, null],
    ["x", null],
    [false, null],
  ])("keeps the interleaved field %j as %j", (interleaved, expected) => {
    const deepseek = structuredClone(FIXTURE.deepseek);
    const upstream = deepseek?.models["deepseek-v4-pro"] as Record<
      string,
      unknown
    >;
    upstream.interleaved = interleaved;

    const model = parse({ ...FIXTURE, deepseek }).models.find(
      (candidate) => candidate.id === "deepseek-v4-pro",
    );

    expect(model?.interleaved).toEqual(expected);
  });

  // #548-T01
  it("stores prices as the exact decimal strings of USD per million tokens, tiers included", () => {
    const haiku = parse(FIXTURE).models.find(
      (model) => model.id === "claude-haiku-5-5",
    );

    expect(haiku?.cost).toEqual({
      input: "0.1",
      output: "0.5",
      cacheRead: "0.01",
      cacheWrite: "0.125",
      tiers: [
        {
          contextOver: 100000,
          input: "0.5",
          output: "2.5",
          cacheRead: "0.05",
          cacheWrite: "0.625",
        },
      ],
    });
  });

  // #549-T05
  it("stores every price models.dev states: reasoning, audio and the older 200k tier", () => {
    const [model] = parse(
      bodyWith({
        m: goodModel({
          cost: {
            input: 1,
            output: 2,
            reasoning: 3,
            input_audio: 4,
            output_audio: 5,
            context_over_200k: { input: 6, output: 7, cache_read: 0.5 },
          },
        }),
      }),
    ).models;

    expect(model?.cost).toEqual({
      input: "1",
      output: "2",
      reasoning: "3",
      inputAudio: "4",
      outputAudio: "5",
      contextOver200k: { input: "6", output: "7", cacheRead: "0.5" },
    });
  });

  // #549-T05
  it("stores every tier, however many there are, in the order they come", () => {
    const tiers = Array.from({ length: 12 }, (_, index) => ({
      input: index + 1,
      output: index + 2,
      tier: { type: "context", size: (12 - index) * 1000 },
    }));

    const [model] = parse(
      bodyWith({ m: goodModel({ cost: { input: 1, output: 2, tiers } }) }),
    ).models;

    expect(model?.cost?.tiers).toHaveLength(12);
    expect(model?.cost?.tiers?.[0]).toEqual({
      contextOver: 12000,
      input: "1",
      output: "2",
    });
    expect(model?.cost?.unknown).toBeUndefined();
  });

  // #549-T05
  it.each([
    [
      "a price field it does not know",
      { input: 1, output: 2, input_video: 3 },
      ["cost.input_video"],
    ],
    [
      "a tier of a kind it does not know",
      {
        input: 1,
        output: 2,
        tiers: [
          { input: 3, output: 4, tier: { type: "time_of_day", size: 12 } },
        ],
      },
      ["tier_type.time_of_day"],
    ],
    [
      "a tier with a price field it does not know",
      {
        input: 1,
        output: 2,
        tiers: [
          {
            input: 3,
            output: 4,
            cache_write_1h: 5,
            tier: { type: "context", size: 1000 },
          },
        ],
      },
      ["tier.cache_write_1h"],
    ],
    [
      "a tier that is not a tier",
      { input: 1, output: 2, tiers: ["cheap", { input: 1 }] },
      ["tier"],
    ],
    [
      "a price field that is not a price",
      { input: 1, output: 2, reasoning: "a lot" },
      ["cost.reasoning"],
    ],
  ])(
    "flags %s as a price it cannot read, instead of dropping it",
    (_name, cost, unknown) => {
      const [model] = parse(bodyWith({ m: goodModel({ cost }) })).models;

      expect(model?.cost?.unknown).toEqual(unknown);
      expect(model?.cost?.input).toBe("1");
    },
  );

  // #549-T05
  it("flags a model with more tiers than any real model has, and stores no more than the bound", () => {
    const tiers = Array.from({ length: 70 }, (_, index) => ({
      input: 1,
      output: 2,
      tier: { type: "context", size: index + 1 },
    }));

    const [model] = parse(
      bodyWith({ m: goodModel({ cost: { input: 1, output: 2, tiers } }) }),
    ).models;

    expect(model?.cost?.tiers).toHaveLength(64);
    expect(model?.cost?.unknown).toEqual(["tiers_over_limit"]);
  });

  // #549-T05
  it("names an unknown field only by a short plain name, because the body is untrusted", () => {
    const [model] = parse(
      bodyWith({
        m: goodModel({
          cost: { input: 1, output: 2, "<script>alert(1)</script>": 3 },
        }),
      }),
    ).models;

    expect(model?.cost?.unknown).toEqual(["cost.invalid_name"]);
  });

  // #548-T01
  it("stores the status of a deprecated model as a warning, and keeps the model", () => {
    const model = parse(FIXTURE).models.find(
      (candidate) => candidate.id === "deepseek-v4-flash",
    );

    expect(model?.status).toBe("deprecated");
  });

  // #548-T01
  it.each(["alpha", "beta", "deprecated", "active"] as const)(
    "stores the status %s as it is stated",
    (status) => {
      const model = parse(bodyWith({ m: goodModel({ status }) })).models[0];

      expect(model?.status).toBe(status);
    },
  );

  // #548-T01
  it("ignores fields it does not know, at every level", () => {
    const body = bodyWith(
      { m: goodModel({ brand_new_field: { deep: [1, 2] } }) },
      { surprise: true },
    );

    expect(modelsOf(parse(body))).toEqual(["deepseek/m"]);
  });

  // #548-T01
  it("reads a model without a price as unpriced, not as free", () => {
    const [model] = parse(bodyWith({ m: goodModel() })).models;

    expect(model?.cost).toBeNull();
  });
});

describe("a body or a model that is not valid", () => {
  // #548-T02
  it.each([
    ["an array", []],
    ["a string", "<html>Service unavailable</html>"],
    ["null", null],
    [
      "an object without any provider we use",
      { "some-new-provider": { models: {} } },
    ],
    ["a supported provider without a single usable model", bodyWith({})],
  ])("refuses %s as a whole, with a stable code", (_name, body) => {
    expect(parseModelsDev(body)).toEqual({
      ok: false,
      code: "models_dev_invalid_body",
    });
  });

  // #548-T02
  it.each([
    ["a limit that is not a number", { limit: { context: "big", output: 1 } }],
    ["no output limit", { limit: { context: 1000 } }],
    ["a limit of zero", { limit: { context: 0, output: 0 } }],
    ["a limit beyond any model", { limit: { context: 1e15, output: 1 } }],
    ["a negative price", { cost: { input: -1, output: 1 } }],
    ["a price that is not a number", { cost: { input: "1", output: 1 } }],
    ["a status it does not know", { status: "retired" }],
    ["a name that is not text", { name: 12 }],
    ["an id that does not look like one", { id: "bad id with spaces" }],
    ["an id other than its key", { id: "other" }],
  ])(
    "skips a model with %s and counts it, writing nothing for it",
    (_name, overrides) => {
      const result = parse(
        bodyWith({ good: goodModel({ id: "good" }), m: goodModel(overrides) }),
      );

      expect(modelsOf(result)).toEqual(["deepseek/good"]);
      expect(result.skipped.invalid).toBe(1);
    },
  );

  // #548-T02
  it("skips a provider whose models are not an object and goes on with the others", () => {
    const body = {
      ...bodyWith({ m: goodModel() }),
      openai: { name: "OpenAI", npm: "@ai-sdk/openai", models: [1] },
    };

    const result = parse(body);

    expect(result.providers.map((provider) => provider.id)).toEqual([
      "deepseek",
    ]);
    expect(result.skipped.invalid).toBe(1);
  });

  // #548-T02
  it("never keeps a model that cannot call tools, whatever else it says", () => {
    const result = parse(
      bodyWith({
        a: goodModel({ id: "a", tool_call: false }),
        b: goodModel({ id: "b", tool_call: "yes" }),
        c: goodModel({ id: "c" }),
      }),
    );

    expect(modelsOf(result)).toEqual(["deepseek/c"]);
  });

  // #548-T02
  it("never keeps a model that is not a language model, such as an embedding or an image model", () => {
    const result = parse(
      bodyWith({
        a: goodModel({
          id: "a",
          type: "embedding",
          limit: { context: 8000, output: 0 },
        }),
        b: goodModel({ id: "b", type: "image" }),
        c: goodModel({ id: "c" }),
      }),
    );

    expect(modelsOf(result)).toEqual(["deepseek/c"]);
    expect(result.skipped.notLanguageModel).toBe(2);
    expect(result.skipped.invalid).toBe(0);
  });

  // #548-T02
  it("never keeps a model that carries a provider or an address of its own", () => {
    const result = parse(
      bodyWith({
        a: goodModel({ id: "a", provider: { npm: "@ai-sdk/anthropic" } }),
        b: goodModel({
          id: "b",
          provider: { api: "https://elsewhere.example/v1" },
        }),
        c: goodModel({ id: "c" }),
      }),
    );

    expect(modelsOf(result)).toEqual(["deepseek/c"]);
    expect(result.skipped.modelProviderOverride).toBe(2);
  });
});

describe("what the body says is text, never markup or an unbounded string", () => {
  // #548-T14
  it("stores a name with markup as plain text, as it is", () => {
    const name = `<script>alert("x")</script> & <b>bold</b>`;

    const [model] = parse(bodyWith({ m: goodModel({ name }) })).models;

    expect(model?.name).toBe(name);
  });

  // #548-T14
  it("cuts a very long name and a very long provider name to a fixed length", () => {
    const body = bodyWith(
      { m: goodModel({ name: "x".repeat(50_000) }) },
      { name: "y".repeat(50_000) },
    );

    const result = parse(body);

    expect(result.models[0]?.name).toHaveLength(MAX_NAME_LENGTH);
    expect(result.providers[0]?.name).toHaveLength(MAX_NAME_LENGTH);
  });

  // #548-T14
  it("replaces line breaks and control characters of a name by spaces", () => {
    const [model] = parse(
      bodyWith({ m: goodModel({ name: "Line one\r\nline\ttwo\u0000‮ end" }) }),
    ).models;

    expect(model?.name).toBe("Line one line two end");
  });

  // #548-T14
  it("keeps only the modalities it knows, once each", () => {
    const [model] = parse(
      bodyWith({
        m: goodModel({
          modalities: {
            input: ["text", "image", "text", "<b>x</b>"],
            output: ["text"],
          },
        }),
      }),
    ).models;

    expect(model?.modalities).toEqual({
      input: ["text", "image"],
      output: ["text"],
    });
  });

  // #548-T14
  it("reads the address of a provider as a bounded string and leaves judging it to the address check", () => {
    const long = `https://api.deepseek.com/${"a".repeat(10_000)}`;

    const result = parse(bodyWith({ m: goodModel() }, { api: long }));

    expect(result.providers[0]?.api?.length).toBeLessThanOrEqual(2048);
    expect(result.providers[0]?.apiTooLong).toBe(true);
  });
});

describe("the size of one provider", () => {
  const model = (name: string) => ({
    name,
    tool_call: true,
    limit: { context: 1000, output: 100 },
  });
  const providerOf = (count: number) => ({
    name: "DeepSeek",
    api: "https://api.deepseek.com",
    models: Object.fromEntries(
      Array.from({ length: count }, (_unused, i) => [
        `m${String(i)}`,
        model(`m${String(i)}`),
      ]),
    ),
  });

  // #548-T02
  it("reads a provider up to the limit", () => {
    const result = parse({ deepseek: providerOf(MAX_MODELS_PER_PROVIDER) });

    expect(result.models).toHaveLength(MAX_MODELS_PER_PROVIDER);
    expect(result.skipped.oversizedProviders).toBe(0);
  });

  // #548-T02
  it("does not read a provider above the limit, counts it, and reads the others", () => {
    const result = parse({
      deepseek: providerOf(MAX_MODELS_PER_PROVIDER + 1),
      openai: {
        name: "OpenAI",
        models: { "gpt-5.5": model("GPT") },
      },
    });

    expect(result.skipped.oversizedProviders).toBe(1);
    expect(result.providers.map((provider) => provider.id)).toEqual(["openai"]);
    expect(result.models.map((m) => m.providerId)).toEqual(["openai"]);
  });

  // #548-T02
  it("allows more than the largest provider has today, with room to grow", () => {
    // nano-gpt states 621 models (2026-10-19), 405 with tool calling.
    expect(MAX_MODELS_PER_PROVIDER).toBeGreaterThanOrEqual(3 * 621);
  });
});
