// SPDX-License-Identifier: Apache-2.0

// #511-T28: the fake LLM (fakes/llm) speaks the Anthropic Messages API the way the Claude API does: the key in
// `x-api-key`, the version header, answers in the Messages shape with a usage of input, output and cache
// tokens, tool calls as `tool_use` blocks, errors in the error envelope. The runner's Diff and Dynamic paths
// and the Anthropic adapter rely on it, so a wrong fake fails here first.
import { describe, expect, it } from "vitest";
import { startLlmFake } from "../../../fakes/llm/server.ts";
import { cleanUpAfterTest } from "./test-database.ts";

async function setup() {
  const fake = await startLlmFake();
  cleanUpAfterTest(() => fake.close());
  return fake;
}

async function messages(
  baseUrl: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = { "x-api-key": "dummy-key" },
) {
  const response = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

const REQUEST = {
  model: "claude-haiku-5-5",
  max_tokens: 1000,
  system: "you review",
  messages: [{ role: "user", content: "the diff" }],
};

describe("the fake LLM as the Anthropic Messages API", () => {
  // #511-T28
  it("answers a request with a message, a usage and the canned review, and records the request", async () => {
    const fake = await setup();

    const { status, json } = await messages(fake.baseUrl, REQUEST);

    expect(status).toBe(200);
    expect(json).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(
      (json.content as Array<{ type: string; text: string }>)[0]?.text,
    ).toContain("review:");
    expect(fake.messageRequests()).toEqual([
      { apiKey: "dummy-key", version: "2023-06-01", body: REQUEST },
    ]);
  });

  // #511-T28
  it("reports the usage a test sets, cache tokens included", async () => {
    const fake = await setup();
    fake.setMessagesUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 3,
      cache_creation: {
        ephemeral_5m_input_tokens: 3,
        ephemeral_1h_input_tokens: 0,
      },
    });

    const { json } = await messages(fake.baseUrl, REQUEST);

    expect(json.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 3,
      cache_creation: {
        ephemeral_5m_input_tokens: 3,
        ephemeral_1h_input_tokens: 0,
      },
    });
  });

  // #511-T28
  it("answers no request without a key", async () => {
    const fake = await setup();

    const { status, json } = await messages(fake.baseUrl, REQUEST, {});

    expect(status).toBe(401);
    expect(json).toMatchObject({
      type: "error",
      error: { type: "authentication_error" },
    });
  });

  // #511-T28
  it("answers the scripted errors in the error envelope, quoting the key when asked", async () => {
    const fake = await setup();
    fake.failWith({ status: 529, message: "Overloaded" });

    const { status, json } = await messages(fake.baseUrl, REQUEST);

    expect(status).toBe(529);
    expect(json).toEqual({
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    });
  });

  // #511-T28
  it("gives a request that offers tools the scripted tool calls and then the structured answer", async () => {
    const fake = await setup();
    fake.scriptAgent({
      steps: [[{ name: "read", arguments: { path: "a.py" } }]],
      final: { findings: [] },
    });
    const tools = [
      { name: "read", input_schema: { type: "object" } },
      { name: "StructuredOutput", input_schema: { type: "object" } },
    ];

    const first = await messages(fake.baseUrl, { ...REQUEST, tools });
    const second = await messages(fake.baseUrl, { ...REQUEST, tools });

    expect(first.json).toMatchObject({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "read", input: { path: "a.py" } }],
    });
    expect(second.json).toMatchObject({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", name: "StructuredOutput", input: { findings: [] } },
      ],
    });
  });

  // #511-T28
  it("checks a key with GET /models and does not mix it up with the other provider's key check", async () => {
    const fake = await setup();
    fake.acceptKeys(["good-key"]);

    const good = await fetch(`${fake.baseUrl}/models?limit=1`, {
      headers: { "x-api-key": "good-key", "anthropic-version": "2023-06-01" },
    });
    const bad = await fetch(`${fake.baseUrl}/models?limit=1`, {
      headers: { "x-api-key": "bad-key" },
    });
    const none = await fetch(`${fake.baseUrl}/models?limit=1`);

    expect([good.status, bad.status, none.status]).toEqual([200, 401, 401]);
    expect(fake.anthropicKeyChecks().map((check) => check.apiKey)).toEqual([
      "good-key",
      "bad-key",
      "",
    ]);
    expect(fake.keyChecks()).toEqual([]);
  });
});
