// SPDX-License-Identifier: Apache-2.0

// The models a form suggests for a review kind (#532): a provider may suggest fewer models for Dynamic Review than for
// Diff Review, and what the form offers for a kind is what the save and the claim accept for it.
import { describe, expect, it } from "vitest";
import { dynamicCapabilitiesOf } from "../dynamic-capabilities.ts";
import { resolveModelSelection } from "../selection.ts";
import { anthropicDescriptor } from "./anthropic/descriptor.ts";
import { checkModelCapabilities } from "./anthropic/capabilities.ts";
import { ANTHROPIC_MODELS } from "./anthropic/models.ts";
import { createFakeAdapter } from "./fake-adapter.ts";
import { openrouterDescriptor } from "./openrouter/descriptor.ts";
import { suggestedModelsFor } from "./suggested-models.ts";

const DIFF_ONLY = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-fable-5",
];

describe("the models suggested for a review kind", () => {
  // #532-T01
  it("are all of the provider's suggestions when the provider names none for the kind", () => {
    const fake = createFakeAdapter();
    expect(suggestedModelsFor(fake, "diff")).toEqual(fake.suggestedModels);
    expect(suggestedModelsFor(fake, "dynamic")).toEqual(fake.suggestedModels);
    expect(suggestedModelsFor(openrouterDescriptor, "dynamic")).toEqual(
      openrouterDescriptor.suggestedModels,
    );
  });

  // #532-T02
  it("are every Anthropic model for Diff Review", () => {
    expect(suggestedModelsFor(anthropicDescriptor, "diff")).toEqual(
      ANTHROPIC_MODELS.map((model) => model.id),
    );
  });

  // #532-T02
  it("leave out the Anthropic models that cannot serve a Dynamic Review", () => {
    const dynamic = suggestedModelsFor(anthropicDescriptor, "dynamic");

    expect(dynamic).toHaveLength(9);
    for (const id of DIFF_ONLY) expect(dynamic).not.toContain(id);
    expect(dynamic).toContain(anthropicDescriptor.defaultModels.dynamic);
    expect(dynamic).toContain("claude-haiku-5-5");
  });

  // #532-T03
  it("are exactly the models the claim accepts for a Dynamic job and the ones it refuses for Diff-only models", async () => {
    const dynamic = new Set(suggestedModelsFor(anthropicDescriptor, "dynamic"));
    for (const { id } of ANTHROPIC_MODELS) {
      const result = await checkModelCapabilities({
        baseUrl: "https://unused.example",
        modelId: id,
      });
      // The claim ends a Dynamic job with `dynamic_model_features_unsupported` for anything but `supported`.
      expect(result.outcome === "supported", id).toBe(dynamic.has(id));
      if (dynamic.has(id) && result.outcome === "supported")
        expect(dynamicCapabilitiesOf(result.capabilities), id).not.toBeNull();
    }
  });

  // #532-T03
  it("are all selectable as the saved pair of a project for their kind", () => {
    for (const kind of ["diff", "dynamic"] as const)
      for (const model of suggestedModelsFor(anthropicDescriptor, kind))
        expect(
          resolveModelSelection({
            keyMode: "own",
            kind,
            runnerProviders: ["openrouter", "anthropic"],
            builtInModel: openrouterDescriptor.defaultModels[kind],
            layers: { project: { provider: "anthropic", model } },
          }),
          `${kind} ${model}`,
        ).toMatchObject({
          ok: true,
          selection: { provider: "anthropic", model },
        });
  });
});
