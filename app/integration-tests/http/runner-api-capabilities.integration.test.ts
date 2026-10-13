// SPDX-License-Identifier: Apache-2.0

// #195: routing a queued job to a runner that can run it. A runner advertises the engines it can run
// in the claim body; the claim only hands it a job whose review kind one of those engines can run. An
// ineligible job stays queued without an attempt being counted and without a credential being
// created, and no capable runner is a waiting state, never a failed review. The real SQLite queue, the
// real claim and the real job-options source are used; only GitHub is the fake.
import { describe, expect, it } from "vitest";
import {
  startRunnerApiHarness,
  TEST_LLM_API_KEY,
  TEST_RUNNER_TOKEN,
} from "../../src/test-support/runner-api-harness.ts";
import { createContractValidator } from "../../src/test-support/runner-contract.ts";
import { sha } from "../../src/test-support/jobs.ts";

const contract = createContractValidator();

/** A harness wired like the server: the first repository has an active project and runs Dynamic. */
async function startDynamicHarness() {
  const h = await startRunnerApiHarness({ projects: true });
  await h.projectService.activateProject(h.repositoryId);
  await h.reviewSettings.updateProjectSettings(h.repositoryId, {
    reviewKind: "dynamic",
    dynamicModel: "vendor/dynamic-model",
  });
  return h;
}

function expectValid(definition: string, document: unknown) {
  const { valid, errors } = contract.check(definition, document);
  expect({ valid, errors }).toStrictEqual({ valid: true, errors: "" });
}

describe("routing a claimed job by the runner's engines", () => {
  // #195-T01
  it("gives a PR-Agent-only runner the oldest Diff job and leaves a Dynamic job queued", async () => {
    const h = await startDynamicHarness();
    // A Dynamic job of PR 8, older than the Diff job of PR 7. Different pull requests, so per-PR
    // serialization does not hide the routing decision.
    const dynamic = await h.enqueueNew({
      prNumber: 8,
      prUrl: "https://github.test/acme/widgets/pull/8",
      headSha: "b".repeat(40),
      reviewKind: "dynamic",
    });
    h.clock.advance(1000);
    const diff = await h.enqueueNew({ prNumber: 7, reviewKind: "diff" });

    const response = await h.claim({ engines: ["pr-agent"] });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.job.id).toBe(diff.id);
    // The exact legacy Diff payload: no tagged Dynamic fields reach a legacy runner.
    expect(body.job.input).not.toHaveProperty("reviewKind");
    expect(body.job.input).not.toHaveProperty("dynamic");
    expect(body.job.input).not.toHaveProperty("base");
    expectValid("ClaimResponse", body);

    // #195 finding 8: byte-identical to the previous release's serialization — the same keys, in the
    // same order (input, git and llm), for the same values.
    const input = body.job.input;
    expect(Object.keys(input)).toStrictEqual([
      "prUrl",
      "command",
      "git",
      "llm",
      "env",
    ]);
    expect(Object.keys(input.git)).toStrictEqual([
      "provider",
      "baseUrl",
      "token",
      "botLogin",
    ]);
    expect(Object.keys(input.llm)).toStrictEqual([
      "provider",
      "model",
      "apiKey",
      ...(input.llm.maxTokens === undefined ? [] : ["maxTokens"]),
    ]);
    expect(JSON.stringify(input)).toBe(
      JSON.stringify({
        prUrl: input.prUrl,
        command: "review",
        git: {
          provider: "github",
          baseUrl: input.git.baseUrl,
          token: input.git.token,
          botLogin: input.git.botLogin,
        },
        llm: {
          provider: "openrouter",
          model: input.llm.model,
          apiKey: input.llm.apiKey,
          ...(input.llm.maxTokens === undefined
            ? {}
            : { maxTokens: input.llm.maxTokens }),
        },
        env: input.env,
      }),
    );

    // The Dynamic job keeps waiting, with no attempt counted and no credential created for it.
    expect(await h.queue.get(dynamic.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      errorCode: null,
    });
    expect(h.issuedJobTokens()).toHaveLength(1);
  });

  // #195-T01
  it("hands the tagged Dynamic job, with model, skill and limits, to a dual-capable runner", async () => {
    const h = await startDynamicHarness();
    const dynamic = await h.enqueueNew({ prNumber: 8, reviewKind: "dynamic" });

    const response = await h.claim({ engines: ["pr-agent", "opencode"] });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.job.id).toBe(dynamic.id);
    expect(body.job.input.reviewKind).toBe("dynamic");
    expect(body.job.input.dynamic).toMatchObject({
      model: "vendor/dynamic-model",
      limits: { maxFindings: expect.any(Number) },
    });
    expect(typeof body.job.input.dynamic.skill).toBe("string");
    expect(body.job.input.base).toMatchObject({
      repository: h.repository.fullName,
      baseRef: "main",
      headSha: dynamic.headSha,
      previousReviewedSha: null,
      comparison: "full",
    });
    // No PR-Agent environment options leak into the Dynamic job.
    expect(body.job.input.env).toStrictEqual({});
    expectValid("ClaimResponse", body);
  });

  // #195-T01: no capable runner is a waiting state, not a failed review.
  it("answers 204 and leaves a Dynamic job waiting when no runner can run it", async () => {
    const h = await startDynamicHarness();
    const dynamic = await h.enqueueNew({ prNumber: 8, reviewKind: "dynamic" });

    const response = await h.claim({ engines: ["pr-agent"] });

    expect(response.status).toBe(204);
    expect(await h.queue.get(dynamic.id)).toMatchObject({
      status: "queued",
      attempts: 0,
    });
    expect(h.issuedJobTokens()).toStrictEqual([]);
  });

  // #195-T02
  it("does not starve an eligible job behind an ineligible one, and never gives one job twice", async () => {
    const h = await startDynamicHarness();
    // The oldest job is Dynamic; the Diff job behind it is eligible for a PR-Agent-only runner.
    const dynamic = await h.enqueueNew({
      prNumber: 8,
      prUrl: "https://github.test/acme/widgets/pull/8",
      headSha: "b".repeat(40),
      reviewKind: "dynamic",
    });
    h.clock.advance(1000);
    const diff = await h.enqueueNew({ prNumber: 7, reviewKind: "diff" });

    const [first, second] = await Promise.all([
      h.claim({ engines: ["pr-agent"], runnerId: "runner-a" }),
      h.claim({ engines: ["pr-agent"], runnerId: "runner-b" }),
    ]);
    const holders = [first, second].filter(
      (response) => response.status === 200,
    );
    expect(holders).toHaveLength(1);
    expect((await holders[0]!.json()).job.id).toBe(diff.id);

    // The one holder owns the Diff job; the Dynamic job is untouched.
    expect(await h.queue.get(dynamic.id)).toMatchObject({
      status: "queued",
      attempts: 0,
    });
  });

  // #195-T02, #195 finding 9
  it("routes two kinds in two projects to the right capabilities without a duplicate", async () => {
    const h = await startDynamicHarness();
    await h.projectService.activateProject(h.otherRepositoryId);
    const dynamic = await h.enqueueNew({ prNumber: 7, reviewKind: "dynamic" });
    h.clock.advance(1000);
    const diff = await h.enqueueNew({
      repositoryId: h.otherRepositoryId,
      prNumber: 8,
      prUrl: "https://github.test/acme/gadgets/pull/8",
      headSha: sha("c"),
      reviewKind: "diff",
    });

    const prAgent = await h.claim({
      engines: ["pr-agent"],
      runnerId: "runner-a",
    });
    const dual = await h.claim({
      engines: ["pr-agent", "opencode"],
      runnerId: "runner-b",
    });
    const prAgentBody = await prAgent.json();
    const dualBody = await dual.json();

    expect(prAgentBody.job.id).toBe(diff.id);
    expect(dualBody.job.id).toBe(dynamic.id);
    expect(prAgentBody.job.input).not.toHaveProperty("reviewKind");
    expect(dualBody.job.input.reviewKind).toBe("dynamic");
  });

  // #195-T02, #195 finding 9
  it("keeps one holder per pull request when two capabilities race over two kinds of one PR", async () => {
    const h = await startDynamicHarness();
    await h.projectService.activateProject(h.otherRepositoryId);
    await h.enqueueNew({ prNumber: 7, reviewKind: "dynamic" });
    h.clock.advance(1000);
    await h.enqueueNew({
      prNumber: 7,
      headSha: sha("b"),
      reviewKind: "diff",
    });
    h.clock.advance(1000);
    await h.enqueueNew({
      repositoryId: h.otherRepositoryId,
      prNumber: 8,
      prUrl: "https://github.test/acme/gadgets/pull/8",
      headSha: sha("c"),
      reviewKind: "diff",
    });

    const [a, b] = await Promise.all([
      h.claim({ engines: ["pr-agent"], runnerId: "runner-a" }),
      h.claim({ engines: ["pr-agent", "opencode"], runnerId: "runner-b" }),
    ]);
    const holders = [a, b].filter((response) => response.status === 200);
    const ids = await Promise.all(
      holders.map(async (response) => (await response.json()).job.id),
    );
    // No job was handed out twice.
    expect(new Set(ids).size).toBe(ids.length);

    // At most one job of pull request 7 runs, whatever the two capabilities did.
    const runningForPr7 = await h.db
      .selectFrom("jobs")
      .select("id")
      .where("repository_id", "=", h.repositoryId)
      .where("pr_number", "=", 7)
      .where("status", "=", "running")
      .execute();
    expect(runningForPr7.length).toBeLessThanOrEqual(1);
  });

  // #195-T05
  it("refuses a wrong token, an invalid engine list and an oversized body before any credential", async () => {
    const h = await startDynamicHarness();
    const diff = await h.enqueueNew({ prNumber: 7, reviewKind: "diff" });
    const rawClaim = (body: string | undefined) =>
      h.api.claim(
        new Request("https://app.test/api/runners/v1/claim", {
          method: "POST",
          headers: {
            authorization: `Bearer ${TEST_RUNNER_TOKEN}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body }),
        }),
      );

    const cases = [
      [401, await h.claim({ token: "wrong", engines: ["pr-agent"] })],
      [400, await h.claim({ engines: ["pr-agent", "pr-agent"] })],
      [400, await h.claim({ engines: ["gitlab"] })],
      [400, await h.claim({ engines: [] })],
      [400, await rawClaim(JSON.stringify({ engines: "pr-agent" }))],
      [400, await rawClaim("{")],
      [
        413,
        await rawClaim(
          JSON.stringify({
            engines: ["pr-agent"],
            padding: "x".repeat(70 * 1024),
          }),
        ),
      ],
    ] as const;

    const bodies: unknown[] = [];
    for (const [status, response] of cases) {
      expect(response.status).toBe(status);
      if (status !== 413) bodies.push(await response.json());
    }
    // Nothing was claimed and no credential was created by any refusal.
    expect(await h.queue.get(diff.id)).toMatchObject({
      status: "queued",
      attempts: 0,
    });
    expect(h.issuedJobTokens()).toStrictEqual([]);
    // No answer and no log line carries the runner token or a claimed credential.
    expect(JSON.stringify(bodies)).not.toContain(TEST_RUNNER_TOKEN);
    expect(JSON.stringify(bodies)).not.toContain(TEST_LLM_API_KEY);
    expect(h.logLines().join("\n")).not.toContain(TEST_RUNNER_TOKEN);
    expect(h.logLines().join("\n")).not.toContain(TEST_LLM_API_KEY);
  });
});
