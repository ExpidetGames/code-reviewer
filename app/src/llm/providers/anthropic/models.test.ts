// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_DEFAULT_MODELS,
  ANTHROPIC_MODELS,
  ANTHROPIC_MODELS_AS_OF,
  anthropicModel,
  isAnthropicModelId,
} from "./models.ts";

const contract = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../../contracts/anthropic-models.v1.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as {
  asOf: string;
  defaultModels: { diff: string; dynamic: string };
  models: unknown[];
};

/** The models Anthropic offers on 2026-10-19: not deprecated, not retired, not limited access. */
const OFFERED = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

describe("the Anthropic model list", () => {
  // #511-T01
  it("is exactly the set of models on offer, each id once", () => {
    expect(ANTHROPIC_MODELS.map((model) => model.id)).toEqual(OFFERED);
    expect(new Set(ANTHROPIC_MODELS.map((model) => model.id)).size).toBe(
      OFFERED.length,
    );
  });

  // #511-T01
  it("lists no deprecated, retired or limited-access model", () => {
    for (const id of [
      "claude-sonnet-4-5-20250929", // deprecated 2026-09-30
      "claude-opus-4-1-20250805", // retired
      "claude-opus-4-20250514", // retired
      "claude-sonnet-4-20250514", // retired
      "claude-3-7-sonnet-20250219", // retired
      "claude-3-5-haiku-20241022", // retired
      "claude-3-haiku-20240307", // retired
      "claude-mythos-5-1", // limited availability
      "claude-mythos-5", // limited availability
      "claude-mythos-preview", // deprecated
    ])
      expect(isAnthropicModelId(id), id).toBe(false);
  });

  // #511-T02
  it("equals the contract file entry by entry", () => {
    expect(JSON.parse(JSON.stringify(ANTHROPIC_MODELS))).toEqual(
      contract.models,
    );
    expect(ANTHROPIC_DEFAULT_MODELS).toEqual(contract.defaultModels);
    expect(ANTHROPIC_MODELS_AS_OF).toBe(contract.asOf);
  });

  // #511-T03
  it("has sane prices and limits for every model", () => {
    for (const model of ANTHROPIC_MODELS) {
      const { input, output, cacheRead, cacheWrite5m, cacheWrite1h } =
        model.pricesUsdPerMTok;
      const [i, o, r, w5, w1] = [
        input,
        output,
        cacheRead,
        cacheWrite5m,
        cacheWrite1h,
      ].map(Number) as [number, number, number, number, number];
      for (const price of [i, o, r, w5, w1])
        expect(Number.isFinite(price) && price > 0, model.id).toBe(true);
      expect(o, model.id).toBeGreaterThan(i);
      expect(r, model.id).toBeLessThan(i);
      // The documented multipliers of the cache writes: 1.25x for five minutes, 2x for an hour.
      expect(w5, model.id).toBeCloseTo(i * 1.25, 9);
      expect(w1, model.id).toBeCloseTo(i * 2, 9);
      expect(model.contextWindowTokens, model.id).toBeGreaterThanOrEqual(
        model.maxOutputTokens,
      );
      expect(model.retiresNotBefore, model.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (model.longPrompt !== null) {
        const long = model.longPrompt.pricesUsdPerMTok;
        expect(Number(long.input), model.id).toBeGreaterThan(i);
        expect(Number(long.output), model.id).toBeGreaterThan(o);
        expect(model.longPrompt.overInputTokens, model.id).toBeLessThan(
          model.contextWindowTokens,
        );
      }
    }
  });

  // #511-T03
  it("has defaults that are listed and support their review kind", () => {
    expect(
      anthropicModel(ANTHROPIC_DEFAULT_MODELS.diff)?.reviewKinds,
    ).toContain("diff");
    expect(
      anthropicModel(ANTHROPIC_DEFAULT_MODELS.dynamic)?.reviewKinds,
    ).toContain("dynamic");
    expect(ANTHROPIC_DEFAULT_MODELS.diff).toBe("claude-haiku-5-5");
  });

  // #511-T04
  it("accepts a listed id and refuses everything else", () => {
    for (const model of ANTHROPIC_MODELS)
      expect(isAnthropicModelId(model.id), model.id).toBe(true);
    for (const id of [
      "",
      "claude-haiku-5-5 ",
      "Claude-Haiku-5-5",
      "anthropic/claude-haiku-5-5",
      "anthropic/claude-haiku-5.5",
      "claude-haiku-5-5-20261007",
      "claude-haiku-4-5",
      "claude-opus-4-5",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-5-5\n",
      "__proto__",
      "constructor",
      "toString",
    ])
      expect(isAnthropicModelId(id), JSON.stringify(id)).toBe(false);
    expect(anthropicModel("claude-haiku-5-5-latest")).toBeUndefined();
  });

  // #511-T05
  it("offers Dynamic only to models that take a forced tool choice and can run without thinking", () => {
    for (const model of ANTHROPIC_MODELS) {
      const dynamic =
        model.supports.tools &&
        model.supports.forcedToolChoice &&
        model.supports.thinkingDisabled;
      expect(model.reviewKinds.includes("dynamic"), model.id).toBe(dynamic);
      expect(model.reviewKinds.includes("diff"), model.id).toBe(true);
    }
    expect(
      ANTHROPIC_MODELS.filter(
        (model) => !model.reviewKinds.includes("dynamic"),
      ).map((model) => model.id),
    ).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-fable-5",
    ]);
  });

  // #511-T06
  it("allows temperature and top-p only on the models that take them", () => {
    expect(
      ANTHROPIC_MODELS.filter((model) => model.supports.temperature).map(
        (model) => model.id,
      ),
    ).toEqual([
      "claude-opus-4-6",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ]);
    for (const model of ANTHROPIC_MODELS)
      expect(model.supports.topP, model.id).toBe(model.supports.temperature);
  });
});
