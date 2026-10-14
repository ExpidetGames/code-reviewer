// SPDX-License-Identifier: Apache-2.0

// The model capabilities a Dynamic claim carries (#279): the app reads the metadata of the job's model
// when it builds the claim, puts the descriptor into `dynamic.capabilities` for a runner that said it
// understands it, fails a model without tool choice before any credential exists, and never invents
// anything when the metadata cannot be read. The real claim over a real SQLite file; the provider's
// metadata is a scripted fetch.
import { describe, expect, it } from "vitest";
import {
  createModelCapabilityChecker,
  type ModelCapabilityChecker,
  type ModelCapabilityResult,
} from "../../src/llm/model-capabilities.ts";
import { startRunnerApiHarness } from "../../src/test-support/runner-api-harness.ts";

const MODEL = "vendor/dynamic-model";
const ENGINES = ["opencode"];
const FEATURES = ["dynamic_capabilities"];

const SUPPORTED: ModelCapabilityResult = {
  outcome: "supported",
  capabilities: {
    tools: true,
    toolChoice: true,
    toolChoiceRequired: true,
    responseFormat: true,
    structuredOutputs: true,
    maxCompletionTokens: 393_216,
    smallestCompletionTokens: 131_072,
    contextLength: 1_048_576,
    inputUsdPerMtok: "0.6",
    outputUsdPerMtok: "2.4",
  },
};

function scripted(result: ModelCapabilityResult) {
  const asked: string[] = [];
  const checker: ModelCapabilityChecker = {
    check: async (modelId) => {
      asked.push(modelId);
      return result;
    },
  };
  return { checker, asked };
}

async function startDynamic(checker?: ModelCapabilityChecker) {
  const h = await startRunnerApiHarness({
    projects: true,
    ...(checker === undefined ? {} : { modelCapabilities: checker }),
  });
  await h.projectService.activateProject(h.repositoryId);
  await h.reviewSettings.updateProjectSettings(h.repositoryId, {
    reviewKind: "dynamic",
    dynamicModel: MODEL,
  });
  return h;
}

describe("the capabilities of the model in a Dynamic claim", () => {
  // #279-T01
  it("carries the descriptor read from the metadata to a runner that advertised the feature", async () => {
    const { checker, asked } = scripted(SUPPORTED);
    const h = await startDynamic(checker);
    await h.enqueueNew();

    const claim = await h.claimed({ engines: ENGINES, features: FEATURES });

    expect(claim.job.input.dynamic?.capabilities).toEqual({
      toolChoiceRequired: true,
      structuredOutput: true,
      maxOutputTokens: 8192,
      contextWindowTokens: 1_048_576,
      inputUsdPerMtok: "0.6",
      outputUsdPerMtok: "2.4",
    });
    expect(asked).toEqual([MODEL]);
    expect(h.infoLines.join("\n")).toContain("model capabilities sent");
  });

  // #279-T07: a runner from before #279 refuses a field it does not know, so it never gets one.
  it("is left out for a runner that did not advertise the feature, byte for byte as before", async () => {
    const { checker } = scripted(SUPPORTED);
    const h = await startDynamic(checker);
    await h.enqueueNew();

    const claim = await h.claimed({ engines: ENGINES });

    expect(claim.job.input.dynamic).toEqual({
      model: MODEL,
      skill: expect.any(String),
      limits: { maxFindings: expect.any(Number) },
    });
    expect(Object.keys(claim.job.input.dynamic ?? {}).sort()).toEqual([
      "limits",
      "model",
      "skill",
    ]);
  });

  // #279-T07
  it("is left out when the claim names unknown features only", async () => {
    const { checker } = scripted(SUPPORTED);
    const h = await startDynamic(checker);
    await h.enqueueNew();

    const claim = await h.claimed({
      engines: ENGINES,
      features: ["a_future_feature"],
    });

    expect(claim.job.input.dynamic).not.toHaveProperty("capabilities");
  });

  // #279-T08
  it("is not asked for at all without a checker, as before", async () => {
    const h = await startDynamic();
    await h.enqueueNew();

    const claim = await h.claimed({ engines: ENGINES, features: FEATURES });

    expect(claim.job.input.dynamic).not.toHaveProperty("capabilities");
  });

  // #279-T05
  it.each([
    ["the provider cannot be reached", { outcome: "unverifiable" }],
    ["the provider does not know the model", { outcome: "unknown_model" }],
  ] as const)(
    "falls back to the runner's own descriptor, says so in the log and does not fail when %s",
    async (_name, result) => {
      const { checker } = scripted(result);
      const h = await startDynamic(checker);
      await h.enqueueNew();

      const claim = await h.claimed({ engines: ENGINES, features: FEATURES });

      expect(claim.job.input.dynamic).not.toHaveProperty("capabilities");
      expect(h.infoLines.join("\n")).toContain(
        `model capabilities not read (${result.outcome})`,
      );
    },
  );

  // #279-T05: through the real checker, with a provider that does not answer.
  it("falls back when the real checker's fetch fails", async () => {
    const checker = createModelCapabilityChecker({
      baseUrl: () => "https://llm.example.test/api/v1",
      fetchImpl: () => Promise.reject(new Error("offline")),
      log: () => undefined,
    });
    const h = await startDynamic(checker);
    await h.enqueueNew();

    const claim = await h.claimed({ engines: ENGINES, features: FEATURES });

    expect(claim.job.input.dynamic).not.toHaveProperty("capabilities");
    expect(claim.job.input.dynamic?.model).toBe(MODEL);
  });

  // #279: it never invents a window.
  it("falls back when the metadata states no context window", async () => {
    const { checker } = scripted({
      outcome: "supported",
      capabilities: { ...SUPPORTED.capabilities, contextLength: null },
    });
    const h = await startDynamic(checker);
    await h.enqueueNew();

    const claim = await h.claimed({ engines: ENGINES, features: FEATURES });

    expect(claim.job.input.dynamic).not.toHaveProperty("capabilities");
    expect(h.infoLines.join("\n")).toContain("model capabilities not read");
  });

  // #279: a model without prices still runs from the claim's side; the runner refuses it.
  it("leaves the prices out when the metadata has none", async () => {
    const { checker } = scripted({
      outcome: "supported",
      capabilities: {
        ...SUPPORTED.capabilities,
        inputUsdPerMtok: null,
        outputUsdPerMtok: null,
      },
    });
    const h = await startDynamic(checker);
    await h.enqueueNew();

    const claim = await h.claimed({ engines: ENGINES, features: FEATURES });

    const sent = claim.job.input.dynamic?.capabilities;
    expect(sent).toMatchObject({ contextWindowTokens: 1_048_576 });
    expect(sent).not.toHaveProperty("inputUsdPerMtok");
    expect(sent).not.toHaveProperty("outputUsdPerMtok");
  });

  // #279-T06
  it.each([
    ["a runner that understands the descriptor", { features: FEATURES }],
    ["a runner from before the descriptor", {}],
  ])(
    "fails a model without tool choice with dynamic_model_features_unsupported and creates no credential for %s",
    async (_name, extra) => {
      const { checker } = scripted({
        outcome: "unsupported",
        capabilities: {
          ...SUPPORTED.capabilities,
          toolChoice: false,
          toolChoiceRequired: false,
        },
      });
      const h = await startDynamic(checker);
      const job = await h.enqueueNew();

      const response = await h.claim({ engines: ENGINES, ...extra });

      expect(response.status).toBe(204);
      expect(await h.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: "dynamic_model_features_unsupported",
      });
      expect(h.issuedJobTokens()).toEqual([]);
    },
  );

  // #279-T08: a Diff job never asks the provider.
  it("is not read for a Diff job", async () => {
    const { checker, asked } = scripted(SUPPORTED);
    const h = await startRunnerApiHarness({
      projects: true,
      modelCapabilities: checker,
    });
    await h.projectService.activateProject(h.repositoryId);
    await h.enqueueNew();

    const claim = await h.claimed({
      engines: ["pr-agent"],
      features: FEATURES,
    });

    expect(claim.job.input).not.toHaveProperty("dynamic");
    expect(asked).toEqual([]);
  });

  // #279 (review): the read waits up to five seconds, so a job that a cheap local check refuses
  // anyway must not pay it.
  it("is not read for a job that ends because its pull request is closed", async () => {
    const { checker, asked } = scripted(SUPPORTED);
    const h = await startDynamic(checker);
    const job = await h.enqueueNew({ prNumber: 9 });

    const response = await h.claim({ engines: ENGINES, features: FEATURES });

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "pull_request_closed",
    });
    expect(asked).toEqual([]);
  });

  // #279-T06 (review): still before the credential is created.
  it("is read before the git credentials are created", async () => {
    let tokensWhenRead = -1;
    const h = await startDynamic({
      check: async () => {
        tokensWhenRead = h.issuedJobTokens().length;
        return SUPPORTED;
      },
    });
    await h.enqueueNew();

    await h.claimed({ engines: ENGINES, features: FEATURES });

    expect(tokensWhenRead).toBe(0);
    expect(h.issuedJobTokens().length).toBe(1);
  });
});
