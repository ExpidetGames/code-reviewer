// SPDX-License-Identifier: Apache-2.0

// Pins down the fake LLM (fakes/llm) over real HTTP the way PR-Agent speaks to it through LiteLLM's
// OpenRouter path: a canned answer per kind of prompt, the key of the request recorded, and errors
// that quote the key when asked. The journey with the real runner and PR-Agent (e2e/jobs) relies on
// it, so a wrong fake fails here first.
import { describe, expect, it } from "vitest";
import { review } from "../../../fakes/llm/canned.ts";
import { startLlmFake } from "../../../fakes/llm/server.ts";
import { cleanUpAfterTest } from "./test-database.ts";

async function setup() {
  const fake = await startLlmFake();
  cleanUpAfterTest(() => fake.close());
  return fake;
}

/** A chat completion request with this system prompt, like PR-Agent sends. */
async function ask(
  baseUrl: string,
  system: string,
  key = "dummy-key",
  extra: Record<string, unknown> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "openrouter/test/fake-model",
      messages: [
        { role: "system", content: system },
        { role: "user", content: "the diff of the pull request" },
      ],
      ...extra,
    }),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

const answerOf = (json: Record<string, unknown>) =>
  (json.choices as Array<{ message: { content: string } }>)[0]?.message.content;

describe("the fake LLM", () => {
  it("answers a prompt with the review reply and records who asked", async () => {
    const llm = await setup();

    const reviewed = await ask(
      llm.baseUrl,
      "You are PR-Reviewer, a language model designed to review a Git Pull Request.",
      "the-key",
    );

    expect(reviewed.status).toBe(200);
    expect(answerOf(reviewed.json)).toBe(review());
    expect(llm.requests()).toMatchObject([
      {
        kind: "review",
        authorization: "Bearer the-key",
        model: "openrouter/test/fake-model",
      },
    ]);
    expect(llm.requests()[0]?.prompt).toContain("the diff of the pull request");
  });

  // #270-T07
  it("records the provider field of a request, null when there is none", async () => {
    const llm = await setup();
    const system = "You are PR-Reviewer, a language model designed to review.";

    await ask(llm.baseUrl, system, "k", {
      provider: { require_parameters: true },
    });
    await ask(llm.baseUrl, system);

    expect(llm.requests().map((request) => request.provider)).toEqual([
      { require_parameters: true },
      null,
    ]);
  });

  it("answers with another text when a reply is replaced and with the canned one again after a reset", async () => {
    const llm = await setup();
    llm.setReply("review", review("second run"));

    const replaced = await ask(llm.baseUrl, "review this pull request");
    llm.reset();
    const normal = await ask(llm.baseUrl, "review this pull request");

    expect(answerOf(replaced.json)).toContain("second run");
    expect(answerOf(normal.json)).toContain("first run");
    expect(llm.requests()).toHaveLength(1);
  });

  it("answers every request with the error it was told to, and quotes the key only when asked to", async () => {
    const llm = await setup();
    llm.failWith({ status: 429, message: "slow down" });

    const plain = await ask(llm.baseUrl, "review this", "secret-key");
    llm.quoteKeyInErrors(true);
    const quoting = await ask(llm.baseUrl, "review this", "secret-key");

    expect(plain.status).toBe(429);
    expect(JSON.stringify(plain.json)).toContain("slow down");
    expect(JSON.stringify(plain.json)).not.toContain("secret-key");
    expect(quoting.status).toBe(429);
    expect(JSON.stringify(quoting.json)).toContain(
      "Incorrect API key provided: secret-key",
    );
  });

  it("answers a path that is no chat completion with 404", async () => {
    const llm = await setup();

    const response = await fetch(`${llm.baseUrl}/models`);

    expect(response.status).toBe(404);
    expect(llm.requests()).toEqual([]);
  });
});
