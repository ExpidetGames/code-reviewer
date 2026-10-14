// SPDX-License-Identifier: Apache-2.0

// Pins down the agent mode of the fake LLM (fakes/llm): the answers the real, pinned OpenCode gets from the
// runner's model proxy in the Dynamic e2e lane (#253). The engine sends a chat completion that offers tools;
// the fake answers with the scripted tool calls one request at a time and, when they are used up, with the
// structured findings through the engine's `StructuredOutput` tool, exactly as the engine suite's scripted
// model does (runner/tests/engine/opencode_support.py). A request that offers no tool (the engine's title
// request) is answered with plain text. The journey relies on it, so a wrong fake fails here first.
import { describe, expect, it } from "vitest";
import { startLlmFake } from "../../../fakes/llm/server.ts";
import { cleanUpAfterTest } from "./test-database.ts";

async function setup() {
  const fake = await startLlmFake();
  cleanUpAfterTest(() => fake.close());
  return fake;
}

const TOOLS = [
  { type: "function", function: { name: "read" } },
  { type: "function", function: { name: "StructuredOutput" } },
];

type Message = Record<string, unknown>;

async function ask(
  baseUrl: string,
  messages: Message[],
  tools: unknown[] | null = TOOLS,
) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer the-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "vendor/agent-e2e",
      messages,
      ...(tools === null ? {} : { tools }),
    }),
  });
  return {
    status: response.status,
    json: (await response.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    },
  };
}

const FINAL = { schemaVersion: 1, reviewedSha: "a".repeat(40), findings: [] };

describe("the agent mode of the fake LLM", () => {
  // #253-F04
  it("answers the requests that offer tools with the scripted calls in order, then with the structured answer", async () => {
    const fake = await setup();
    fake.scriptAgent({
      steps: [
        [{ name: "read", arguments: { filePath: "src/lookup.py" } }],
        [
          { name: "read", arguments: { filePath: "README.md" } },
          { name: "read", arguments: { filePath: "src/app.py" } },
        ],
      ],
      final: FINAL,
    });
    const conversation: Message[] = [{ role: "user", content: "review" }];

    const first = await ask(fake.baseUrl, conversation);
    const second = await ask(fake.baseUrl, conversation);
    const third = await ask(fake.baseUrl, conversation);
    const fourth = await ask(fake.baseUrl, conversation);

    const call = (answer: typeof first, index = 0) => {
      const found = answer.json.choices[0]?.message.tool_calls?.[index];
      return {
        name: found?.function.name,
        arguments: JSON.parse(found?.function.arguments ?? "null") as unknown,
      };
    };
    expect(first.json.choices[0]?.finish_reason).toBe("tool_calls");
    expect(call(first)).toEqual({
      name: "read",
      arguments: { filePath: "src/lookup.py" },
    });
    expect(call(second, 0).arguments).toEqual({ filePath: "README.md" });
    expect(call(second, 1).arguments).toEqual({ filePath: "src/app.py" });
    expect(call(third)).toEqual({ name: "StructuredOutput", arguments: FINAL });
    expect(call(fourth).name).toBe("StructuredOutput");
    // The ids differ, so the engine can tell the calls apart.
    const ids = [first, second, third].flatMap((answer) =>
      (answer.json.choices[0]?.message.tool_calls ?? []).map((item) => item.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  // #253-F04
  it("answers a request without tools with plain text and does not spend a step on it", async () => {
    const fake = await setup();
    fake.scriptAgent({
      steps: [[{ name: "read", arguments: { filePath: "a" } }]],
      final: FINAL,
    });

    const title = await ask(
      fake.baseUrl,
      [{ role: "user", content: "t" }],
      null,
    );
    const first = await ask(fake.baseUrl, [{ role: "user", content: "r" }]);

    expect(title.json.choices[0]?.message.content).toBe("ok");
    expect(title.json.choices[0]?.message.tool_calls).toBeUndefined();
    expect(first.json.choices[0]?.message.tool_calls?.[0]?.function.name).toBe(
      "read",
    );
  });

  // #253-F05
  it("reports fixed token counts, so a journey can check the usage the Runs page shows", async () => {
    const fake = await setup();
    fake.scriptAgent({ steps: [], final: FINAL });

    const answer = await ask(fake.baseUrl, [{ role: "user", content: "r" }]);

    expect(answer.json.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
    });
  });

  // #253-F05
  it("records the key, the offered tools and the tool results the engine sent back", async () => {
    const fake = await setup();
    fake.scriptAgent({
      steps: [[{ name: "read", arguments: { filePath: "src/lookup.py" } }]],
      final: FINAL,
    });
    await ask(fake.baseUrl, [{ role: "user", content: "review" }]);

    await ask(fake.baseUrl, [
      { role: "user", content: "review" },
      { role: "assistant", content: null, tool_calls: [] },
      { role: "tool", tool_call_id: "call_1", content: "def lookup(): ..." },
    ]);

    const [first, second] = fake.requests();
    expect(first?.authorization).toBe("Bearer the-key");
    expect(first?.tools).toEqual(["read", "StructuredOutput"]);
    expect(second?.toolResults).toEqual({ call_1: "def lookup(): ..." });
  });

  // #253-F05
  it("is switched off by reset and by null, and the canned reply of the PR-Agent tests is then back", async () => {
    const fake = await setup();
    fake.scriptAgent({ steps: [], final: FINAL });
    fake.scriptAgent(null);

    const answer = await ask(fake.baseUrl, [{ role: "user", content: "r" }]);

    expect(answer.json.choices[0]?.message.tool_calls).toBeUndefined();
    expect(answer.json.choices[0]?.message.content).toContain("review:");
    fake.scriptAgent({ steps: [], final: FINAL });
    fake.reset();
    const after = await ask(fake.baseUrl, [{ role: "user", content: "r" }]);
    expect(after.json.choices[0]?.message.tool_calls).toBeUndefined();
  });
});
