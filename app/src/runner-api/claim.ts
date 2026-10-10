// POST /api/runners/v1/claim: hands the next job to a runner, with everything it needs to run it.
//
// The credentials are created here, at claim time, and nowhere else (never when the job is queued):
// the job is claimed first (so it has a holder and a lease), then, in this order,
//
//   1. the claim guard may refuse it (a hook for "the project is off", see claim-guard.ts),
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
} from "../integrations/types.ts";
import type { JobQueue } from "../jobs/job-queue.ts";
import type { ClaimResult, Job } from "../jobs/job-types.ts";
import { revealLlmAccess, type LlmAccessResult } from "../llm/config.ts";
import type { ClaimGuard } from "./claim-guard.ts";
import {
  RUNNER_API_VERSION,
  RUNNER_ENV_KEY_PATTERN,
  type ClaimResponse,
  type RunnerJobInput,
} from "./contract.ts";
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
/** The question of an `ask` job: the runner refuses more (and none). */
const MAX_QUESTION_CHARS = 4000;
/** What the runner accepts as `llm.model` and `llm.maxTokens` (runner job.py). */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/;
const MIN_CONTEXT_TOKENS = 1000;
const MAX_CONTEXT_TOKENS = 10_000_000;

export type ClaimDeps = {
  queue: Pick<JobQueue, "claimNext" | "complete" | "release">;
  repositories: Pick<RepositoriesRepository, "get">;
  integrations: Pick<IntegrationsRepository, "get">;
  registry: IntegrationRegistry;
  guard: ClaimGuard;
  jobOptions: JobOptionsSource;
  loadLlm: () => LlmAccessResult;
  now: () => Date;
  logger: RunnerApiLogger;
  heartbeatIntervalSeconds: number;
};

type Prepared =
  | { kind: "ready"; response: ClaimResponse }
  | { kind: "refused"; errorCode: string }
  | { kind: "retry"; reason: string; retryAfterSeconds: number };

function refuse(errorCode: string): Prepared {
  return { kind: "refused", errorCode };
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
    if (!MODEL.test(model)) return null;
    chosen.model = model;
  }
  if (maxTokens !== undefined && maxTokens !== null) {
    if (
      !Number.isInteger(maxTokens) ||
      maxTokens < MIN_CONTEXT_TOKENS ||
      maxTokens > MAX_CONTEXT_TOKENS
    )
      return null;
    chosen.maxTokens = maxTokens;
  }
  return chosen;
}

/** The question of an `ask` job; other commands take no arguments. Null when it cannot be sent. */
function argsOf(job: Job): { args?: [string] } | null {
  if (job.command !== "ask") return {};
  const question = job.args.trim();
  if (question === "" || question.length > MAX_QUESTION_CHARS) return null;
  return { args: [question] };
}

async function prepare(
  deps: ClaimDeps,
  claimed: NonNullable<ClaimResult>,
): Promise<Prepared> {
  const { job, leaseToken } = claimed;

  const decision = await deps.guard.check(job);
  if (!decision.allow) return refuse(decision.errorCode);

  const llm = deps.loadLlm();
  if (!llm.ok) return refuse(llm.errorCode);

  const args = argsOf(job);
  if (args === null) return refuse("job_args_invalid");
  const options = await deps.jobOptions.optionsFor(job);
  if (Object.keys(options.env).some((key) => !RUNNER_ENV_KEY_PATTERN.test(key)))
    return refuse("job_env_invalid");
  const llmOptions = llmOptionsOf(options);
  if (llmOptions === null) return refuse("job_llm_options_invalid");
  if (job.leaseExpiresAt === null)
    throw new Error(`Claimed job ${job.id} has no lease expiry.`);

  const repository = await deps.repositories.get(job.repositoryId);
  const integration =
    repository === undefined
      ? undefined
      : await deps.integrations.get(repository.integrationId);
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

  // The pull request must still be there and open; its URL comes from the platform.
  let prUrl: string;
  try {
    const pullRequest = await provider.getPullRequest(
      integration,
      repo,
      job.prNumber,
    );
    if (pullRequest.state !== "open") return refuse("pull_request_closed");
    prUrl = pullRequest.url;
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

  const input: RunnerJobInput = {
    prUrl,
    command: job.command,
    ...args,
    git: {
      provider: "github",
      baseUrl: git.baseUrl,
      token: git.token,
      botLogin: git.botLogin,
    },
    llm: {
      ...revealLlmAccess(llm.access),
      ...(llmOptions.model === undefined ? {} : { model: llmOptions.model }),
      ...(llmOptions.maxTokens === undefined
        ? {}
        : { maxTokens: llmOptions.maxTokens }),
    },
    env: options.env,
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
    `[runner-api] claim runner=${runnerId} job=${claimed.job.id} ended at claim: ${errorCode}`,
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
): Promise<Response> {
  for (let refused = 0; refused < MAX_REFUSED_PER_REQUEST; refused += 1) {
    const claimed = await deps.queue.claimNext(runnerId);
    if (claimed === null) return noContent();

    // Whatever goes wrong from here on, the job is given back instead of staying under a lease that
    // nobody uses (it would only run out after two minutes).
    try {
      const prepared = await prepare(deps, claimed);

      if (prepared.kind === "refused") {
        await endJob(deps, claimed, runnerId, prepared.errorCode);
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
