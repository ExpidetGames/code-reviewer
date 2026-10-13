// SPDX-License-Identifier: Apache-2.0

// POST /api/runners/v1/claim: hands the next job to a runner, with everything it needs to run it.
//
// The credentials are created here, at claim time, and nowhere else (never when the job is queued):
// the job is claimed first (so it has a holder and a lease), then, in this order,
//
//   1. the claim guard may refuse it (the project is off, see claim-guard.ts),
//   2. the LLM access must be configured,
//   3. the pull request must still exist and be open (`getPullRequest`),
//   4. the git credentials are created for exactly this repository (`jobAccess`, the only call that
//      mints a token for a job) and revealed once, into the response.
//
// A job that cannot run for a reason that will not go away ends as failed with a stable code, and
// the runner is handed the next job (it never hears of it). A reason that may pass (GitHub is down or
// rate limiting, the pull request could not be read) gives the job back with `release` (a lost
// attempt, capped like a lapsed lease) and answers 503 with Retry-After.
//
// Nothing in here logs or keeps a credential: the revealed access exists only as a local value that
// is built as late as possible and dropped with the response.
import "server-only";
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { IntegrationError } from "../integrations/errors.ts";
import { revealGitAccess } from "../integrations/normalized.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type {
  GitAccess,
  GitPlatform,
  IntegrationType,
  RepoRef,
  ReviewCommand,
} from "../integrations/types.ts";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import type { ClaimResult, Job, JobErrorCode } from "../jobs/job-types.ts";
import { revealLlmAccess, type LlmAccessResult } from "../llm/access.ts";
import {
  MAX_LLM_CONTEXT_TOKENS,
  MIN_LLM_CONTEXT_TOKENS,
  MODEL_NAME_PATTERN,
} from "../llm/config.ts";
import type { ClaimedKeys } from "./claimed-keys.ts";
import type { ClaimGuard } from "./claim-guard.ts";
import {
  RUNNER_API_VERSION,
  RUNNER_ENV_KEY_PATTERN,
  type ClaimBase,
  type ClaimResponse,
  type DynamicReviewOptions,
  type RunnerJobInput,
} from "./contract.ts";
import type { RunnerEngine } from "../jobs/runner-capabilities.ts";
import type { JobOptions, JobOptionsSource } from "./job-options.ts";
import { describeError, type RunnerApiLogger } from "./logger.ts";
import { errorResponse, jsonResponse, noContent } from "./responses.ts";

/**
 * The codes a job gets when it ends at claim time. Branch on these, not on messages. The queue's
 * own `pull_request_closed` and the guard's codes come on top.
 */
export const CLAIM_FAILURE_CODES = [
  "llm_not_configured",
  "git_connection_disabled",
  "git_connection_gone",
  "git_connection_suspended",
  "git_scope_refused",
  "git_app_auth_failed",
  "git_access_failed",
  "pr_not_found",
  "pull_request_closed",
  "job_args_invalid",
  "job_env_invalid",
  "job_llm_options_invalid",
  // #195: the claimed job's kind is not one the runner advertised (a raced settings change), or its
  // Dynamic options are missing/unusable. The runner is never silently given the other engine.
  "dynamic_engine_unavailable",
  "dynamic_config_invalid",
] as const;

/** Why a job is given back (the code becomes the job's error code if it was the last attempt). */
export const CLAIM_RELEASE_REASONS = [
  "git_access_unavailable",
  "pull_request_unavailable",
  "claim_failed",
] as const;

/** When the platform does not say how long to wait. */
export const DEFAULT_RETRY_AFTER_SECONDS = 30;
const MAX_RETRY_AFTER_SECONDS = 900;
/** How many jobs one claim request may end at claim time before it answers 204 and lets the runner ask again. */
const MAX_REFUSED_PER_REQUEST = 25;

export type ClaimDeps = {
  queue: Pick<
    RunnerQueue,
    "claimNext" | "complete" | "release" | "cancelClaimed"
  >;
  /**
   * The repositories and integrations of one workspace. A claim serves the whole instance, so the
   * workspace is the one the claimed job names (`job.workspaceId`).
   */
  repositories: (workspaceId: string) => Pick<RepositoriesRepository, "get">;
  integrations: (workspaceId: string) => Pick<IntegrationsRepository, "get">;
  /**
   * The exact head of the last successful review of the claimed job's pull request for the same
   * review kind (#199), or null when there is none. Only a Dynamic claim asks; it becomes the
   * `previousReviewedSha` the checkout and the publisher compare against.
   */
  previousReviewedSha: (job: Job) => Promise<string | null>;
  registry: IntegrationRegistry;
  guard: ClaimGuard;
  jobOptions: JobOptionsSource;
  /**
   * The LLM access of ONE workspace: the one the claimed job names (`job.workspaceId`), never another
   * (src/llm/resolve.ts, docs/decisions/0001-editions-setup-and-accounts.md, section 2.8).
   */
  loadLlm: (workspaceId: string) => Promise<LlmAccessResult>;
  /** Where the key handed out with a claim is noted (encrypted, in the database), so a rotated key can still be masked. */
  claimedKeys: Pick<ClaimedKeys, "remember">;
  now: () => Date;
  logger: RunnerApiLogger;
  heartbeatIntervalSeconds: number;
};

type Prepared =
  | { kind: "ready"; response: ClaimResponse }
  | { kind: "refused"; errorCode: string; detail?: string }
  | { kind: "cancelled"; errorCode: JobErrorCode }
  | { kind: "retry"; reason: string; retryAfterSeconds: number };

function refuse(errorCode: string, detail?: string): Prepared {
  return detail === undefined
    ? { kind: "refused", errorCode }
    : { kind: "refused", errorCode, detail };
}

function retryAfterOf(error: unknown): number {
  const seconds =
    error instanceof IntegrationError ? error.retryAfterSeconds : null;
  return Math.min(
    Math.max(Math.ceil(seconds ?? DEFAULT_RETRY_AFTER_SECONDS), 1),
    MAX_RETRY_AFTER_SECONDS,
  );
}

function accessFailureCode(error: IntegrationError): string {
  switch (error.code) {
    case "INTEGRATION_ACCESS_CONNECTION_GONE":
      return "git_connection_gone";
    case "INTEGRATION_ACCESS_CONNECTION_SUSPENDED":
      return "git_connection_suspended";
    case "INTEGRATION_ACCESS_SCOPE_REFUSED":
      return "git_scope_refused";
    case "INTEGRATION_ACCESS_APP_AUTH_FAILED":
      return "git_app_auth_failed";
    default:
      return "git_access_failed";
  }
}

/** The platform each integration type talks to; the runner knows GitHub only. */
const PLATFORM_OF: Record<IntegrationType, GitPlatform> = {
  github_app: "github",
};

/**
 * The model and context size a project chose, as the job takes them: a null is left out (the runner
 * refuses a `maxTokens` that is not a whole number). Null when a value is one the runner would refuse.
 */
function llmOptionsOf(
  options: JobOptions,
): { model?: string; maxTokens?: number } | null {
  const { model, maxTokens } = options.llm ?? {};
  const chosen: { model?: string; maxTokens?: number } = {};
  if (model !== undefined && model !== null) {
    if (!MODEL_NAME_PATTERN.test(model)) return null;
    chosen.model = model;
  }
  if (maxTokens !== undefined && maxTokens !== null) {
    if (
      !Number.isInteger(maxTokens) ||
      maxTokens < MIN_LLM_CONTEXT_TOKENS ||
      maxTokens > MAX_LLM_CONTEXT_TOKENS
    )
      return null;
    chosen.maxTokens = maxTokens;
  }
  return chosen;
}

/** `/review` takes no arguments; it is the only command a claim may hand out (#203). */
function commandOf(job: Job): ReviewCommand | null {
  return job.command === "review" ? "review" : null;
}

/** The largest skill text a Dynamic job may carry, in UTF-8 bytes (`PROJECT_DYNAMIC_LIMITS`). */
const MAX_DYNAMIC_SKILL_BYTES = 16 * 1024;
const MAX_DYNAMIC_MODEL_CHARS = 200;

/**
 * The Dynamic options of a job (#195), taken from the project's settings resolved at claim time. Only
 * model/skill/limits: there is no field for the fixed core, a command, an endpoint or a permission,
 * so nothing of that kind can be smuggled in. `null` when the options are missing or unusable.
 */
function dynamicOptionsOf(options: JobOptions): DynamicReviewOptions | null {
  const dynamic = options.dynamic;
  if (dynamic === undefined) return null;
  if (
    !MODEL_NAME_PATTERN.test(dynamic.model) ||
    dynamic.model.length > MAX_DYNAMIC_MODEL_CHARS
  )
    return null;
  if (
    new TextEncoder().encode(dynamic.skill).byteLength > MAX_DYNAMIC_SKILL_BYTES
  )
    return null;
  if (
    !Number.isInteger(dynamic.maxFindings) ||
    dynamic.maxFindings < 1 ||
    dynamic.maxFindings > 30
  )
    return null;
  return {
    model: dynamic.model,
    skill: dynamic.skill,
    limits: { maxFindings: dynamic.maxFindings },
  };
}

/**
 * The checkout facts a Dynamic job carries. The head SHA is the one that was queued; the base is the
 * identity the provider reported. `comparison` is a declared mode, not proof: the checkout verifies
 * completeness before it trusts it, and `previousReviewedSha` is the head of the last successful
 * review of the same kind (#199), or null. Nothing here is a permission or an endpoint.
 */
function claimBaseOf(
  repositoryFullName: string,
  baseRef: string,
  headSha: string,
  previousReviewedSha: string | null,
): ClaimBase {
  return {
    repository: repositoryFullName,
    baseRef,
    headSha,
    previousReviewedSha,
    comparison: "full",
  };
}

async function prepare(
  deps: ClaimDeps,
  claimed: NonNullable<ClaimResult>,
  engines: readonly RunnerEngine[],
): Promise<Prepared> {
  const { job, leaseToken } = claimed;

  const decision = await deps.guard.check(job);
  if (!decision.allow)
    return decision.outcome === "cancel"
      ? { kind: "cancelled", errorCode: decision.errorCode }
      : refuse(decision.errorCode);

  // The access of the job's own workspace: its key, or the operator's, or the legacy variables of a
  // single-tenant instance. Another workspace's key is never looked at.
  const llm = await deps.loadLlm(job.workspaceId);
  // The log names the variables that are wrong and why (names and codes, never a value), or else the
  // reason the workspace has no access.
  if (!llm.ok)
    return refuse(
      llm.errorCode,
      llm.issues.length > 0
        ? llm.issues
            .map((issue) => `${issue.variable}: ${issue.code}`)
            .join(", ")
        : llm.reason,
    );

  const command = commandOf(job);
  if (command === null) return refuse("job_args_invalid");
  const options = await deps.jobOptions.optionsFor(job);
  if (Object.keys(options.env).some((key) => !RUNNER_ENV_KEY_PATTERN.test(key)))
    return refuse("job_env_invalid");
  const llmOptions = llmOptionsOf(options);
  if (llmOptions === null) return refuse("job_llm_options_invalid");

  // #195: a Dynamic job is only built for a runner that advertised `opencode`, and it must carry the
  // project's Dynamic options. Both are checked before any credential is created.
  const dynamic =
    job.reviewKind === "dynamic" ? dynamicOptionsOf(options) : null;
  if (job.reviewKind === "dynamic") {
    if (!engines.includes("opencode"))
      return refuse("dynamic_engine_unavailable");
    if (dynamic === null) return refuse("dynamic_config_invalid");
  }

  if (job.leaseExpiresAt === null)
    throw new Error(`Claimed job ${job.id} has no lease expiry.`);

  const repository = await deps
    .repositories(job.workspaceId)
    .get(job.repositoryId);
  const integration =
    repository === undefined
      ? undefined
      : await deps.integrations(job.workspaceId).get(repository.integrationId);
  if (
    repository === undefined ||
    integration === undefined ||
    integration.status !== "active"
  )
    return refuse("git_connection_disabled");
  // The runner speaks GitHub only: refuse before anything is created if this connection is not.
  if (PLATFORM_OF[integration.type] !== "github")
    return refuse("git_access_failed");
  const provider = deps.registry.resolve(integration.type);
  const repo: RepoRef = {
    integrationId: repository.integrationId,
    externalId: repository.externalId,
    fullName: repository.fullName,
    url: repository.url,
  };

  // The pull request must still be there and open; its URL and base branch come from the platform.
  let prUrl: string;
  let baseRef: string;
  try {
    const pullRequest = await provider.getPullRequest(
      integration,
      repo,
      job.prNumber,
    );
    if (pullRequest.state !== "open") return refuse("pull_request_closed");
    prUrl = pullRequest.url;
    baseRef = pullRequest.baseRef;
  } catch (error) {
    if (
      error instanceof IntegrationError &&
      error.code === "INTEGRATION_PULL_REQUEST_NOT_FOUND"
    )
      return refuse("pr_not_found");
    deps.logger.error(
      `[runner-api] job=${job.id} the pull request could not be read: ${describeError(error)}`,
    );
    return {
      kind: "retry",
      reason: "pull_request_unavailable",
      retryAfterSeconds: retryAfterOf(error),
    };
  }

  // The one place that creates credentials for a job. The revealed copy is a plain object that only
  // lives until the response is built.
  let git: GitAccess;
  try {
    git = revealGitAccess(await provider.jobAccess(integration, repo));
  } catch (error) {
    if (!(error instanceof IntegrationError)) throw error;
    deps.logger.error(
      `[runner-api] job=${job.id} credentials could not be created: ${describeError(error)}`,
    );
    if (error.retryable)
      return {
        kind: "retry",
        reason: "git_access_unavailable",
        retryAfterSeconds: retryAfterOf(error),
      };
    return refuse(accessFailureCode(error));
  }
  // The runner needs the login the bot acts as; only the access itself can say.
  if (git.provider !== "github" || git.botLogin === null)
    return refuse("git_access_failed");

  // The instance's model and context window are the defaults; the review settings of the project
  // replace them. The job never carries `fallbackModels`: the MVP has no fallback chain.
  const llmAccess = revealLlmAccess(llm.access);
  const maxTokens = llmOptions.maxTokens ?? llmAccess.contextWindowTokens;
  // #199: the head of the last successful Dynamic review of this pull request, so the dynamic job
  // can compare against it. A Diff job never carries a base, so it is not looked up.
  const previousReviewedSha =
    job.reviewKind === "dynamic" ? await deps.previousReviewedSha(job) : null;
  // The exact legacy Diff payload for every Diff job, whatever kind of runner asked: the keys are in
  // the order the previous release wrote them, byte for byte (prUrl, command, git, llm, env;
  // llm.provider, model, apiKey, maxTokens), so a golden serialization matches. A Dynamic job is only
  // ever handed to a runner that advertised `opencode`, so its tagged fields never reach an old runner.
  const input: RunnerJobInput =
    dynamic === null
      ? {
          prUrl,
          command,
          git: {
            provider: "github",
            baseUrl: git.baseUrl,
            token: git.token,
            botLogin: git.botLogin,
          },
          llm: {
            provider: llmAccess.provider,
            model: llmOptions.model ?? llmAccess.model,
            apiKey: llmAccess.apiKey,
            ...(maxTokens === null ? {} : { maxTokens }),
          },
          env: options.env,
        }
      : {
          prUrl,
          command,
          reviewKind: "dynamic",
          dynamic,
          base: claimBaseOf(
            repo.fullName,
            baseRef,
            job.headSha,
            previousReviewedSha,
          ),
          git: {
            provider: "github",
            baseUrl: git.baseUrl,
            token: git.token,
            botLogin: git.botLogin,
          },
          llm: {
            provider: llmAccess.provider,
            model: dynamic.model,
            apiKey: llmAccess.apiKey,
            ...(maxTokens === null ? {} : { maxTokens }),
          },
          env: {},
        };
  return {
    kind: "ready",
    response: {
      version: RUNNER_API_VERSION,
      job: {
        id: job.id,
        leaseToken,
        leaseExpiresAt: job.leaseExpiresAt,
        heartbeatIntervalSeconds: deps.heartbeatIntervalSeconds,
        tokenExpiresAt: git.expiresAt,
        input,
      },
    },
  };
}

/** Ends a claimed job as failed with a code; the runner is not told. Throws if the queue fails. */
async function endJob(
  deps: ClaimDeps,
  claimed: NonNullable<ClaimResult>,
  runnerId: string,
  errorCode: string,
  detail?: string,
): Promise<void> {
  const result = await deps.queue.complete(claimed.job.id, claimed.leaseToken, {
    ok: false,
    errorCode,
  });
  if (result.status !== "completed") {
    // Not ours any more (the lease ran out in the meantime); whoever holds the job now decides.
    deps.logger.error(
      `[runner-api] claim runner=${runnerId} job=${claimed.job.id} could not be ended at claim: ${result.status}`,
    );
    return;
  }
  deps.logger.info(
    `[runner-api] claim runner=${runnerId} job=${claimed.job.id} ended at claim: ${errorCode}${detail === undefined || detail === "" ? "" : ` (${detail})`}`,
  );
}

/**
 * Ends a claimed job as cancelled, the way a deactivation ends a waiting one: one statement fenced by
 * the lease token (`cancelClaimed`), no attempt counted, never queued in between. Only this job is
 * touched; the other waiting jobs of the repository were cancelled by the deactivation. Throws if the
 * queue fails; the caller gives the job back.
 */
async function cancelJob(
  deps: ClaimDeps,
  claimed: NonNullable<ClaimResult>,
  runnerId: string,
  errorCode: JobErrorCode,
): Promise<void> {
  const result = await deps.queue.cancelClaimed(
    claimed.job.id,
    claimed.leaseToken,
    errorCode,
  );
  if (result.status === "not_holder") {
    // Not ours any more (the lease ran out in the meantime); whoever holds the job now decides.
    deps.logger.error(
      `[runner-api] claim runner=${runnerId} job=${claimed.job.id} could not be cancelled at claim: not_holder`,
    );
    return;
  }
  deps.logger.info(
    `[runner-api] claim runner=${runnerId} job=${claimed.job.id} cancelled at claim: ${errorCode}`,
  );
}

/** Gives the job back after an unexpected failure, so it is not stuck under a lease nobody uses. */
async function giveBack(
  deps: ClaimDeps,
  claimed: NonNullable<ClaimResult>,
  reason: string,
  retryAt?: Date,
): Promise<void> {
  try {
    await deps.queue.release(
      claimed.job.id,
      claimed.leaseToken,
      reason,
      retryAt === undefined ? undefined : { retryAt },
    );
  } catch (error) {
    deps.logger.error(
      `[runner-api] job=${claimed.job.id} could not be given back: ${describeError(error)}`,
    );
  }
}

export async function handleClaim(
  deps: ClaimDeps,
  runnerId: string,
  engines: readonly RunnerEngine[],
): Promise<Response> {
  for (let refused = 0; refused < MAX_REFUSED_PER_REQUEST; refused += 1) {
    const claimed = await deps.queue.claimNext(runnerId, engines);
    if (claimed === null) return noContent();

    // Whatever goes wrong from here on, the job is given back instead of staying under a lease that
    // nobody uses (it would only run out after two minutes).
    try {
      const prepared = await prepare(deps, claimed, engines);

      if (prepared.kind === "refused") {
        await endJob(
          deps,
          claimed,
          runnerId,
          prepared.errorCode,
          prepared.detail,
        );
        continue;
      }

      if (prepared.kind === "cancelled") {
        await cancelJob(deps, claimed, runnerId, prepared.errorCode);
        continue;
      }

      if (prepared.kind === "retry") {
        await giveBack(
          deps,
          claimed,
          prepared.reason,
          new Date(deps.now().getTime() + prepared.retryAfterSeconds * 1000),
        );
        deps.logger.info(
          `[runner-api] claim runner=${runnerId} job=${claimed.job.id} given back: ${prepared.reason}`,
        );
        return errorResponse(503, "RUNNER_GIT_ACCESS_UNAVAILABLE", {
          retryAfterSeconds: prepared.retryAfterSeconds,
        });
      }

      // Before the key leaves with the response: if it cannot be remembered, the job is given back (below)
      // and no runner has the key.
      await deps.claimedKeys.remember(
        claimed.job.id,
        prepared.response.job.input.llm.apiKey,
      );
      deps.logger.info(
        `[runner-api] claim runner=${runnerId} job=${claimed.job.id} command=${claimed.job.command}`,
      );
      return jsonResponse(200, prepared.response);
    } catch (error) {
      deps.logger.error(
        `[runner-api] claim runner=${runnerId} job=${claimed.job.id} failed: ${describeError(error)}`,
      );
      await giveBack(deps, claimed, "claim_failed");
      return errorResponse(500, "RUNNER_INTERNAL_ERROR");
    }
  }
  // Many jobs in a row ended at claim time; let the runner ask again instead of holding the request.
  return noContent();
}
