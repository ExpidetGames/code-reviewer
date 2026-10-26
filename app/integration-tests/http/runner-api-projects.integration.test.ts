// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how the runner API and the job queue are wired to the projects and the settings (CR-46):
// the claim only hands out jobs of repositories with an active project, deactivating a project
// cancels its waiting jobs, the options of a job are the review settings of its project, and the LLM
// part of a job is the shared LLM configuration. The pieces are the real ones (database, project
// service, review settings service, claim); only GitHub is the fake.
import { describe, expect, it } from "vitest";
import { toRunnerSettings } from "../../src/review-settings/runner-settings.ts";
import { RUNNER_ENV_KEY_PATTERN } from "../../src/runner-api/contract.ts";
import {
  goodResult,
  startRunnerApiHarness,
  TEST_LLM_API_KEY,
  TEST_LLM_MODEL,
} from "../../src/test-support/runner-api-harness.ts";
import {
  createContractValidator,
  readContract,
} from "../../src/test-support/runner-contract.ts";

const contract = createContractValidator();

/** A harness wired like the server, with the project of the first repository switched on. */
async function startWiredHarness(
  options: Parameters<typeof startRunnerApiHarness>[0] = {},
) {
  const h = await startRunnerApiHarness({ projects: true, ...options });
  await h.projectService.activateProject(h.repositoryId);
  return h;
}

describe("a job of a repository without an active project", () => {
  // CR-46-T01
  it("is not handed out and ends cancelled, together with the other waiting jobs of the repository", async () => {
    const h = await startRunnerApiHarness({ projects: true });
    const first = await h.enqueueNew({ prNumber: 7 });
    h.clock.advance(1000);
    const second = await h.enqueueNew({
      prNumber: 8,
      headSha: "b".repeat(40),
    });

    const response = await h.claim();

    expect(response.status).toBe(204);
    for (const job of [first, second])
      expect(await h.queue.get(job.id)).toMatchObject({
        status: "cancelled",
        errorCode: "project_deactivated",
      });
    // Nothing was created for them: no credentials, no call to GitHub.
    expect(h.issuedJobTokens()).toStrictEqual([]);
    expect(h.fake.requests()).toStrictEqual([]);
  });

  // CR-46-T01
  it("does not stop the claim from handing out the job of a repository whose project is active", async () => {
    const h = await startRunnerApiHarness({ projects: true });
    await h.projectService.activateProject(h.otherRepositoryId);
    const off = await h.enqueueNew({ prNumber: 7 });
    h.clock.advance(1000);
    const on = await h.enqueueNew({
      repositoryId: h.otherRepositoryId,
      prNumber: 8,
      prUrl: "https://github.test/acme/gadgets/pull/8",
      headSha: "b".repeat(40),
    });

    const body = await h.claimed();

    expect(body.job.id).toBe(on.id);
    expect(await h.queue.get(off.id)).toMatchObject({
      status: "cancelled",
      errorCode: "project_deactivated",
    });
  });
});

describe("cancelling a claimed job of an inactive project", () => {
  // CR-46-T01
  it("ends the job cancelled, not failed, also on its last allowed attempt, so re-pushing the same commit reviews it", async () => {
    const h = await startRunnerApiHarness({ projects: true });
    const job = await h.enqueueNew();
    await h.db
      .updateTable("jobs")
      .set({ attempts: 2 })
      .where("id", "=", job.id)
      .execute();

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "project_deactivated",
      attempts: 2,
    });
    // The cancelled job does not hold the slot of its head commit: the same push enqueues again.
    await h.projectService.activateProject(h.repositoryId);
    expect((await h.enqueue({ headSha: job.headSha })).status).toBe("created");
  });

  // CR-46-T01
  it("never parks the job in the queue: it goes from running to cancelled without a release", async () => {
    const released: string[] = [];
    const h = await startRunnerApiHarness({
      projects: true,
      wrapQueue: (queue) => ({
        ...queue,
        release: async (...args) => {
          released.push(args[0]);
          return queue.release(...args);
        },
      }),
    });
    const job = await h.enqueueNew();

    await h.claim();

    expect(released).toStrictEqual([]);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "cancelled",
      attempts: 0,
      runAfter: job.runAfter,
    });
  });

  // CR-46-T01
  it("does not cancel a job that was enqueued after the project was switched on again", async () => {
    const h = await startRunnerApiHarness({ projects: true });
    const stale = await h.enqueueNew({ prNumber: 7 });
    await h.claim();
    expect((await h.queue.get(stale.id))?.status).toBe("cancelled");
    await h.projectService.activateProject(h.repositoryId);
    h.clock.advance(1000);
    const fresh = await h.enqueueNew({ prNumber: 8, headSha: "b".repeat(40) });

    const body = await h.claimed();

    expect(body.job.id).toBe(fresh.id);
    expect(await h.queue.get(fresh.id)).toMatchObject({ status: "running" });
  });

  // CR-46-T01
  it("gives the job back at once, not parked, when the cancel itself fails", async () => {
    const h = await startRunnerApiHarness({
      projects: true,
      wrapQueue: (queue) => ({
        ...queue,
        cancelClaimed: async () => {
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
      runAfter: job.runAfter,
    });
    expect(h.logLines().join("\n")).not.toContain("database is locked");
  });
});

describe("switching a project off while jobs wait", () => {
  // CR-46-T02
  it("cancels the waiting jobs of the repository and lets the running one finish", async () => {
    const h = await startWiredHarness();
    await h.projectService.activateProject(h.otherRepositoryId);
    const running = await h.enqueueNew({ prNumber: 7 });
    const { job } = await h.claimed();
    expect(job.id).toBe(running.id);
    const waiting = await h.enqueueNew({
      prNumber: 8,
      headSha: "b".repeat(40),
    });
    const other = await h.enqueueNew({
      repositoryId: h.otherRepositoryId,
      prNumber: 7,
      prUrl: "https://github.test/acme/gadgets/pull/7",
    });

    const result = await h.projectService.deactivateProject(h.repositoryId);

    expect(result.changed).toBe(true);
    expect(await h.queue.get(waiting.id)).toMatchObject({
      status: "cancelled",
      errorCode: "project_deactivated",
    });
    expect(await h.queue.get(running.id)).toMatchObject({ status: "running" });
    expect(await h.queue.get(other.id)).toMatchObject({ status: "queued" });
    // The running job can still report its result.
    const completed = await h.complete(job.id, job.leaseToken);
    expect(completed.status).toBe(200);
    expect(await h.queue.get(running.id)).toMatchObject({
      status: "succeeded",
    });
  });
});

describe("the options of a claimed job", () => {
  // CR-46-T03
  it("are the review settings of the project, the project's value winning over the global one", async () => {
    const h = await startWiredHarness();
    await h.reviewSettings.updateGlobalSettings(
      { maxFindings: 9, largePrChunking: false, inlineKeyIssues: true },
      "alice",
    );
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      maxFindings: 7,
      extraInstructions: "Prefer small functions.",
      model: "vendor/project-model",
    });
    await h.enqueueNew();

    const { job } = await h.claimed();

    const effective = await h.reviewSettings.resolveForRepository(
      h.repositoryId,
    );
    const expected = toRunnerSettings(effective!.settings);
    expect(job.input.env).toStrictEqual(expected.env);
    expect(job.input.llm).toStrictEqual({
      provider: "openrouter",
      model: "vendor/project-model",
      apiKey: TEST_LLM_API_KEY,
      // #689: no setting names the token budget; the claim decides it.
      maxTokens: 100_000,
    });
    // The values the project set, spelled out: the project beats the global default.
    expect(job.input.env).toMatchObject({
      PR_REVIEWER__NUM_MAX_FINDINGS: "7",
      PR_REVIEWER__EXTRA_INSTRUCTIONS: "Prefer small functions.",
      PR_REVIEWER__INLINE_KEY_ISSUES: "true",
    });
    expect(job.input.env).not.toHaveProperty(
      "PR_REVIEWER__ENABLE_LARGE_PR_CHUNKING",
    );
  });

  // CR-46-T04
  it("are the global defaults when the project overrides nothing", async () => {
    const h = await startWiredHarness();
    await h.reviewSettings.updateGlobalSettings({ maxFindings: 9 }, "alice");
    await h.enqueueNew();

    const { job } = await h.claimed();

    expect(job.input.env).toMatchObject({
      PR_REVIEWER__NUM_MAX_FINDINGS: "9",
      PR_REVIEWER__ENABLE_LARGE_PR_CHUNKING: "true",
    });
    expect(job.input.llm).toStrictEqual({
      provider: "openrouter",
      model: TEST_LLM_MODEL,
      apiKey: TEST_LLM_API_KEY,
      maxTokens: 100_000,
    });
  });

  it("follow a change of the settings made after the job was queued", async () => {
    const h = await startWiredHarness();
    await h.enqueueNew();
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      maxFindings: 3,
    });

    const { job } = await h.claimed();

    expect(job.input.env.PR_REVIEWER__NUM_MAX_FINDINGS).toBe("3");
  });

  it("only hold option names the runner accepts and values of the type PR-Agent expects", async () => {
    const h = await startWiredHarness();
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      extraInstructions: "true",
      largePrChunking: true,
      inlineKeyIssues: true,
      maxFindings: 12,
    });
    await h.enqueueNew();

    const { job } = await h.claimed();

    for (const [name, value] of Object.entries(job.input.env)) {
      expect(name).toMatch(RUNNER_ENV_KEY_PATTERN);
      expect(typeof value).toBe("string");
    }
    expect(job.input.env.PR_REVIEWER__NUM_MAX_FINDINGS).toBe("12");
    expect(job.input.env.PR_REVIEWER__ENABLE_LARGE_PR_CHUNKING).toBe("true");
    expect(job.input.env.PR_REVIEWER__INLINE_KEY_ISSUES).toBe("true");
  });

  it("never carry a fallback model, even when the project chose one", async () => {
    const h = await startWiredHarness();
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      fallbackModel: "vendor/fallback-model",
    });
    await h.enqueueNew();

    const { job } = await h.claimed();

    expect(job.input.llm).not.toHaveProperty("fallbackModels");
    expect(JSON.stringify(job.input)).not.toContain("vendor/fallback-model");
  });
});

describe("the LLM access of a claimed job", () => {
  // CR-46-T05
  it("is missing the key: no job is handed out, the job fails with a stable code and the log holds no key", async () => {
    const h = await startWiredHarness({
      llmKey: null,
      env: { LLM_MODEL: "vendor/secret-model-name" },
    });
    const job = await h.enqueueNew();

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(h.issuedJobTokens()).toStrictEqual([]);
    expect(h.logLines().join("\n")).not.toContain(TEST_LLM_API_KEY);
  });

  // CR-46-T06
  // #689-T09
  it("hands out the model of the LLM configuration, and a token budget cut to the context window it names, in a claim that is valid against the contract", async () => {
    const h = await startRunnerApiHarness({
      projects: true,
      env: { LLM_MODEL: "vendor/instance-model" },
      // The review settings are not the point here: no project options.
      jobOptions: { optionsFor: async () => ({ env: {} }) },
    });
    await h.projectService.activateProject(h.repositoryId);
    h.env.LLM_MAX_TOKENS = "32000";
    await h.enqueueNew();

    const body = await h.claimed();

    expect(body.job.input.llm).toStrictEqual({
      provider: "openrouter",
      model: "vendor/instance-model",
      apiKey: TEST_LLM_API_KEY,
      maxTokens: 32_000,
    });
    expect(contract.check("ClaimResponse", body)).toStrictEqual({
      valid: true,
      errors: "",
    });
  });

  // CR-46-T06
  it("hands out a claim with project settings that is valid against the contract", async () => {
    const h = await startWiredHarness();
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      extraInstructions: "Be strict.",
      maxFindings: 4,
    });
    await h.enqueueNew();

    const body = await h.claimed();

    expect(contract.check("ClaimResponse", body)).toStrictEqual({
      valid: true,
      errors: "",
    });
  });

  // CR-46-T07
  it("is masked in the stored log with the key of the claim and with the current key after a rotation", async () => {
    const h = await startWiredHarness();
    await h.enqueueNew();
    const { job } = await h.claimed();
    const rotated = "rotated-llm-api-key-3b7d19e4a0";
    await h.setLlmKey(rotated);

    const response = await h.complete(job.id, job.leaseToken, {
      logTail: `auth with ${TEST_LLM_API_KEY} failed; the new key ${rotated} is set`,
      errorMessage: `bad key ${TEST_LLM_API_KEY}`,
      ok: false,
      errorCode: "llm_auth",
      commentUrl: null,
    });

    expect(response.status).toBe(200);
    const stored = await h.queue.get(job.id);
    const text = JSON.stringify(stored);
    expect(text).not.toContain(TEST_LLM_API_KEY);
    expect(text).not.toContain(rotated);
    expect(text).toContain("[redacted]");
    // A repeated completion is recognised as the same one.
    const repeated = await h.complete(job.id, job.leaseToken, {
      logTail: `auth with ${TEST_LLM_API_KEY} failed; the new key ${rotated} is set`,
      errorMessage: `bad key ${TEST_LLM_API_KEY}`,
      ok: false,
      errorCode: "llm_auth",
      commentUrl: null,
    });
    expect((await repeated.json()).alreadyCompleted).toBe(true);
  });
});

describe("the contract file and the options the app sends", () => {
  // CR-46-T06
  it("accepts every environment variable the review settings can produce", () => {
    const env = toRunnerSettings({
      provider: "openrouter",
      model: "vendor/m",
      fallbackModel: null,
      extraInstructions: "rules",
      maxFindings: 5,
      largePrChunking: true,
      inlineKeyIssues: true,
      autoReviewOnOpen: true,
      autoReviewOnPush: true,
      allowedCommands: ["review"],
      maxCostCents: null,
    }).env;

    expect(Object.keys(env).length).toBeGreaterThan(0);
    expect(contract.check("JobEnv", env)).toStrictEqual({
      valid: true,
      errors: "",
    });
    expect(goodResult().ok).toBe(true);
  });

  // CR-46-T06
  it.each([
    "PR_REVIEWER__A__B",
    "PR_REVIEWER__A_",
    "PR_REVIEWER___A",
    "PR_REVIEWER__",
    "PR_REVIEWER_NUM_MAX_FINDINGS",
    "OPENROUTER__KEY",
    "pr_reviewer__num_max_findings",
  ])("refuses the key %s in the contract and in the app", (key) => {
    expect(RUNNER_ENV_KEY_PATTERN.test(key)).toBe(false);
    expect(contract.check("JobEnv", { [key]: "x" }).valid).toBe(false);
  });

  it.each(["PR_REVIEWER__NUM_MAX_FINDINGS", "PR_REVIEWER__EXTRA_INSTRUCTIONS"])(
    "accepts the key %s in the contract and in the app",
    (key) => {
      expect(RUNNER_ENV_KEY_PATTERN.test(key)).toBe(true);
      expect(contract.check("JobEnv", { [key]: "x" }).valid).toBe(true);
    },
  );

  // #203 v1 compatibility: the removed tools' option families are still accepted (and ignored).
  it.each([
    "PR_QUESTIONS__EXTRA_INSTRUCTIONS",
    "PR_DESCRIPTION__ADD_ORIGINAL_USER_DESCRIPTION",
    "PR_CODE_SUGGESTIONS__NUM_CODE_SUGGESTIONS",
  ])("accepts the legacy key %s in the contract and in the app", (key) => {
    expect(RUNNER_ENV_KEY_PATTERN.test(key)).toBe(true);
    expect(contract.check("JobEnv", { [key]: "x" }).valid).toBe(true);
  });

  // CR-46-T06
  it("describes the optional llm fields the runner accepts", () => {
    const input = readContract().$defs.RunnerJobInput as unknown as {
      properties: { llm: { properties: Record<string, unknown> } };
    };

    expect(Object.keys(input.properties.llm.properties).sort()).toStrictEqual([
      "apiKey",
      "baseUrl",
      "fallbackModels",
      "maxCostUsd",
      "maxTokens",
      "model",
      "operatorMaxCostUsd",
      "provider",
    ]);
  });
});
