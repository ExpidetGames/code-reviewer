// SPDX-License-Identifier: LicenseRef-Proprietary

// The own-key selection of a catalog model for Dynamic Review (#555): the provider is a catalog provider by its slug, the model
// is the project's (a catalog provider has no built-in model), and the caller must be able to run a catalog model. A Diff job
// never takes this path (#558).
import { describe, expect, it } from "vitest";
import {
  resolveModelSelection,
  type Selection,
  type SelectionInput,
} from "./selection.ts";

type Own = Extract<SelectionInput, { keyMode: "own" }>;

function own(overrides: Partial<Own> = {}): Own {
  return {
    keyMode: "own",
    kind: "dynamic",
    runnerProviders: ["openrouter", "anthropic"],
    nativeModels: true,
    builtInModel: "claude-sonnet-5-5",
    layers: {
      project: { provider: "deepseek", model: "deepseek-v4-pro" },
    },
    ...overrides,
  };
}

describe("the own-key selection of a catalog model", () => {
  // #555-T05
  it("names the catalog provider by its slug, the project's model and the workspace's own key", () => {
    const result = resolveModelSelection(own());

    expect(result).toEqual({
      ok: true,
      selection: {
        keyMode: "own",
        kind: "dynamic",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        keySource: "workspace",
        catalog: true,
      } satisfies Selection,
    });
  });

  // #555-T05
  it("takes the model id as it is written, with the characters of a catalog id", () => {
    const result = resolveModelSelection(
      own({
        layers: {
          project: {
            provider: "fireworks_ai",
            model: "accounts/fireworks/models/x-1.5",
          },
        },
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      selection: {
        provider: "fireworks_ai",
        model: "accounts/fireworks/models/x-1.5",
      },
    });
  });

  // #555-T05
  it("fails closed when the caller cannot run a catalog model: llm_provider_unsupported, no move to another provider", () => {
    expect(resolveModelSelection(own({ nativeModels: false }))).toMatchObject({
      ok: false,
      errorCode: "llm_provider_unsupported",
      provider: "deepseek",
    });
    // A caller without the flag in the object at all:
    const { nativeModels: _removed, ...bare } = own();
    void _removed;
    expect(resolveModelSelection(bare)).toMatchObject({
      ok: false,
      errorCode: "llm_provider_unsupported",
    });
  });

  // #555-T05
  it("is never a catalog model for a Diff job: the Diff model keeps its providers", () => {
    expect(
      resolveModelSelection(
        own({
          kind: "diff",
          builtInModel: "vendor/built-in",
          layers: { project: { provider: "deepseek", model: "m" } },
        }),
      ),
    ).toMatchObject({ ok: false, errorCode: "llm_provider_unsupported" });
  });

  // #555-T09
  it("refuses an excluded, an unknown and a misspelled provider as unsupported", () => {
    for (const provider of ["amazon_bedrock", "nosuchprovider", "fireworks-ai"])
      expect(
        resolveModelSelection(
          own({ layers: { project: { provider, model: "m1" } } }),
        ),
      ).toMatchObject({ ok: false, errorCode: "llm_provider_unsupported" });
  });

  // #555-T04
  it("needs a model: a catalog provider has no built-in one", () => {
    expect(
      resolveModelSelection(
        own({ layers: { project: { provider: "deepseek" } } }),
      ),
    ).toEqual({
      ok: false,
      errorCode: "job_llm_options_invalid",
      reason: "model_invalid",
    });
  });

  // #555-T04
  it("refuses a model id a job entry cannot carry", () => {
    for (const model of ["has space", "a..b", "", "x".repeat(201)])
      expect(
        resolveModelSelection(
          own({ layers: { project: { provider: "deepseek", model } } }),
        ),
      ).toEqual({
        ok: false,
        errorCode: "job_llm_options_invalid",
        reason: "model_invalid",
      });
  });

  // #588-T14
  it("carries the address the project pinned for the provider, and none when it has no pin", () => {
    const pinned = resolveModelSelection(
      own({
        layers: {
          project: {
            provider: "deepseek",
            model: "deepseek-v4-pro",
            address: "https://api.deepseek.com",
          },
        },
      }),
    );
    expect(pinned).toMatchObject({
      ok: true,
      selection: { catalog: true, pinnedAddress: "https://api.deepseek.com" },
    });

    const unpinned = resolveModelSelection(own());
    expect(unpinned).toMatchObject({ ok: true });
    expect(JSON.stringify(unpinned)).not.toContain("pinnedAddress");
  });
});
