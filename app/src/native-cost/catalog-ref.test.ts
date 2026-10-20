// SPDX-License-Identifier: Apache-2.0

// The minimal map from what a job selected to the models.dev catalog (#553, the id mapping #549 left here): a registry slug
// (`^[a-z][a-z0-9_]{1,31}$`, a secret name per provider) and a model id name a catalog model by providerId and modelId.
import { describe, expect, it } from "vitest";
import {
  catalogProviderIdOf,
  catalogRefOf,
  providerSlugOf,
} from "./catalog-ref.ts";

const LEGACY = ["openrouter", "anthropic"] as const;

describe("the catalog model a selection names", () => {
  // #553-R10
  it("is none for a provider of the legacy registry: that path is unchanged until #556", () => {
    for (const provider of LEGACY)
      expect(
        catalogRefOf({ provider, model: "claude-sonnet-5-5" }, LEGACY),
      ).toBeNull();
  });

  // #553-R10
  it("is the provider and model ids of models.dev for a supported provider that is not a legacy one", () => {
    expect(
      catalogRefOf({ provider: "deepseek", model: "deepseek-v4-pro" }, LEGACY),
    ).toEqual({ providerId: "deepseek", modelId: "deepseek-v4-pro" });
    expect(
      catalogRefOf({ provider: "openai", model: "gpt-5.1" }, LEGACY),
    ).toEqual({ providerId: "openai", modelId: "gpt-5.1" });
  });

  // #553-R10
  it("maps the underscore of a slug to the hyphen of the models.dev id, and back", () => {
    expect(catalogProviderIdOf("fireworks_ai")).toBe("fireworks-ai");
    expect(
      catalogRefOf({ provider: "fireworks_ai", model: "x.model" }, LEGACY),
    ).toEqual({ providerId: "fireworks-ai", modelId: "x.model" });
    expect(providerSlugOf("fireworks-ai")).toBe("fireworks_ai");
    expect(providerSlugOf("deepseek")).toBe("deepseek");
    // An id that already has an underscore has no slug: the map would not be one-to-one.
    expect(providerSlugOf("my_provider")).toBeNull();
  });

  // #553-R10
  it("is none for a provider the pinned engine cannot drive, an unknown one and one a slug cannot spell", () => {
    expect(
      catalogRefOf({ provider: "nosuchprovider", model: "m1" }, LEGACY),
    ).toBeNull();
    // `302ai` starts with a digit and `fireworks-ai` is fine, but a slug starts with a letter.
    expect(providerSlugOf("302ai")).toBeNull();
    // A provider id with a hyphen written as a hyphen is no slug.
    expect(
      catalogRefOf({ provider: "fireworks-ai", model: "m1" }, LEGACY),
    ).toBeNull();
    // Excluded by the pinned engine (cloud IAM): the file does not support it.
    expect(
      catalogRefOf({ provider: "google_vertex", model: "m1" }, LEGACY),
    ).toBeNull();
    // Upper case and other characters never reach the catalog.
    expect(
      catalogRefOf({ provider: "OpenAI", model: "m1" }, LEGACY),
    ).toBeNull();
  });

  // #553-R10
  it("is none for a model id the job entry would refuse", () => {
    for (const model of ["", " ", "a b", "../x", "x".repeat(201)])
      expect(catalogRefOf({ provider: "openai", model }, LEGACY)).toBeNull();
  });
});
