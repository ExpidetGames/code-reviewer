// SPDX-License-Identifier: Apache-2.0

// Pins down `POST /api/runners/v1/claim` through the real handler: a real SQLite file with the job
// queue, the real GitHub App provider against the fake GitHub, and the API wired to both. It covers
// what a runner is handed and when (credentials only at claim time, one token per claim, the guard,
// the settings), and what happens to a job when credentials cannot be made. The answers to heartbeat
// and complete are in runner-api-report.integration.test.ts, the checks on the token in
// runner-api-security.integration.test.ts.
import { describe, expect, it } from "vitest";
import {
  startRunnerApiHarness,
  TEST_LLM_API_KEY,
  TEST_LLM_MODEL,
} from "../../src/test-support/runner-api-harness.ts";
import { T0 } from "../../src/test-support/jobs.ts";
import { TEST_APP_SLUG } from "../../src/test-support/github-app.ts";

const MINUTE = 60 * 1000;

describe("claiming a job", () => {
  // CR-28-T04
  it("hands the oldest waiting job to the runner and reserves it in the database", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();

    const response = await h.claim();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.version).toBe(1);
    expect(body.job.id).toBe(job.id);
    const stored = await h.queue.get(job.id);
    expect(stored).toMatchObject({
      status: "running",
      runnerId: "runner-a",
      claimedAt: T0.toISOString(),
      leaseExpiresAt: new Date(T0.getTime() + 2 * MINUTE).toISOString(),
    });
    expect(body.job.leaseToken).toBe(await h.tokenOf(job.id));
    expect(body.job.leaseExpiresAt).toBe(stored?.leaseExpiresAt);
    expect(body.job.heartbeatIntervalSeconds).toBe(30);
  });

  // CR-28-T01
  it("hands out the pull request, the command, the git access with the real token, the LLM access and the options", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();

    const body = await h.claimed();

    const [token, ...others] = h.issuedJobTokens();
    expect(others).toStrictEqual([]);
    expect(token).toMatch(/^ghs_fake/);
    expect(body.job.input).toStrictEqual({
      prUrl: `https://github.test/${h.repository.fullName}/pull/7`,
      command: "review",
      git: {
        provider: "github",
        baseUrl: h.fake.baseUrl,
        token,
        botLogin: `${TEST_APP_SLUG}[bot]`,
      },
      llm: {
        provider: "openrouter",
        model: TEST_LLM_MODEL,
        apiKey: TEST_LLM_API_KEY,
      },
      env: {},
    });
    expect(body.job.input.git.token).toBe(token);
    expect(body.job.tokenExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("limits the token to the repository of the job and to the permissions a review needs", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();

    await h.claimed();

    const jobTokenRequests = h.fake
      .tokenRequests()
      .filter((request) => request.repositoryIds !== null);
    expect(jobTokenRequests).toStrictEqual([
      {
        installationId: 4242,
        repositories: null,
        repositoryIds: [Number(h.repository.externalId)],
        permissions: {
          pull_requests: "write",
          issues: "write",
          contents: "read",
          metadata: "read",
        },
      },
    ]);
  });

  it("takes the pull request URL from the platform, not from the stored job", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew({
      prUrl: "https://github.test/stale/elsewhere/pull/7",
    });

    const body = await h.claimed();

    expect(body.job.input.prUrl).toBe(
      `https://github.test/${h.repository.fullName}/pull/7`,
    );
  });

  // #203-T13
  it("hands a review job the review command and no arguments, whatever text the comment had", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew({
      args: 'please be nice"; rm -rf / #$(id)\n/review --a=b',
    });

    const body = await h.claimed();

    expect(body.job.input.command).toBe("review");
    expect(body.job.input).not.toHaveProperty("args");
  });

  it("hands the options of the source for job options to the runner", async () => {
    const h = await startRunnerApiHarness({
      jobOptions: {
        optionsFor: async () => ({
          env: { PR_REVIEWER__EXTRA_INSTRUCTIONS: "Be kind." },
        }),
      },
    });
    await h.enqueueNew();

    const body = await h.claimed();

    expect(body.job.input.env).toStrictEqual({
      PR_REVIEWER__EXTRA_INSTRUCTIONS: "Be kind.",
    });
  });

  it("asks the source for the options of each job, so the model and the context size can differ per repository", async () => {
    const h = await startRunnerApiHarness({
      jobOptions: {
        optionsFor: async (job) =>
          job.prNumber === 7
            ? {
                env: {},
                llm: {
                  model: "vendor/model-one",
                  maxTokens: 64000,
                  fallbackModels: ["vendor/fallback"],
                },
              }
            : { env: {}, llm: { model: "vendor/model-two", maxTokens: null } },
      },
    });
    await h.enqueueNew({ prNumber: 7 });
    h.clock.advance(1000);
    await h.enqueueNew({ prNumber: 8, headSha: "b".repeat(40) });

    const first = await h.claimed();
    const second = await h.claimed();

    expect(first.job.input.llm).toStrictEqual({
      provider: "openrouter",
      model: "vendor/model-one",
      apiKey: TEST_LLM_API_KEY,
      maxTokens: 64000,
    });
    // A null is left out: the runner refuses a maxTokens that is not a whole number.
    expect(second.job.input.llm).toStrictEqual({
      provider: "openrouter",
      model: "vendor/model-two",
      apiKey: TEST_LLM_API_KEY,
    });
  });

  it("keeps the model of the LLM access when the options name none", async () => {
    const h = await startRunnerApiHarness({
      jobOptions: {
        optionsFor: async () => ({ env: {}, llm: { model: null } }),
      },
    });
    await h.enqueueNew();

    const body = await h.claimed();

    expect(body.job.input.llm).toStrictEqual({
      provider: "openrouter",
      model: TEST_LLM_MODEL,
      apiKey: TEST_LLM_API_KEY,
    });
  });

  it("uses the default model when LLM_MODEL is not set", async () => {
    const h = await startRunnerApiHarness({ env: { LLM_MODEL: undefined } });
    await h.enqueueNew();

    const body = await h.claimed();

    expect(body.job.input.llm.model).toBe("anthropic/claude-haiku-5.5");
  });

  it("hands each job to one runner only", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();

    const first = await h.claim({ runnerId: "runner-a" });
    const second = await h.claim({ runnerId: "runner-b" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(204);
  });

  it("works without an X-Runner-Id header and records a fixed name", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();

    const response = await h.claim({ runnerId: null });

    expect(response.status).toBe(200);
    expect((await h.queue.get(job.id))?.runnerId).toBe("unknown");
  });

  it("refuses an X-Runner-Id that is not a plain id before it touches a job", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();
    const before = await h.snapshotJobs();

    const response = await h.claim({ runnerId: "runner one\n" });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("RUNNER_ID_INVALID");
    expect(await h.snapshotJobs()).toStrictEqual(before);
  });

  // CR-28-T05
  it("answers 204 without a body when no job is due", async () => {
    const h = await startRunnerApiHarness();

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("does not hand out a job before its run-after time", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew({ runAfter: new Date(T0.getTime() + 90 * 1000) });

    expect((await h.claim()).status).toBe(204);
    h.clock.advance(90 * 1000);
    expect((await h.claim()).status).toBe(200);
  });

  it("marks every answer as not cacheable", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();
    const job = await h.claim();
    const none = await h.claim();
    const unauthorized = await h.claim({ token: "wrong" });

    for (const response of [job, none, unauthorized])
      expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("when the credentials are created", () => {
  // CR-28-T13
  it("makes no request to GitHub and stores no token before the claim, and exactly one job token at the claim", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();

    expect(h.fake.requests()).toStrictEqual([]);
    expect(h.fake.tokenRequests()).toStrictEqual([]);
    expect(JSON.stringify(await h.snapshotJobs())).not.toMatch(/ghs_/);

    await h.claimed();

    expect(h.issuedJobTokens()).toHaveLength(1);
    expect(JSON.stringify(await h.snapshotJobs())).not.toContain(
      h.issuedJobTokens()[0],
    );
  });

  it("creates a new token for every claim", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();
    await h.enqueueNew({ prNumber: 8, headSha: "b".repeat(40) });

    const first = await h.claimed();
    const second = await h.claimed();

    expect(first.job.input.git.token).not.toBe(second.job.input.git.token);
    expect(h.issuedJobTokens()).toHaveLength(2);
  });
});

describe("a job that cannot be handed out", () => {
  it("fails the job with llm_not_configured and creates no credentials when the LLM key is missing", async () => {
    const h = await startRunnerApiHarness({ llmKey: null });
    const job = await h.enqueueNew();

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(h.fake.requests()).toStrictEqual([]);
  });

  it("goes on to the next job when the guard refuses one, and fails the refused one with the guard's code", async () => {
    const h = await startRunnerApiHarness({
      guard: {
        check: async (job) =>
          job.prNumber === 7
            ? { allow: false, errorCode: "project_deactivated" }
            : { allow: true },
      },
    });
    const refused = await h.enqueueNew({ prNumber: 7 });
    h.clock.advance(1000);
    const allowed = await h.enqueueNew({
      prNumber: 8,
      headSha: "b".repeat(40),
    });

    const body = await h.claimed();

    expect(body.job.id).toBe(allowed.id);
    expect(await h.queue.get(refused.id)).toMatchObject({
      status: "failed",
      errorCode: "project_deactivated",
    });
    // No credentials were created for the refused job.
    expect(h.issuedJobTokens()).toHaveLength(1);
  });

  it("asks the guard before anything else is done for a job", async () => {
    const asked: string[] = [];
    const h = await startRunnerApiHarness({
      guard: {
        check: async (job) => {
          asked.push(job.id);
          return { allow: true };
        },
      },
    });
    const job = await h.enqueueNew();

    await h.claimed();

    expect(asked).toStrictEqual([job.id]);
  });

  it("gives the job back and answers 500 without details when the guard itself fails", async () => {
    const h = await startRunnerApiHarness({
      guard: {
        check: async () => {
          throw new Error("secret detail of the failure");
        },
      },
    });
    const job = await h.enqueueNew();

    const response = await h.claim();

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe("RUNNER_INTERNAL_ERROR");
    expect(text).not.toContain("secret detail");
    expect(h.logLines().join("\n")).not.toContain("secret detail");
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "queued",
      attempts: 1,
      runnerId: null,
    });
  });

  it("fails a job whose pull request is closed or merged, without creating job credentials", async () => {
    const h = await startRunnerApiHarness();
    const closed = await h.enqueueNew({ prNumber: 9 });
    const merged = await h.enqueueNew({
      prNumber: 10,
      headSha: "b".repeat(40),
    });

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await h.queue.get(closed.id)).toMatchObject({
      status: "failed",
      errorCode: "pull_request_closed",
    });
    expect(await h.queue.get(merged.id)).toMatchObject({
      status: "failed",
      errorCode: "pull_request_closed",
    });
    expect(h.issuedJobTokens()).toStrictEqual([]);
  });

  it("fails a job whose pull request does not exist", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew({ prNumber: 99 });

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "pr_not_found",
    });
  });

  it("fails a job when the app is not granted what a review needs, without trying a broader token", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    h.fake.setAppPermissions({
      metadata: "read",
      contents: "read",
      pull_requests: "read",
    });

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "git_scope_refused",
    });
    expect(h.issuedJobTokens()).toStrictEqual([]);
  });

  it("fails a job whose integration is switched off", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    await h.db
      .updateTable("integrations")
      .set({ status: "disabled" })
      .execute();

    await h.claim();

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "git_connection_disabled",
    });
  });

  // #103-IB-14
  it("fails a job whose integration was disconnected by its workspace, and creates no credential for it", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    await h.db
      .updateTable("integrations")
      .set({ status: "disconnected" })
      .execute();

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "git_connection_disabled",
    });
    expect(h.issuedJobTokens()).toStrictEqual([]);
  });

  // #203-T10
  it("cancels a waiting job of a removed command at claim, so no runner is handed it", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.seedHistoricalJob({
      command: "ask",
      status: "queued",
      args: "why?",
    });

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "command_removed",
    });
    expect(h.issuedJobTokens()).toStrictEqual([]);
  });

  it.each([
    ["a context size that is not a whole number", { maxTokens: 1.5 }],
    ["a context size below the minimum", { maxTokens: 10 }],
    ["a model name the runner refuses", { model: "bad model name" }],
  ])(
    "fails a job whose options hold %s, without creating job credentials",
    async (_name, llm) => {
      const h = await startRunnerApiHarness({
        jobOptions: { optionsFor: async () => ({ env: {}, llm }) },
      });
      const job = await h.enqueueNew();

      await h.claim();

      expect(await h.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: "job_llm_options_invalid",
      });
      expect(h.issuedJobTokens()).toStrictEqual([]);
    },
  );

  it("gives the job back and answers 500 when it cannot be ended after the guard refused it", async () => {
    const h = await startRunnerApiHarness({
      guard: {
        check: async () => ({ allow: false, errorCode: "project_deactivated" }),
      },
      wrapQueue: (queue) => ({
        ...queue,
        complete: async () => {
          throw new Error("database is locked");
        },
      }),
    });
    const job = await h.enqueueNew();

    const response = await h.claim();

    expect(response.status).toBe(500);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "queued",
      attempts: 1,
      runnerId: null,
    });
    expect(h.logLines().join("\n")).not.toContain("database is locked");
  });

  it("trims a key with white space around it before it is handed out", async () => {
    const h = await startRunnerApiHarness({
      llmKey: ` ${TEST_LLM_API_KEY}\n`,
    });
    await h.enqueueNew();

    const body = await h.claimed();

    expect(body.job.input.llm.apiKey).toBe(TEST_LLM_API_KEY);
  });

  it("fails a job whose options are not options of the four tools", async () => {
    const h = await startRunnerApiHarness({
      jobOptions: { optionsFor: async () => ({ env: { OPENAI__KEY: "x" } }) },
    });
    const job = await h.enqueueNew();

    await h.claim();

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "job_env_invalid",
    });
    expect(h.issuedJobTokens()).toStrictEqual([]);
  });
});

describe("when GitHub cannot create the token", () => {
  /** Claims and completes a first job, so that the read token of the client is cached. */
  async function warmUp(h: Awaited<ReturnType<typeof startRunnerApiHarness>>) {
    const first = await h.enqueueNew({ prNumber: 7 });
    const claimed = await h.claimed();
    await h.complete(first.id, claimed.job.leaseToken);
  }

  // CR-28-T22
  it("answers 503 with Retry-After and a stable code, and keeps the job waiting with one attempt counted", async () => {
    const h = await startRunnerApiHarness();
    await warmUp(h);
    const job = await h.enqueueNew({ prNumber: 8, headSha: "b".repeat(40) });
    h.fake.fail({ pathIncludes: "/access_tokens", status: 503, times: 1 });

    const response = await h.claim();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toStrictEqual({
      error: {
        code: "RUNNER_GIT_ACCESS_UNAVAILABLE",
        message:
          "Credentials for the job could not be created right now. Try again later.",
        retryAfterSeconds: 30,
      },
    });
    const stored = await h.queue.get(job.id);
    expect(stored).toMatchObject({
      status: "queued",
      attempts: 1,
      runnerId: null,
      leaseExpiresAt: null,
      runAfter: new Date(T0.getTime() + 30 * 1000).toISOString(),
    });
  });

  it("hands the job out once the retry time has come and GitHub works again", async () => {
    const h = await startRunnerApiHarness();
    await warmUp(h);
    const job = await h.enqueueNew({ prNumber: 8, headSha: "b".repeat(40) });
    h.fake.fail({ pathIncludes: "/access_tokens", status: 503, times: 1 });
    await h.claim();

    expect((await h.claim()).status).toBe(204);
    h.clock.advance(30 * 1000);
    const retry = await h.claim();

    expect(retry.status).toBe(200);
    expect((await retry.json()).job.id).toBe(job.id);
  });

  it("uses the wait time GitHub names for a rate limit", async () => {
    const h = await startRunnerApiHarness();
    await warmUp(h);
    const job = await h.enqueueNew({ prNumber: 8, headSha: "b".repeat(40) });
    h.fake.fail({
      pathIncludes: "/access_tokens",
      status: 429,
      headers: { "retry-after": "120" },
      times: 1,
    });

    const response = await h.claim();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("120");
    expect((await h.queue.get(job.id))?.runAfter).toBe(
      new Date(T0.getTime() + 120 * 1000).toISOString(),
    );
  });

  it("fails the job after the last allowed attempt instead of retrying for ever", async () => {
    const h = await startRunnerApiHarness();
    await warmUp(h);
    const job = await h.enqueueNew({ prNumber: 8, headSha: "b".repeat(40) });
    h.fake.fail({ pathIncludes: "/access_tokens", status: 503 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await h.claim()).status).toBe(503);
      h.clock.advance(60 * 1000);
    }

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "git_access_unavailable",
    });
    expect((await h.claim()).status).toBe(204);
  });

  it("also gives the job back when the pull request cannot be read because GitHub is down", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    h.fake.fail({ pathIncludes: "/access_tokens", status: 503, times: 1 });

    const response = await h.claim();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "queued",
      attempts: 1,
    });
  });
});
