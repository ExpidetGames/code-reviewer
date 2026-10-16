// SPDX-License-Identifier: Apache-2.0

// Everything a test of the runner API needs: a real SQLite file with the job queue and one
// integration (installation 4242, repositories acme/widgets and acme/gadgets), the fake GitHub behind
// the real GitHub App provider, and the API itself wired to all of them. `claim`, `heartbeat` and
// `complete` build requests like the runner does. The clock of the queue is the one in `clock`.
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createJobsRepository } from "../db/repositories/jobs-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createDefaultIntegrationRegistry } from "../integrations/registry.ts";
import { loadGithubAppConfig } from "../integrations/registry.ts";
import type { JobQueueLimits } from "../jobs/job-limits.ts";
import type { LlmAccessResult } from "../llm/access.ts";
import { createWorkspaceLlm } from "../llm/assemble.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import {
  createModelTiersService,
  type ModelTiersService,
} from "../model-tiers/service.ts";
import { allTierModels, type ManagedModelTiers } from "../model-tiers/tiers.ts";
import type { ModelCapabilityChecker } from "../llm/model-capabilities.ts";
import { createRunnerApi } from "../runner-api/api.ts";
import {
  createWorkerApi,
  type WorkerApiDeps,
} from "../runner-api/worker-api.ts";
import {
  allowAllClaimGuard,
  type ClaimGuard,
} from "../runner-api/claim-guard.ts";
import type {
  ClaimResponse,
  RunnerResult,
  SplitClaimResponse,
  WorkerJobDetailsResponse,
} from "../runner-api/contract.ts";
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
import type { ReportDeps } from "../runner-api/report.ts";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createJobProjectHooks } from "../jobs/project-hooks.ts";
import { createProjectService } from "../projects/service.ts";
import { assembleRefusalNoticeService } from "../refusal-notices/assemble.ts";
import type {
  NoticeRefusal,
  RefusalNoticeService,
} from "../refusal-notices/service.ts";
import { createReviewSettingsService } from "../review-settings/service.ts";
import { builtInReviewSettings } from "../review-settings/settings.ts";
import { startGithubAppHarness } from "./github-app-harness.ts";
import { readEffectiveEntitlements } from "../workspaces/effective-entitlements.ts";
import { TEST_APP_SLUG } from "./github-app.ts";
import { createJobQueueFixture, sha, type TestQueue } from "./jobs.ts";

export const TEST_RUNNER_TOKEN = "test-runner-token-4f9c2a7e1b-0d58a3c6e9f2";
export const TEST_LLM_API_KEY = "test-llm-api-key-8d3b6e0a5c";
export const TEST_LLM_MODEL = "vendor/test-model";
export const TEST_APP_VERSION = "0.0.0-test";
export const TEST_APP_SECRET = "runner-api-test-app-secret-0123456789-0123";

export type RequestOptions = {
  /** Sent as `Authorization: Bearer <token>`. Default: the right token. `null` sends no header. */
  token?: string | null;
  /** The whole header value, for another scheme or an empty `Bearer`. Wins over `token`. */
  authorization?: string | null;
  /** `X-Runner-Id`. Default `runner-a`. `null` leaves the header out. */
  runnerId?: string | null;
  /**
   * #195: the engines sent in the claim body. Left out, the request has no body at all, which is how
   * a previous-release runner asks and means `pr-agent`. An empty array is an (invalid) explicit list.
   */
  engines?: string[];
  /** #279: the features sent in the claim body next to the engines (`dynamic_capabilities`). */
  features?: string[];
  /** #322: the job a Dispatcher claims. Sent in the claim body; the engines then default to `pr-agent`. */
  jobId?: string;
  /** #322: the pool cap. Sent in the claim body. Any value, so a test can send an invalid one. */
  maxRunning?: unknown;
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
    /** #395: what the running server does when a job ends or a call touched the database. */
    hooks?: Pick<ReportDeps, "jobEnded" | "activity">;
    limits?: Partial<JobQueueLimits>;
    /** Replaces or (with undefined) removes variables of the app's environment. */
    env?: Record<string, string | undefined>;
    /**
     * The LLM key of the workspace the jobs belong to, as an Owner or an Admin saved it (the key service of
     * the workspace). Default: `TEST_LLM_API_KEY`. `null`: the workspace has none.
     */
    llmKey?: string | null;
    /** Replaces how the claim resolves the LLM access of a workspace (for example to answer with the operator's key). */
    loadLlm?: (workspaceId: string) => Promise<LlmAccessResult>;
    /** #279: where a Dynamic claim reads the model metadata from. Left out, the claim reads none. */
    modelCapabilities?: ModelCapabilityChecker;
    /**
     * #280: the operator's configuration of the managed tiers, stored as the operator API stores it. Left out: no
     * tier is configured, and a job on the operator's key fails closed (`managed_tier_unavailable`). It can be
     * changed later with `h.setTiers`.
     */
    modelTiers?: ManagedModelTiers;
    /**
     * #281: wires the notice of a refused review like the running server does (`h.notices`). With
     * `deliver: "manual"` the refusals are only collected (`h.notices.refusals`) and the test hands them on.
     */
    refusalNotices?: {
      deliver?: "claim" | "manual";
      /** The link to the plan page of a workspace; default none. */
      planPageUrl?: (
        workspaceSlug: string,
      ) => string | null | Promise<string | null>;
      /** How long a request to GitHub may take. */
      githubRequestTimeoutMs?: number;
    };
  } = {},
) {
  const noticeOptions = options.refusalNotices;
  const refusals: NoticeRefusal[] = [];
  const noticeWork: Promise<void>[] = [];
  let noticeService: RefusalNoticeService | undefined;
  const fixture = await createJobQueueFixture({
    ...(noticeOptions === undefined
      ? {}
      : {
          onRefused: (refusal: NoticeRefusal) => {
            refusals.push(refusal);
            if (noticeOptions.deliver === "manual") return;
            if (noticeService !== undefined)
              noticeWork.push(noticeService.onRefused(refusal));
          },
        }),
    // The runner API tests exercise routing by engines; the Dynamic Review rollout gate (#195) is
    // covered by the queue tests, so the harness enables it.
    dynamicReview: true,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  // With the notice wired, the comments of the fake are authored as the slug of the app's own configuration,
  // which is how the provider recognizes the app's own comment (`<slug>[bot]`).
  const github = await startGithubAppHarness(
    noticeOptions === undefined ? {} : { appSlug: TEST_APP_SLUG },
  );
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
    loadConfig: () => loadGithubAppConfig(github.env),
    githubClient: {
      now: github.clock.now,
      requestTimeoutMs: noticeOptions?.githubRequestTimeoutMs ?? 5000,
    },
  });
  const infoLines: string[] = [];
  const errorLines: string[] = [];
  /** What the notice of a refused review logged (#281). */
  const noticeLines: string[] = [];
  /** One app instance's notice service; another one shares nothing but the database and GitHub. */
  const buildNoticeService = () =>
    assembleRefusalNoticeService({
      db: fixture.db,
      registry,
      planPageUrl: noticeOptions?.planPageUrl ?? (() => null),
      now: fixture.clock.now,
      log: {
        info: (line) => noticeLines.push(line),
        error: (line) => noticeLines.push(line),
      },
    });
  if (noticeOptions !== undefined) noticeService = buildNoticeService();
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
  // The operator's tiers, read by the claim. The metadata check only matters when saving through the service; the
  // harness stores the configuration as it is given, like the operator API did before.
  const instanceSettings = createInstanceSettingsRepository(fixture.db);
  const modelTiers: ModelTiersService = createModelTiersService({
    settings: instanceSettings,
    modelCapabilities: { check: async () => ({ outcome: "unverifiable" }) },
  });
  if (options.modelTiers !== undefined)
    await instanceSettings.set("managed_model_tiers", options.modelTiers, null);
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
    const apiDeps: WorkerApiDeps = {
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
      previousReviewedSha: (job) =>
        createJobsRepository(fixture.db, job.workspaceId).previousReviewedSha({
          repositoryId: job.repositoryId,
          prNumber: job.prNumber,
          reviewKind: job.reviewKind,
          excludeJobId: job.id,
        }),
      attemptedShas: (job) =>
        createJobsRepository(fixture.db, job.workspaceId).attemptedShas({
          repositoryId: job.repositoryId,
          prNumber: job.prNumber,
          reviewKind: job.reviewKind,
          excludeJobId: job.id,
        }),
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
      loadLlm: options.loadLlm ?? ((workspaceId) => llm.accessFor(workspaceId)),
      entitlementsFor: (workspaceId) =>
        readEffectiveEntitlements(fixture.db, workspaceId, fixture.clock.now),
      recordKeyMode: (job, keyMode) =>
        createUsageRecordsRepository(
          fixture.db,
          job.workspaceId,
          fixture.clock.now,
        ).setKeyMode(job.id, keyMode),
      modelTiers,
      tierModels: async (job) => {
        const record = await createUsageRecordsRepository(
          fixture.db,
          job.workspaceId,
          fixture.clock.now,
        ).get(job.id);
        return record?.modelTier == null
          ? { managed: false, models: [] }
          : { managed: true, models: allTierModels(await modelTiers.read()) };
      },
      recordModelTier: (job, tier) =>
        createUsageRecordsRepository(
          fixture.db,
          job.workspaceId,
          fixture.clock.now,
        ).setModelTier(job.id, tier),
      ...(options.modelCapabilities === undefined
        ? {}
        : { modelCapabilities: options.modelCapabilities }),
      claimedKeys,
      ...(options.hooks ?? {}),
      now: fixture.clock.now,
      logger,
      heartbeatIntervalSeconds: 30,
      knownSecrets: async (workspaceId) => [
        ...knownSecretsFromEnv(env),
        ...(await llm.currentKeysFor(workspaceId)),
      ],
    };
    const api = createRunnerApi({
      ...apiDeps,
      runnerToken: () => configuredRunnerToken(env),
      appVersion: TEST_APP_VERSION,
    });
    // #320: the Worker API over the same collaborators (it has no dispatcher credential).
    const workerApi = createWorkerApi(apiDeps);
    return { api, workerApi, llm, claimedKeys };
  }
  const { api, workerApi, llm, claimedKeys } = buildApi();
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
    return api.claim(claimRequest(request));
  }

  /** The claim request of the runner: no body, or the engines (#195) and features (#279) it advertises. */
  function claimRequest(request: RequestOptions): Request {
    if (
      request.engines === undefined &&
      request.jobId === undefined &&
      request.maxRunning === undefined
    )
      return new Request(`${url}/claim`, {
        method: "POST",
        headers: headers(request),
      });
    return new Request(`${url}/claim`, {
      method: "POST",
      headers: headers(request, { "content-type": "application/json" }),
      body: JSON.stringify({
        ...(request.engines === undefined ? {} : { engines: request.engines }),
        ...(request.features === undefined
          ? {}
          : { features: request.features }),
        ...(request.jobId === undefined ? {} : { jobId: request.jobId }),
        ...(request.maxRunning === undefined
          ? {}
          : { maxRunning: request.maxRunning }),
      }),
    });
  }

  /** #322: the release of a Dispatcher: `body` is sent as JSON, or as it is if it is a string. */
  function release(
    jobId: string,
    body: unknown,
    request: RequestOptions = {},
    target: typeof api = api,
  ): Promise<Response> {
    return target.release(
      new Request(`${url}/jobs/${jobId}/release`, {
        method: "POST",
        headers: headers(request, { "content-type": "application/json" }),
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      jobId,
    );
  }

  /** #364: the job state call of a Dispatcher (`GET /jobs/{id}`). */
  function jobState(
    jobId: string,
    request: RequestOptions = {},
  ): Promise<Response> {
    return api.jobState(
      new Request(`${url}/jobs/${jobId}`, {
        method: "GET",
        headers: headers(request),
      }),
      jobId,
    );
  }

  /** #322: the version call of a Dispatcher. */
  function version(
    request: RequestOptions & { query?: string } = {},
  ): Promise<Response> {
    return api.version(
      new Request(`${url}/version${request.query ?? ""}`, {
        method: "GET",
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
      workerApi: other.workerApi,
      claim: (request: RequestOptions = {}) =>
        other.api.claim(claimRequest(request)),
      release: (jobId: string, body: unknown, request: RequestOptions = {}) =>
        release(jobId, body, request, other.api),
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

  const workerUrl = "https://app.test/api/workers/v1";

  /** What a Worker sends: the bearer credential, nothing else (no runner id). */
  function workerHeaders(
    credential: string | null,
    extra: Record<string, string> = {},
  ): Headers {
    const result = new Headers(extra);
    if (credential !== null)
      result.set("authorization", `Bearer ${credential}`);
    return result;
  }

  /** The claim of a Dispatcher: the dispatcher credential and the feature `worker_credential` (#320). */
  function claimSplit(
    request: RequestOptions & { engines?: string[] } = {},
    target: typeof api = api,
  ): Promise<Response> {
    return target.claim(
      claimRequest({
        engines: ["pr-agent"],
        ...request,
        features: ["worker_credential", ...(request.features ?? [])],
      }),
    );
  }

  /** Claims the next job as a Dispatcher and returns the parsed split answer. */
  async function claimedSplit(
    request?: RequestOptions & { engines?: string[] },
  ): Promise<SplitClaimResponse> {
    const response = await claimSplit(request);
    if (response.status !== 200)
      throw new Error(`Expected a job, got ${response.status}.`);
    return (await response.json()) as SplitClaimResponse;
  }

  /** The Worker API as a Worker calls it. `credential: null` sends no header. */
  const worker = {
    details: (
      jobId: string,
      credential: string | null,
      features?: string,
      target: typeof workerApi = workerApi,
    ) =>
      target.details(
        new Request(
          `${workerUrl}/jobs/${jobId}${features === undefined ? "" : `?features=${features}`}`,
          { method: "GET", headers: workerHeaders(credential) },
        ),
        jobId,
      ),
    heartbeat: (
      jobId: string,
      credential: string | null,
      body: string = "{}",
    ) =>
      workerApi.heartbeat(
        new Request(`${workerUrl}/jobs/${jobId}/heartbeat`, {
          method: "POST",
          headers: workerHeaders(credential, {
            "content-type": "application/json",
          }),
          body,
        }),
        jobId,
      ),
    /** `body` is sent as JSON, or as it is if it is a string; a result alone is wrapped as `{ result }`. */
    result: (
      jobId: string,
      credential: string | null,
      result: Partial<RunnerResult> | string = {},
      target: typeof workerApi = workerApi,
    ) =>
      target.result(
        new Request(`${workerUrl}/jobs/${jobId}/result`, {
          method: "POST",
          headers: workerHeaders(credential, {
            "content-type": "application/json",
          }),
          body:
            typeof result === "string"
              ? result
              : JSON.stringify({ result: goodResult(result) }),
        }),
        jobId,
      ),
  };

  /** Claims as a Dispatcher and fetches the job as its Worker: the credential and the job details. */
  async function startedWorker(features?: string) {
    const claim = await claimedSplit();
    const response = await worker.details(
      claim.job.id,
      claim.job.credential,
      features,
    );
    if (response.status !== 200)
      throw new Error(`Expected the job details, got ${response.status}.`);
    return {
      jobId: claim.job.id,
      credential: claim.job.credential,
      details: (await response.json()) as WorkerJobDetailsResponse,
    };
  }

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
    /** The operator's tiers as the claim reads them; `setTiers` stores a configuration without the metadata check. */
    modelTiers,
    setTiers: (tiers: ManagedModelTiers) =>
      instanceSettings.set("managed_model_tiers", tiers, null),
    setLlmKey,
    claimedKeys,
    registry,
    /** The project service (with the job queue's deactivation hook) and the review settings service. */
    projectService,
    reviewSettings,
    api,
    workerApi,
    worker,
    claimSplit,
    claimedSplit,
    startedWorker,
    anotherInstance,
    /** #281: the notice of a refused review. Present only when the harness was started with `refusalNotices`. */
    notices: {
      /** Every refusal the claim reported, in order. */
      refusals,
      /** The log lines of the notice. */
      lines: noticeLines,
      /** Another app instance's service over the same database. */
      another: buildNoticeService,
      /** Waits until every notice the claims started is done. */
      async settled() {
        await Promise.all(noticeWork);
      },
      service: () => {
        if (noticeService === undefined)
          throw new Error("Start the harness with refusalNotices.");
        return noticeService;
      },
      /** The comments on a pull request of the fake GitHub. */
      comments: (repoFullName: string, prNumber: number) =>
        github.fake.pullRequestComments(repoFullName, prNumber),
    },
    claim,
    claimed,
    release,
    jobState,
    version,
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
      stoppedEarly: null,
    },
    ...overrides,
  };
}
