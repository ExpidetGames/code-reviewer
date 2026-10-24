// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterEach, describe, expect, it } from "vitest";
import { createAppClient } from "./app-client.ts";
import { DISPATCHER_TOKEN, startApp } from "../test-support/harness.ts";

const JOB = "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10";
const fakes: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

type Seen = { url: string; init: RequestInit };

/** A fetch that records the request and answers as told: a Response, or an error for a call that got no answer. */
function stub(answer: Response | Error) {
  const seen: Seen[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    seen.push({ url: String(input), init: init ?? {} });
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer.clone());
  };
  const client = createAppClient({
    appUrl: "https://app.test/",
    token: DISPATCHER_TOKEN,
    poolId: "test-pool",
    fetch: fetchStub,
  });
  return { client, seen };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("the job state call of the App client", () => {
  // #364-T22
  it("asks with a GET and the dispatcher credential in the header only, no body, no redirect followed", async () => {
    const { client, seen } = stub(
      json({ version: 1, job: { id: JOB, status: "running" } }),
    );

    await client.jobState(JOB);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`https://app.test/api/runners/v1/jobs/${JOB}`);
    expect(seen[0]?.init.method).toBe("GET");
    expect(seen[0]?.init.body).toBeUndefined();
    expect(seen[0]?.init.redirect).toBe("error");
    expect(seen[0]?.init.headers).toStrictEqual({
      authorization: `Bearer ${DISPATCHER_TOKEN}`,
      accept: "application/json",
    });
    expect(seen[0]?.url).not.toContain(DISPATCHER_TOKEN);
  });

  // #364-T22
  it("puts the id in the path as one segment", async () => {
    const { client, seen } = stub(json({}, 404));

    await client.jobState("a/../b?x=1");

    expect(seen[0]?.url).toBe(
      "https://app.test/api/runners/v1/jobs/a%2F..%2Fb%3Fx%3D1",
    );
  });

  // #364-T22
  it.each([
    "queued",
    "running",
    "succeeded",
    "failed",
    "superseded",
    "cancelled",
  ])("reads the status %s", async (status) => {
    const { client } = stub(json({ version: 1, job: { id: JOB, status } }));

    expect(await client.jobState(JOB)).toStrictEqual({ kind: "known", status });
  });

  // #397-T12
  it("reads the draining of a superseded job, and only the boolean true", async () => {
    for (const [draining, expected] of [
      [true, { kind: "known", status: "superseded", draining: true }],
      [false, { kind: "known", status: "superseded" }],
    ] as const) {
      const { client } = stub(
        json({ version: 1, job: { id: JOB, status: "superseded", draining } }),
      );
      expect(await client.jobState(JOB)).toStrictEqual(expected);
    }
    const { client } = stub(
      json({
        version: 1,
        job: { id: JOB, status: "superseded", draining: "yes" },
      }),
    );
    expect(await client.jobState(JOB)).toStrictEqual({ kind: "unreadable" });
  });

  // #364-T22
  it("reads the answer of the fake App for every status it can be set to", async () => {
    const fake = await startApp();
    fakes.push(fake);
    const client = createAppClient({
      appUrl: fake.url,
      token: DISPATCHER_TOKEN,
      poolId: "test-pool",
      fetch,
    });
    fake.enqueue({ id: JOB });
    const seen: string[] = [];

    for (const status of [
      "queued",
      "running",
      "succeeded",
      "failed",
      "superseded",
      "cancelled",
    ] as const) {
      fake.setJobStatus(JOB, status);
      const state = await client.jobState(JOB);
      if (state.kind === "known") seen.push(state.status);
    }

    expect(seen).toStrictEqual([
      "queued",
      "running",
      "succeeded",
      "failed",
      "superseded",
      "cancelled",
    ]);
  });

  // #364-T22
  // #364-T08
  it.each<[string, Response | Error]>([
    ["no answer", new TypeError("fetch failed")],
    [
      "a refused credential",
      json({ error: { code: "RUNNER_UNAUTHORIZED" } }, 401),
    ],
    [
      "an App without the route (404 with a page)",
      new Response("<html>Not Found</html>", { status: 404 }),
    ],
    [
      "a job the App does not know",
      json({ error: { code: "RUNNER_JOB_NOT_FOUND" } }, 404),
    ],
    ["a server error", json({ error: { code: "RUNNER_INTERNAL_ERROR" } }, 500)],
    ["a body that is no JSON", new Response("nope", { status: 200 })],
    ["a body of another shape", json({ ok: true })],
    ["a legacy claim body", json({ version: 1, job: { id: JOB, input: {} } })],
    [
      "a status it does not know",
      json({ version: 1, job: { id: JOB, status: "paused" } }),
    ],
    [
      "the state of another job",
      json({
        version: 1,
        job: { id: "11111111-1111-4111-8111-111111111111", status: "failed" },
      }),
    ],
    [
      "another version",
      json({ version: 2, job: { id: JOB, status: "failed" } }),
    ],
  ])("treats %s as unreadable", async (_name, answer) => {
    const { client } = stub(answer);

    expect(await client.jobState(JOB)).toStrictEqual({ kind: "unreadable" });
  });
});
