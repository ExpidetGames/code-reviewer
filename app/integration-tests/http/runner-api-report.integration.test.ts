// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down `POST /api/runners/v1/jobs/:id/heartbeat` and `/complete` through the real handler and a
// real Postgres database: what a holder of a job may do, what happens to a runner that lost its job, what a
// repeated report answers, and how bodies that are wrong or too large are refused without changing
// anything. Claiming is in runner-api-claim.integration.test.ts.
import { describe, expect, it } from "vitest";
import { T0 } from "../../src/test-support/jobs.ts";
import {
  goodResult,
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";

const MINUTE = 60 * 1000;
const UNKNOWN_JOB = "11111111-2222-4333-8444-555555555555";

/** A job claimed through the API: its id and the lease token of the claim. */
async function claimedJob(h: RunnerApiHarness, runnerId = "runner-a") {
  const job = await h.enqueueNew();
  const body = await h.claimed({ runnerId });
  return { id: job.id, leaseToken: body.job.leaseToken };
}

async function errorOf(response: Response) {
  return (await response.json()).error as {
    code: string;
    message: string;
    fields?: Array<{ field: string; code: string }>;
  };
}

describe("a heartbeat", () => {
  // CR-28-T06
  it("extends the lease and answers with the new expiry", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    h.clock.advance(30 * 1000);

    const response = await h.heartbeat(job.id, job.leaseToken);

    expect(response.status).toBe(200);
    const heartbeatAt = new Date(T0.getTime() + 30 * 1000).toISOString();
    const leaseExpiresAt = new Date(
      T0.getTime() + 30 * 1000 + 2 * MINUTE,
    ).toISOString();
    expect(await response.json()).toStrictEqual({
      version: 1,
      job: { id: job.id, heartbeatAt, leaseExpiresAt },
    });
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "running",
      heartbeatAt,
      leaseExpiresAt,
    });
  });

  // CR-28-T16
  it("is refused with 409 for another runner that does not hold the job, and changes nothing", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h, "runner-a");
    const before = await h.snapshotJobs();

    const response = await h.heartbeat(job.id, crypto.randomUUID(), {
      runnerId: "runner-b",
    });

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("RUNNER_LEASE_LOST");
    expect(await h.snapshotJobs()).toStrictEqual(before);
  });

  it("is refused for a runner that claimed the job again under the same runner id after losing it", async () => {
    const h = await startRunnerApiHarness();
    const first = await claimedJob(h, "runner-a");
    h.clock.advance(3 * MINUTE);
    const second = await h.claimed({ runnerId: "runner-a" });

    const stale = await h.heartbeat(first.id, first.leaseToken, {
      runnerId: "runner-a",
    });
    const current = await h.heartbeat(second.job.id, second.job.leaseToken, {
      runnerId: "runner-a",
    });

    expect(second.job.id).toBe(first.id);
    expect(stale.status).toBe(409);
    expect(current.status).toBe(200);
  });

  // CR-28-T17
  it("answers 404 with a stable code for a job that does not exist", async () => {
    const h = await startRunnerApiHarness();

    const response = await h.heartbeat(UNKNOWN_JOB, "some-lease-token");

    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("RUNNER_JOB_NOT_FOUND");
  });

  it("is refused with 409 for a job that already finished", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    await h.complete(job.id, job.leaseToken);

    const response = await h.heartbeat(job.id, job.leaseToken);

    expect(response.status).toBe(409);
  });

  it("tells a runner past the hard time limit to stop, and fails the job with timeout", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    for (let minute = 0; minute < 26; minute += 1) {
      h.clock.advance(MINUTE);
      const response = await h.heartbeat(job.id, job.leaseToken);
      if (response.status === 409) break;
    }

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "timeout",
    });
  });
});

describe("completing a job", () => {
  // CR-28-T07
  it("stores the result, finishes the job and releases the reservation", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    h.clock.advance(41 * 1000);

    const response = await h.complete(job.id, job.leaseToken);

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      version: 1,
      job: { id: job.id, status: "succeeded" },
      alreadyCompleted: false,
    });
    const stored = await h.queue.get(job.id);
    expect(stored).toMatchObject({
      status: "succeeded",
      errorCode: null,
      leaseExpiresAt: null,
      finishedAt: new Date(T0.getTime() + 41 * 1000).toISOString(),
      result: goodResult(),
    });
    // Not reserved any more: the lease token no longer works and nothing is handed out again.
    expect((await h.heartbeat(job.id, job.leaseToken)).status).toBe(409);
    expect((await h.claim()).status).toBe(204);
  });

  // CR-28-T08
  it("stores the error code and message of a failed run and fails the job", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    const response = await h.complete(job.id, job.leaseToken, {
      ok: false,
      commentUrl: null,
      errorCode: "llm_auth",
      errorMessage: "The LLM provider refused the key.",
      logTail: "401 from the provider",
      usage: null,
    });

    expect(response.status).toBe(200);
    expect((await response.json()).job.status).toBe("failed");
    const stored = await h.queue.get(job.id);
    expect(stored).toMatchObject({
      status: "failed",
      errorCode: "llm_auth",
      result: {
        ok: false,
        errorCode: "llm_auth",
        errorMessage: "The LLM provider refused the key.",
      },
    });
  });

  it("stores a code it does not know as unknown and keeps the original in the result", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "brand_new_failure",
    });

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "unknown",
      result: { errorCode: "brand_new_failure" },
    });
  });

  // CR-49-T04 (the runs overview that shows the code to a person lives on the UI branch, which has a
  // test that every code of the runner contract has a sentence there)
  it.each(["review_state_truncated", "review_text_truncated"])(
    "stores %s as the code of a failed run and keeps the link to the review that was posted",
    async (errorCode) => {
      const h = await startRunnerApiHarness();
      const job = await claimedJob(h);
      const commentUrl =
        "https://github.com/octo/widgets/pull/7#issuecomment-1";

      const response = await h.complete(job.id, job.leaseToken, {
        ok: false,
        commentUrl,
        errorCode,
        logTail:
          "WARNING Persistent review state did not fit the provider comment limit",
      });

      expect(response.status).toBe(200);
      expect((await response.json()).job.status).toBe("failed");
      expect(await h.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode,
        result: { ok: false, errorCode, commentUrl },
      });
    },
  );

  it("keeps a successful run without a comment link ok", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    const response = await h.complete(job.id, job.leaseToken, {
      commentUrl: null,
    });

    expect(response.status).toBe(200);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "succeeded",
      result: { commentUrl: null },
    });
  });

  it("gives the job back when the runner reports its shutdown, so the job waits for another runner", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h, "runner-a");

    const response = await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "runner_shutdown",
      logTail: "stopped by SIGTERM",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      version: 1,
      job: { id: job.id, status: "queued" },
      alreadyCompleted: false,
    });
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "queued",
      attempts: 1,
      runnerId: null,
      leaseExpiresAt: null,
      result: null,
      errorCode: null,
    });
    const again = await h.claimed({ runnerId: "runner-b" });
    expect(again.job.id).toBe(job.id);
  });

  it("fails the job with runner_shutdown when the shutdown used up the last allowed attempt", async () => {
    const h = await startRunnerApiHarness({ limits: { maxAttempts: 1 } });
    const job = await claimedJob(h);

    const response = await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "runner_shutdown",
    });

    expect((await response.json()).job.status).toBe("failed");
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "runner_shutdown",
    });
  });

  it("refuses a shutdown report from a runner that no longer holds the job", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "runner_shutdown",
    });
    const before = await h.snapshotJobs();

    const repeated = await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "runner_shutdown",
    });

    expect(repeated.status).toBe(409);
    expect((await errorOf(repeated)).code).toBe("RUNNER_LEASE_LOST");
    expect(await h.snapshotJobs()).toStrictEqual(before);
  });

  // CR-28-T16
  it("is refused with 409 for another runner that does not hold the job, and changes nothing", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h, "runner-a");
    const before = await h.snapshotJobs();

    const response = await h.complete(
      job.id,
      crypto.randomUUID(),
      {},
      {
        runnerId: "runner-b",
      },
    );

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("RUNNER_LEASE_LOST");
    expect(await h.snapshotJobs()).toStrictEqual(before);
  });

  // CR-28-T17
  it("answers 404 with a stable code for a job that does not exist", async () => {
    const h = await startRunnerApiHarness();

    const response = await h.complete(UNKNOWN_JOB, "some-lease-token");

    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("RUNNER_JOB_NOT_FOUND");
  });

  // CR-28-T18
  it("refuses a late report of a runner that lost its job to another runner, which keeps it", async () => {
    const h = await startRunnerApiHarness();
    const first = await claimedJob(h, "runner-a");
    h.clock.advance(3 * MINUTE);
    const second = await h.claimed({ runnerId: "runner-b" });

    const late = await h.complete(
      first.id,
      first.leaseToken,
      {},
      {
        runnerId: "runner-a",
      },
    );

    expect(late.status).toBe(409);
    expect((await errorOf(late)).code).toBe("RUNNER_LEASE_LOST");
    expect(await h.queue.get(first.id)).toMatchObject({
      status: "running",
      runnerId: "runner-b",
      result: null,
      attempts: 1,
    });
    const done = await h.complete(
      first.id,
      second.job.leaseToken,
      {},
      {
        runnerId: "runner-b",
      },
    );
    expect(done.status).toBe(200);
  });

  // CR-28-T19
  it("answers 200 again for the same result and stores nothing twice", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    await h.complete(job.id, job.leaseToken);
    const before = await h.snapshotJobs();
    h.clock.advance(MINUTE);

    const repeated = await h.complete(job.id, job.leaseToken);

    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toStrictEqual({
      version: 1,
      job: { id: job.id, status: "succeeded" },
      alreadyCompleted: true,
    });
    expect(await h.snapshotJobs()).toStrictEqual(before);
  });

  it("treats a repetition that leaves out optional fields as the same result", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    const minimal = { ok: true, durationMs: 5, errorCode: null, logTail: "" };
    await h.post("complete", job.id, {
      leaseToken: job.leaseToken,
      result: minimal,
    });

    const repeated = await h.post("complete", job.id, {
      leaseToken: job.leaseToken,
      result: {
        ...minimal,
        commentUrl: null,
        errorMessage: null,
        logTruncated: false,
        usage: null,
      },
    });

    expect(repeated.status).toBe(200);
    expect((await repeated.json()).alreadyCompleted).toBe(true);
  });

  it("answers 409 for another result of a completed job and keeps the first one", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    await h.complete(job.id, job.leaseToken);
    const before = await h.snapshotJobs();

    const conflicting = await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "timeout",
    });

    expect(conflicting.status).toBe(409);
    expect((await errorOf(conflicting)).code).toBe("RUNNER_RESULT_CONFLICT");
    expect(await h.snapshotJobs()).toStrictEqual(before);
  });

  it("does not let a runner whose job the expiry failed overwrite that outcome", async () => {
    const h = await startRunnerApiHarness({ limits: { maxAttempts: 1 } });
    const job = await claimedJob(h);
    h.clock.advance(3 * MINUTE);
    await h.claim({ runnerId: "runner-b" });
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "lease_expired",
    });

    const late = await h.complete(job.id, job.leaseToken);

    expect(late.status).toBe(409);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "lease_expired",
      result: null,
    });
  });
});

describe("bodies that are wrong", () => {
  const BAD_COMPLETE_BODIES: Array<[string, unknown]> = [
    ["a body that is not JSON", "{not json"],
    ["a JSON value that is not an object", "[1, 2]"],
    ["a body without the lease token", { result: goodResult() }],
    ["a lease token that is not text", { leaseToken: 5, result: goodResult() }],
    ["a body without a result", { leaseToken: "lease-token-value" }],
    [
      "a result without the ok flag",
      {
        leaseToken: "lease-token-value",
        result: { durationMs: 5, errorCode: null, logTail: "" },
      },
    ],
    [
      "a failed result without an error code",
      {
        leaseToken: "lease-token-value",
        result: goodResult({ ok: false, errorCode: null }),
      },
    ],
    [
      "a good result with an error code",
      {
        leaseToken: "lease-token-value",
        result: goodResult({ errorCode: "timeout" }),
      },
    ],
    [
      "a duration that is not a whole number",
      {
        leaseToken: "lease-token-value",
        result: goodResult({ durationMs: 1.5 }),
      },
    ],
  ];

  // CR-28-T20
  it.each(BAD_COMPLETE_BODIES)(
    "refuses %s on complete with 400 and stores nothing",
    async (_name, body) => {
      const h = await startRunnerApiHarness();
      const job = await claimedJob(h);
      const before = await h.snapshotJobs();

      const response = await h.post("complete", job.id, body);

      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("RUNNER_REQUEST_INVALID");
      expect(await h.snapshotJobs()).toStrictEqual(before);
    },
  );

  // CR-28-T20
  it.each([
    ["a body that is not JSON", "nope"],
    ["an empty body", ""],
    ["a body without the lease token", {}],
    ["a lease token that is not text", { leaseToken: ["x"] }],
  ])(
    "refuses %s on heartbeat with 400 and changes nothing",
    async (_name, body) => {
      const h = await startRunnerApiHarness();
      const job = await claimedJob(h);
      const before = await h.snapshotJobs();

      const response = await h.post("heartbeat", job.id, body);

      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("RUNNER_REQUEST_INVALID");
      expect(await h.snapshotJobs()).toStrictEqual(before);
    },
  );

  // CR-28-T20
  it("refuses a job id that is not an id with 400, before looking for it", async () => {
    const h = await startRunnerApiHarness();
    await claimedJob(h);
    const before = await h.snapshotJobs();

    for (const id of ["not-an-id", "../../etc", "1", "%20"]) {
      const heartbeat = await h.heartbeat(id, "lease-token-value");
      const complete = await h.complete(id, "lease-token-value");
      expect([heartbeat.status, complete.status]).toStrictEqual([400, 400]);
      expect((await errorOf(heartbeat)).fields).toStrictEqual([
        { field: "jobId", code: "invalid" },
      ]);
    }
    expect(await h.snapshotJobs()).toStrictEqual(before);
  });

  it("names the fields that were refused and never repeats their values", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    const response = await h.post("complete", job.id, {
      leaseToken: "short",
      result: { ok: "yes-please", durationMs: 5, errorCode: null, logTail: "" },
    });

    const text = await response.text();
    expect(JSON.parse(text).error.fields).toStrictEqual([
      { field: "leaseToken", code: "invalid" },
      { field: "result.ok", code: "invalid" },
    ]);
    expect(text).not.toContain("yes-please");
  });
});

describe("bodies that are too large", () => {
  /** A valid complete body of exactly this many bytes, padded with a field the API ignores. */
  function bodyOfBytes(leaseToken: string, bytes: number): string {
    const base = JSON.stringify({ leaseToken, result: goodResult(), pad: "" });
    return JSON.stringify({
      leaseToken,
      result: goodResult(),
      pad: "x".repeat(bytes - base.length),
    });
  }

  // CR-28-T21
  it("refuses a result over 64 KiB with 413 and stores nothing", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    const before = await h.snapshotJobs();

    const response = await h.post(
      "complete",
      job.id,
      bodyOfBytes(job.leaseToken, 64 * 1024 + 1),
    );

    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe("RUNNER_BODY_TOO_LARGE");
    expect(await h.snapshotJobs()).toStrictEqual(before);
  });

  // CR-28-T21
  it("refuses a huge log tail with 413 as well", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    const response = await h.complete(job.id, job.leaseToken, {
      logTail: "x".repeat(200_000),
    });

    expect(response.status).toBe(413);
  });

  it("accepts a body of exactly 64 KiB", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    const body = bodyOfBytes(job.leaseToken, 64 * 1024);
    expect(new TextEncoder().encode(body).length).toBe(64 * 1024);

    const response = await h.post("complete", job.id, body);

    expect(response.status).toBe(200);
  });

  it("refuses a log tail over its own limit as an invalid field, not as a large body", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    const response = await h.complete(job.id, job.leaseToken, {
      logTail: "x".repeat(9000),
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).fields).toStrictEqual([
      { field: "result.logTail", code: "too_long" },
    ]);
  });
});
