// SPDX-License-Identifier: Apache-2.0

// Everything a test of the runner API needs: a real SQLite file with the job queue and one
// integration (installation 4242, repositories acme/widgets and acme/gadgets), the fake GitHub behind
// the real GitHub App provider, and the API itself wired to all of them. `claim`, `heartbeat` and
// `complete` build requests like the runner does. The clock of the queue is the one in `clock`.
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createDefaultIntegrationRegistry } from "../integrations/registry.ts";
import type { JobQueueLimits } from "../jobs/job-limits.ts";
import { createWorkspaceLlm } from "../llm/assemble.ts";
import { createRunnerApi } from "../runner-api/api.ts";
import {
  allowAllClaimGuard,
  type ClaimGuard,
} from "../runner-api/claim-guard.ts";
import type { ClaimResponse, RunnerResult } from "../runner-api/contract.ts";
import {
  emptyJobOptionsSource,
  type JobOptionsSource,
} from "../runner-api/job-options.ts";
import { createClaimedKeys } from "../runner-api/claimed-keys.ts";
import { createProjectClaimGuard } from "../runner-api/project-claim-guard.ts";
import { knownSecretsFromEnv } from "../runner-api/redact.ts";
import { createReviewSettingsJobOptionsSource } from "../runner-api/review-settings-job-options.ts";
import { configuredRunnerToken } from "../runner-api/token-auth.ts";
import type { RunnerApiLogger } from "../runner-api/logger.ts";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createJobProjectHooks } from "../jobs/project-hooks.ts";
import { createProjectService } from "../projects/service.ts";
import { createReviewSettingsService } from "../review-settings/service.ts";
import { builtInReviewSettings } from "../review-settings/settings.ts";
import { startGithubAppHarness } from "./github-app-harness.ts";
import { createJobQueueFixture, sha, type TestQueue } from "./jobs.ts";

export const TEST_RUNNER_TOKEN = "test-runner-token-4f9c2a7e1b-0d58a3c6e9f2";
export const TEST_LLM_API_KEY = "test-llm-api-key-8d3b6e0a5c";
export const TEST_LLM_MODEL = "vendor/test-model";
export const TEST_APP_SECRET = "runner-api-test-app-secret-0123456789-0123";

export type RequestOptions = {
  /** Sent as `Authorization: Bearer <token>`. Default: the right token. `null` sends no header. */
  token?: string | null;
  /** The whole header value, for another scheme or an empty `Bearer`. Wins over `token`. */
  authorization?: string | null;
  /** `X-Runner-Id`. Default `runner-a`. `null` leaves the header out. */
  runnerId?: string | null;
};

export async function startRunnerApiHarness(
  options: {
    guard?: ClaimGuard;
    jobOptions?: JobOptionsSource;
    /**
     * Wires the guard and the job options like the running server does: a job runs only while its
     * repository has an active project, and its options are the review settings. Explicit `guard` and
     * `jobOptions` win. Without this, every job may run and has no extra options.
     */
    projects?: boolean;
    /** Wraps the job queue the API uses, for example to make one call fail. */
    wrapQueue?: (queue: TestQueue) => TestQueue;
    limits?: Partial<JobQueueLimits>;
    /** Replaces or (with undefined) removes variables of the app's environment. */
    env?: Record<string, string | undefined>;
    /**
     * The LLM key of the workspace the jobs belong to, as an Owner or an Admin saved it (the key service of
     * the workspace). Default: `TEST_LLM_API_KEY`. `null`: the workspace has none.
     */
    llmKey?: string | null;
  } = {},
) {
  const fixture = await createJobQueueFixture(
    options.limits === undefined ? {} : { limits: options.limits },
  );
  const github = await startGithubAppHarness();
  github.fake.addInstallation({
    id: 4242,
    account: { login: "acme", id: 5001, type: "Organization" },
  });
  github.fake.setRepositories(4242, [
    { id: 7001, fullName: "acme/widgets" },
    { id: 7002, fullName: "acme/gadgets" },
  ]);
  const pullRequests = [
    { number: 7, state: "open", headSha: sha("a") },
    { number: 8, state: "open", headSha: sha("b") },
    { number: 9, state: "closed", headSha: sha("c") },
    { number: 10, state: "closed", merged: true, headSha: sha("d") },
  ] as const;
  for (const repository of ["acme/widgets", "acme/gadgets"])
    for (const pullRequest of pullRequests)
      github.fake.addPullRequest(repository, {
        title: `Change ${pullRequest.number}`,
        headRef: `feature/change-${pullRequest.number}`,
        baseRef: "main",
        author: { login: "alice", id: 1001 },
        ...pullRequest,
      });
  const repository = await createRepositoriesRepository(
    fixture.db,
    fixture.workspaceId,
    fixture.clock.now,
  ).get(fixture.repositoryId);
  if (repository === undefined)
    throw new Error("The fixture repository is missing.");

  /** The tokens GitHub created for jobs: the requests that named a repository. */
  function issuedJobTokens(): string[] {
    const requests = github.fake.tokenRequests();
    return github.fake
      .issuedInstallationTokens()
      .filter((_, index) => requests[index]?.repositoryIds != null);
  }

  /** The app's environment as the runner API reads it; change it to change the settings. */
  const env: Record<string, string | undefined> = {
    RUNNER_TOKEN: TEST_RUNNER_TOKEN,
    LLM_MODEL: TEST_LLM_MODEL,
    ...options.env,
  };

  const registry = createDefaultIntegrationRegistry({
    env: github.env,
    githubClient: { now: github.clock.now, requestTimeoutMs: 5000 },
  });
  const infoLines: string[] = [];
  const errorLines: string[] = [];
  const logger: RunnerApiLogger = {
    info: (line) => infoLines.push(line),
    error: (line) => errorLines.push(line),
  };
  const projectService = createProjectService({
    projects: createProjectsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    ),
    hooks: createJobProjectHooks(fixture.workspaceId),
  });
  const appSettings = createAppSettingsRepository(
    fixture.db,
    fixture.workspaceId,
  );
  const reviewSettings = createReviewSettingsService({
    appSettings,
    projects: createProjectsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    ),
    builtIn: () => builtInReviewSettings(env.LLM_MODEL ?? TEST_LLM_MODEL),
  });
  // One app instance: its own collaborators, over the SAME database, queue and fakes. The LLM access is put
  // together as the running server does it: the key of the job's own workspace. A second instance (`anotherInstance`) shares nothing but
  // the database, which is what several app instances do.
  function buildApi() {
    const llm = createWorkspaceLlm({
      db: fixture.db,
      appSecret: () => TEST_APP_SECRET,
      env: () => env,
      now: fixture.clock.now,
    });
    const claimedKeys = createClaimedKeys({
      db: fixture.db,
      appSecret: () => TEST_APP_SECRET,
      now: fixture.clock.now,
    });
    const api = createRunnerApi({
      queue: options.wrapQueue?.(fixture.queue) ?? fixture.queue,
      repositories: (workspaceId) =>
        createRepositoriesRepository(
          fixture.db,
          workspaceId,
          fixture.clock.now,
        ),
      integrations: (workspaceId) =>
        createIntegrationsRepository(
          fixture.db,
          workspaceId,
          fixture.clock.now,
        ),
      registry,
      guard:
        options.guard ??
        (options.projects === true
          ? createProjectClaimGuard({ projects: () => projectService })
          : allowAllClaimGuard),
      jobOptions:
        options.jobOptions ??
        (options.projects === true
          ? createReviewSettingsJobOptionsSource({
              settings: () => reviewSettings,
            })
          : emptyJobOptionsSource),
      loadLlm: (workspaceId) => llm.accessFor(workspaceId),
      claimedKeys,
      now: fixture.clock.now,
      logger,
      heartbeatIntervalSeconds: 30,
      runnerToken: () => configuredRunnerToken(env),
      knownSecrets: async (workspaceId) => [
        ...knownSecretsFromEnv(env),
        ...(await llm.currentKeysFor(workspaceId)),
      ],
    });
    return { api, llm, claimedKeys };
  }
  const { api, llm, claimedKeys } = buildApi();
  /** Saves (or, with null, removes) the LLM key of the workspace of the jobs. */
  async function setLlmKey(key: string | null): Promise<void> {
    const keys = llm.keyServiceFor(fixture.workspaceId);
    if (key === null) {
      await keys.remove();
      return;
    }
    const saved = await keys.save(
      { provider: "openrouter", apiKey: key },
      null,
    );
    if (!saved.ok) throw new Error("The test LLM key was refused.");
  }
  await setLlmKey(
    options.llmKey === undefined ? TEST_LLM_API_KEY : options.llmKey,
  );

  function headers(
    request: RequestOptions,
    extra: Record<string, string> = {},
  ): Headers {
    const result = new Headers(extra);
    const authorization =
      request.authorization !== undefined
        ? request.authorization
        : request.token === null
          ? null
          : `Bearer ${request.token ?? TEST_RUNNER_TOKEN}`;
    if (authorization !== null) result.set("authorization", authorization);
    if (request.runnerId !== null)
      result.set("x-runner-id", request.runnerId ?? "runner-a");
    return result;
  }

  const url = "https://app.test/api/runners/v1";

  function claim(request: RequestOptions = {}): Promise<Response> {
    return api.claim(
      new Request(`${url}/claim`, {
        method: "POST",
        headers: headers(request),
      }),
    );
  }

  function postTo(
    target: typeof api,
    action: "heartbeat" | "complete",
    jobId: string,
    body: unknown,
    request: RequestOptions = {},
  ): Promise<Response> {
    const call = new Request(`${url}/jobs/${jobId}/${action}`, {
      method: "POST",
      headers: headers(request, { "content-type": "application/json" }),
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return action === "heartbeat"
      ? target.heartbeat(call, jobId)
      : target.complete(call, jobId);
  }

  /** `body` is sent as JSON, or as it is if it is a string. */
  const post = (
    action: "heartbeat" | "complete",
    jobId: string,
    body: unknown,
    request: RequestOptions = {},
  ) => postTo(api, action, jobId, body, request);

  /**
   * Another app instance over the same database (nothing in memory is shared with the first): for the tests
   * of what must work whichever instance serves a call.
   */
  function anotherInstance() {
    const other = buildApi();
    return {
      claimedKeys: other.claimedKeys,
      claim: (request: RequestOptions = {}) =>
        other.api.claim(
          new Request(`${url}/claim`, {
            method: "POST",
            headers: headers(request),
          }),
        ),
      complete: (
        jobId: string,
        leaseToken: string,
        result: Partial<RunnerResult> = {},
        request?: RequestOptions,
      ) =>
        postTo(
          other.api,
          "complete",
          jobId,
          { leaseToken, result: goodResult(result) },
          request,
        ),
    };
  }

  const heartbeat = (
    jobId: string,
    leaseToken: string,
    request?: RequestOptions,
  ) => post("heartbeat", jobId, { leaseToken }, request);

  const complete = (
    jobId: string,
    leaseToken: string,
    result: Partial<RunnerResult> = {},
    request?: RequestOptions,
  ) =>
    post(
      "complete",
      jobId,
      { leaseToken, result: goodResult(result) },
      request,
    );

  /** Every row of the jobs table, for "nothing changed" assertions. */
  const snapshotJobs = () =>
    fixture.db.selectFrom("jobs").selectAll().orderBy("id").execute();

  /** Claims the next job and returns the parsed answer. */
  async function claimed(request?: RequestOptions) {
    const response = await claim(request);
    if (response.status !== 200)
      throw new Error(`Expected a job, got ${response.status}.`);
    return (await response.json()) as ClaimResponse;
  }

  return {
    ...fixture,
    github,
    fake: github.fake,
    /** The repository that `enqueue` uses: its name and the platform's id. */
    repository: {
      fullName: repository.fullName,
      externalId: repository.externalId,
    },
    githubClock: github.clock,
    env,
    /** The LLM access of each workspace, as the claim resolves it: `llm.keyServiceFor(id).save(...)` sets a workspace key. */
    llm,
    setLlmKey,
    claimedKeys,
    registry,
    /** The project service (with the job queue's deactivation hook) and the review settings service. */
    projectService,
    reviewSettings,
    api,
    anotherInstance,
    claim,
    claimed,
    heartbeat,
    complete,
    post,
    snapshotJobs,
    issuedJobTokens,
    infoLines,
    errorLines,
    /** Everything the API logged. */
    logLines: () => [...infoLines, ...errorLines],
  };
}

export type RunnerApiHarness = Awaited<
  ReturnType<typeof startRunnerApiHarness>
>;

/** A valid, successful result; any field can be replaced. */
export function goodResult(
  overrides: Partial<RunnerResult> = {},
): RunnerResult {
  return {
    ok: true,
    durationMs: 41250,
    commentUrl: "https://github.test/acme/widgets/pull/7#issuecomment-1001",
    errorCode: null,
    errorMessage: null,
    logTail: "review published",
    logTruncated: false,
    usage: {
      model: TEST_LLM_MODEL,
      promptTokens: 12000,
      completionTokens: 900,
      totalTokens: 12900,
      aiCalls: 2,
      fallbackUsed: false,
      costUsd: 0.04,
    },
    ...overrides,
  };
}
