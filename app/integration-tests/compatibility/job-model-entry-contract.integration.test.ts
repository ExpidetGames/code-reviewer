// SPDX-License-Identifier: Apache-2.0

// Pins down `contracts/job-model-entry.v1.json` (#548) from the app's side, the writer: the example is valid, the entry is
// closed, and the rules the engine imposes on the entry (both limits or neither, a status it does not drop, `npm` always
// set, an upstream address that is https) are in the file. The runner checks the same example in
// runner/tests/contract/test_job_model_entry_contract.py.
import { describe, expect, it } from "vitest";
import {
  createContractValidator,
  readExamples,
} from "../../src/test-support/runner-contract.ts";

const validator = createContractValidator("job-model-entry.v1.json");

function example(): Record<string, unknown> {
  const found = readExamples("examples/job-model-entry").find((e) => e.definition === "JobModelEntry");
  if (found === undefined) throw new Error("No example JobModelEntry");
  return structuredClone(found.document) as Record<string, unknown>;
}

function accepts(document: unknown): boolean {
  return validator.check("JobModelEntry", document).valid;
}

function withModel(change: (model: Record<string, unknown>) => void) {
  const document = example();
  change(document.model as Record<string, unknown>);
  return document;
}

describe("the job model entry contract", () => {
  // #548-T10
  it("accepts its example", () => {
    expect(validator.check("JobModelEntry", example())).toEqual({ valid: true, errors: "" });
  });

  // #548-T10
  it.each([
    ["a field it does not know at the top", (d: Record<string, unknown>) => (d.apiKey = "sk-live-1")],
    ["a field it does not know in the model", (d: Record<string, unknown>) => ((d.model as Record<string, unknown>).cost = { input: 1, output: 2 })],
    ["no npm", (d: Record<string, unknown>) => delete d.npm],
    ["no family", (d: Record<string, unknown>) => delete d.family],
    ["a family it does not speak", (d: Record<string, unknown>) => (d.family = "cohere-chat")],
    ["a key header it does not swap", (d: Record<string, unknown>) => (d.authHeader = "api-key")],
    ["an http upstream address", (d: Record<string, unknown>) => (d.upstreamBaseUrl = "http://api.deepseek.com")],
    ["an upstream address with credentials", (d: Record<string, unknown>) => (d.upstreamBaseUrl = "https://user:pw@api.deepseek.com")],
    ["an upstream address with a query", (d: Record<string, unknown>) => (d.upstreamBaseUrl = "https://api.deepseek.com/v1?key=1")],
    ["a model id with a space", (d: Record<string, unknown>) => (d.modelId = "bad id")],
    ["another version", (d: Record<string, unknown>) => (d.version = 2)],
  ])("refuses %s", (_name, change) => {
    const document = example();
    change(document);

    expect(accepts(document)).toBe(false);
  });

  // #548-T10
  it.each([
    ["a limit with the context only", (m: Record<string, unknown>) => (m.limit = { context: 1000 })],
    ["a limit with the output only", (m: Record<string, unknown>) => (m.limit = { output: 100 })],
    ["no limit", (m: Record<string, unknown>) => delete m.limit],
    ["a limit of zero", (m: Record<string, unknown>) => (m.limit = { context: 0, output: 0 })],
    ["a status the engine drops (deprecated)", (m: Record<string, unknown>) => (m.status = "deprecated")],
    ["a status the engine drops (alpha)", (m: Record<string, unknown>) => (m.status = "alpha")],
    ["a model that cannot call tools", (m: Record<string, unknown>) => (m.tool_call = false)],
    ["a modality it does not know", (m: Record<string, unknown>) => (m.modalities = { input: ["text", "smell"], output: ["text"] })],
    ["an interleaved field that is not a name", (m: Record<string, unknown>) => (m.interleaved = { field: "<script>" })],
  ])("refuses a model with %s", (_name, change) => {
    expect(accepts(withModel(change))).toBe(false);
  });

  // #548-T10
  it("accepts beta, an input limit and `interleaved: true`", () => {
    const document = withModel((m) => {
      m.status = "beta";
      m.limit = { context: 1000, output: 100, input: 900 };
      m.interleaved = true;
    });

    expect(accepts(document)).toBe(true);
  });
});
