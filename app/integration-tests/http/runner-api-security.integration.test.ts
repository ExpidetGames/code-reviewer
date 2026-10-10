// Pins down the security rules of the runner API through the real handler: nothing works without the
// shared token, a refusal says nothing about how close a token was, and the git token and the LLM key
// appear in the claim response and nowhere else (not in other answers, logs, or any table).
import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startRunnerApiHarness,
  TEST_LLM_API_KEY,
  TEST_RUNNER_TOKEN,
  type RequestOptions,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";

const UNKNOWN_JOB = "11111111-2222-4333-8444-555555555555";

afterEach(() => {
  vi.restoreAllMocks();
});

type Endpoint = {
  name: string;
  call(
    h: RunnerApiHarness,
    job: { id: string; leaseToken: string },
    request: RequestOptions,
  ): Promise<Response>;
};

const ENDPOINTS: Endpoint[] = [
  { name: "claim", call: (h, _job, request) => h.claim(request) },
  {
    name: "heartbeat",
    call: (h, job, request) => h.heartbeat(job.id, job.leaseToken, request),
  },
  {
    name: "complete",
    call: (h, job, request) => h.complete(job.id, job.leaseToken, {}, request),
  },
];

/** A job waiting for a claim and a job that is held, so every endpoint has something to change. */
async function withJobs(h: RunnerApiHarness) {
  const held = await h.enqueueNew({ prNumber: 7 });
  const body = await h.claimed();
  await h.enqueueNew({ prNumber: 8, headSha: "b".repeat(40) });
  return { id: held.id, leaseToken: body.job.leaseToken };
}

/** Everything in the database as text, to look for a value anywhere. */
async function dumpDatabase(h: RunnerApiHarness): Promise<string> {
  const { rows: tables } = await sql<{ name: string }>`
    select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`.execute(
    h.db,
  );
  const parts: string[] = [];
  for (const { name } of tables) {
    const { rows } = await sql`select * from ${sql.table(name)}`.execute(h.db);
    parts.push(JSON.stringify(rows));
  }
  return parts.join("\n");
}

describe("calls without a valid token", () => {
  // CR-28-T09
  it.each(ENDPOINTS)(
    "$name without an Authorization header is refused with 401 and changes nothing",
    async (endpoint) => {
      const h = await startRunnerApiHarness();
      const job = await withJobs(h);
      const before = await h.snapshotJobs();
      const requestsBefore = h.fake.requests().length;

      const response = await endpoint.call(h, job, { token: null });

      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("RUNNER_UNAUTHORIZED");
      expect(await h.snapshotJobs()).toStrictEqual(before);
      expect(h.fake.requests()).toHaveLength(requestsBefore);
    },
  );

  // CR-28-T10
  it("answers a missing token, a wrong token, another scheme and an empty bearer all in the same way, for all three calls", async () => {
    const h = await startRunnerApiHarness();
    const job = await withJobs(h);
    const before = await h.snapshotJobs();
    const requestsBefore = h.fake.requests().length;
    const wrong: RequestOptions[] = [
      { token: null },
      { token: "wrong-token" },
      { token: `${TEST_RUNNER_TOKEN}x` },
      { token: TEST_RUNNER_TOKEN.slice(0, -1) },
      { token: TEST_RUNNER_TOKEN.toUpperCase() },
      { authorization: `Basic ${btoa(`runner:${TEST_RUNNER_TOKEN}`)}` },
      { authorization: "Bearer" },
      { authorization: "Bearer " },
      { authorization: TEST_RUNNER_TOKEN },
    ];

    const seen = new Set<string>();
    for (const endpoint of ENDPOINTS)
      for (const request of wrong) {
        const response = await endpoint.call(h, job, request);
        expect(response.status).toBe(401);
        seen.add(
          JSON.stringify({
            status: response.status,
            body: await response.text(),
            headers: [...response.headers.entries()].sort(),
          }),
        );
      }

    expect(seen.size).toBe(1);
    expect(await h.snapshotJobs()).toStrictEqual(before);
    expect(h.fake.requests()).toHaveLength(requestsBefore);
  });

  it("does not look at the body or the job id before the token is checked", async () => {
    const h = await startRunnerApiHarness();

    const unknownJob = await h.heartbeat(UNKNOWN_JOB, "x", { token: null });
    const badId = await h.complete("not-an-id", "x", {}, { token: "wrong" });
    const badBody = await h.post("complete", UNKNOWN_JOB, "{nope", {
      token: null,
    });

    expect([unknownJob.status, badId.status, badBody.status]).toStrictEqual([
      401, 401, 401,
    ]);
  });
});

describe("a runner token that is not configured", () => {
  // CR-28-T12
  it.each([
    ["not set", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("never lets anybody in when RUNNER_TOKEN is %s", async (_name, value) => {
    const h = await startRunnerApiHarness();
    const job = await withJobs(h);
    h.env.RUNNER_TOKEN = value;
    const before = await h.snapshotJobs();
    const attempts: RequestOptions[] = [
      { authorization: "Bearer" },
      { authorization: "Bearer " },
      { authorization: "Bearer anything" },
      { authorization: `Bearer ${value ?? ""}` },
      { authorization: "Bearer undefined" },
      { token: null },
    ];

    for (const endpoint of ENDPOINTS)
      for (const request of attempts)
        expect((await endpoint.call(h, job, request)).status).toBe(401);

    expect(await h.snapshotJobs()).toStrictEqual(before);
  });
});

describe("where the git token and the LLM key appear", () => {
  async function runFullFlow(h: RunnerApiHarness) {
    await h.enqueueNew();
    const claim = await h.claimed();
    const { id, leaseToken } = claim.job;
    await h.heartbeat(id, leaseToken);
    await h.complete(id, leaseToken);
    return claim;
  }

  // CR-28-T14
  it("keeps both secrets out of every log line and every table during a whole claim, heartbeat and complete", async () => {
    const consoleLines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map(String).join(" "));
      });
    const h = await startRunnerApiHarness();

    const claim = await runFullFlow(h);

    const gitToken = claim.job.input.git.token;
    expect(gitToken).toMatch(/^ghs_fake/);
    const everything = [
      ...h.logLines(),
      ...consoleLines,
      await dumpDatabase(h),
    ].join("\n");
    expect(h.logLines().length).toBeGreaterThan(0);
    for (const secret of [gitToken, TEST_LLM_API_KEY, TEST_RUNNER_TOKEN])
      expect(everything).not.toContain(secret);
    // The lease token is a secret of the holder as well; the table keeps it (it is the fence), the
    // logs must not.
    expect([...h.logLines(), ...consoleLines].join("\n")).not.toContain(
      claim.job.leaseToken,
    );
  });

  // CR-28-T14
  it("removes a secret a runner leaked into its result before the result is stored", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();
    const claim = await h.claimed();
    const gitToken = claim.job.input.git.token;

    const response = await h.complete(claim.job.id, claim.job.leaseToken, {
      ok: false,
      errorCode: "command_failed",
      errorMessage: `refused for ${gitToken}`,
      logTail: `Authorization: token ${gitToken}\nkey=${TEST_LLM_API_KEY}`,
    });

    expect(response.status).toBe(200);
    const dump = await dumpDatabase(h);
    expect(dump).not.toContain(gitToken);
    expect(dump).not.toContain(TEST_LLM_API_KEY);
    expect((await h.queue.get(claim.job.id))?.result).toMatchObject({
      logTail: "Authorization: token [redacted]\nkey=[redacted]",
      errorMessage: "refused for [redacted]",
    });
  });

  // CR-28-T15
  it("puts the secrets in the claim response only, not in any other answer", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew({ prNumber: 7 });
    await h.enqueueNew({ prNumber: 8, headSha: "b".repeat(40) });
    const claim = await h.claimed();
    const { id, leaseToken } = claim.job;
    const secrets = [
      claim.job.input.git.token,
      claim.job.input.llm.apiKey,
      TEST_RUNNER_TOKEN,
    ];

    const answers: Response[] = [
      await h.heartbeat(id, leaseToken),
      await h.heartbeat(id, "some-other-token"),
      await h.heartbeat(UNKNOWN_JOB, leaseToken),
      await h.heartbeat("nope", leaseToken),
      await h.post("heartbeat", id, "{bad"),
      await h.complete(id, leaseToken),
      await h.complete(id, leaseToken),
      await h.complete(id, leaseToken, { ok: false, errorCode: "timeout" }),
      await h.complete(id, "some-other-token"),
      await h.complete(UNKNOWN_JOB, leaseToken),
      await h.claim(),
      await h.claim({ token: "wrong" }),
      await h.claim({ token: null }),
      await h.claim({ runnerId: "bad id" }),
    ];

    expect(answers.map((answer) => answer.status)).toStrictEqual([
      200, 409, 404, 400, 400, 200, 200, 409, 409, 404, 200, 401, 401, 400,
    ]);
    // The second claim above hands out the second job, so only that answer may hold secrets.
    const second = answers[10];
    const texts = await Promise.all(answers.map((answer) => answer.text()));
    texts.forEach((text, index) => {
      if (answers[index] === second) return;
      for (const secret of secrets) expect(text).not.toContain(secret);
    });
  });

  it("keeps the git token and the LLM key out of what is stored when a job is released after a failure", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();
    h.fake.fail({ pathIncludes: "/access_tokens", status: 503, times: 1 });

    const response = await h.claim();

    expect(response.status).toBe(503);
    const dump = await dumpDatabase(h);
    expect(dump).not.toContain(TEST_LLM_API_KEY);
    expect(dump).not.toMatch(/ghs_fake/);
  });
});
