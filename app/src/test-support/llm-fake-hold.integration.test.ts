// SPDX-License-Identifier: Apache-2.0

// Pins down the hold of the fake LLM (fakes/llm, #332): while it is on, a chat completion is recorded when it
// arrives and answered only when the hold is lifted, so a journey can have a review that is in progress and end the
// process that runs it (the hosted lane's "Worker dies mid-job"). A request whose client hung up in the meantime is
// not answered. The journey relies on it, so a wrong fake fails here first.
import { describe, expect, it } from "vitest";
import { startLlmFake } from "../../../fakes/llm/server.ts";
import { cleanUpAfterTest } from "./test-database.ts";

async function setup() {
  const fake = await startLlmFake();
  cleanUpAfterTest(() => fake.close());
  return fake;
}

function ask(baseUrl: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer the-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "vendor/m",
      messages: [{ role: "user", content: "hello" }],
    }),
    signal,
  });
}

async function arrived(fake: Awaited<ReturnType<typeof setup>>, count: number) {
  const deadline = Date.now() + 5000;
  while (fake.requests().length < count) {
    if (Date.now() > deadline) throw new Error("The request never arrived.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the hold of the fake LLM", () => {
  // #332-T06
  it("records a request when it arrives and answers it when the hold is lifted", async () => {
    const fake = await setup();
    fake.hold(true);

    const answer = ask(fake.baseUrl).then((response) => response.status);
    await arrived(fake, 1);
    const early = await Promise.race([
      answer,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("waiting"), 100),
      ),
    ]);
    fake.hold(false);

    expect(early).toBe("waiting");
    expect(await answer).toBe(200);
  });

  // #332-T06
  it("answers the request that is held when the fake is reset, and does not hold the next one", async () => {
    const fake = await setup();
    fake.hold(true);
    const answer = ask(fake.baseUrl).then((response) => response.status);
    await arrived(fake, 1);

    fake.reset();

    expect(await answer).toBe(200);
    expect((await ask(fake.baseUrl)).status).toBe(200);
  });

  // #332-T06
  it("sends nothing to a client that hung up while its request was held", async () => {
    const fake = await setup();
    fake.hold(true);
    const controller = new AbortController();
    const hungUp = ask(fake.baseUrl, controller.signal).catch(
      (error: unknown) => (error as Error).name,
    );
    await arrived(fake, 1);

    controller.abort();
    fake.hold(false);

    expect(await hungUp).toBe("AbortError");
    expect((await ask(fake.baseUrl)).status).toBe(200);
  });
});
