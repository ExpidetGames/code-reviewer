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
//
// #320: a claim that names the feature `worker_credential` (a Dispatcher) runs steps 1 to 3 only and
// answers with a per-job credential and no input. Step 4 (`buildJobInput`: the job's input, with the git
// credentials and the model key) runs when the Worker fetches the job (`worker-fetch.ts`), by the same
// code, so the Dispatcher never sees a secret of the job.
import "server-only";
import type { AttemptedShas } from "../db/repositories/jobs-repository.ts";
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { IntegrationError } from "../integrations/errors.ts";
import { revealGitAccess } from "../integrations/normalized.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type {
  GitAccess,
  GitPlatform,
  Integration,
  IntegrationType,
  RepoRef,
  ReviewCommand,
} from "../integrations/types.ts";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import type { ClaimResult, Job, JobErrorCode } from "../jobs/job-types.ts";
import type { ResolvedEntitlements } from "../workspaces/entitlements.ts";
import { DEFAULT_LLM_PROVIDER } from "../llm/providers/index.ts";
import { revealLlmAccess, type LlmAccessResult } from "../llm/access.ts";
import {
  MAX_LLM_CONTEXT_TOKENS,
  MIN_LLM_CONTEXT_TOKENS,
  isModelId,
} from "../llm/config.ts";
import {
  keyModeOfAccessSource,
  type UsageKeyMode,
} from "../usage/usage-records.ts";
import { dynamicCapabilitiesOf } from "../llm/dynamic-capabilities.ts";
import type {
  ModelCapabilityChecker,
  ModelCapabilityResult,
} from "../llm/model-capabilities.ts";
import type { ModelTierSource } from "../model-tiers/service.ts";
import {
  clampMaxTokens,
  DEFAULT_MODEL_TIER,
  UNKNOWN_WINDOW_MAX_TOKENS,
  type ModelTier,
} from "../model-tiers/tiers.ts";
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import type { ClaimedKeys } from "./claimed-keys.ts";
import type { ClaimGuard } from "./claim-guard.ts";
import {
  RUNNER_API_VERSION,
  RUNNER_ENV_KEY_PATTERN,
  type ClaimBase,
  type ClaimFeature,
  type ClaimResponse,
  type DynamicModelCapabilities,
  type DynamicReviewOptions,
  type RunnerJobInput,
  type SplitClaimResponse,
} from "./contract.ts";
import type { RunnerEngine } from "../jobs/runner-capabilities.ts";
import type { JobOptions, JobOptionsSource } from "./job-options.ts";
import { describeError, type RunnerApiLogger } from "./logger.ts";
import { errorResponse, jsonResponse, noContent } from "./responses.ts";
import type { ClaimOptions } from "../db/repositories/runner-jobs-repository.ts";

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
  // #279: the provider's metadata says the model lacks tool calling or a required tool choice.
  "dynamic_model_features_unsupported",
  // #280: the job runs on the operator's key and the operator configured no model for the project's tier and the
  // job's review kind. Never a move to another tier or to the instance default model.
  "managed_tier_unavailable",
] as const;

/** Why a job is given back (the code becomes the job's error code if it was the last attempt). */
export const CLAIM_RELEASE_REASONS = [
  "git_access_unavailable",
  "pull_request_unavailable",
  "claim_failed",
  // #320: the Dispatcher could not start the Worker (reported with the Worker API's result call).
  "launch_failed",
  // #375: the Worker's container ended with an error before it reported a result (the Dispatcher's release call).
  "worker_exited",
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
  /**
   * The heads of the earlier jobs of that pull request that did not succeed (#255), newest first. A
   * run may have written the summary before it ended; the publisher accepts these heads as a state
   * it can account for, so one lost run never wedges the pull request. `truncated` (#257) says the
   * list was cut, so the runner can recover a state head that fell out of it. Only a Dynamic claim asks.
   */
  attemptedShas: (job: Job) => Promise<AttemptedShas>;
  registry: IntegrationRegistry;
  guard: ClaimGuard;
  jobOptions: JobOptionsSource;
  /**
   * The LLM access of ONE workspace: the one the claimed job names (`job.workspaceId`), never another
   * (src/llm/resolve.ts, docs/decisions/0001-editions-setup-and-accounts.md, section 2.8).
   */
  loadLlm: (workspaceId: string) => Promise<LlmAccessResult>;
  /**
   * The effective entitlements of ONE workspace right now (`readEffectiveEntitlements`). The Worker's fetch asks
   * for the standing of the workspace (suspended, unreadable) before it hands out a key, because the claim that
   * admitted the job is behind it (#276).
   */
  entitlementsFor: (workspaceId: string) => Promise<ResolvedEntitlements>;
  /**
   * Notes whose key the claimed job runs on in its usage record (src/usage/README.md). The claim reserved the
   * record already, as `own`; this corrects it once the access is resolved. A failure gives the job back.
   */
  recordKeyMode: (job: Job, keyMode: UsageKeyMode) => Promise<void>;
  /**
   * Notes the managed tier a job that runs on the operator's key was given in its usage record (#280): the name,
   * never the model. The claim reserved the record already; a failure gives the job back.
   */
  recordModelTier: (job: Job, tier: ModelTier) => Promise<void>;
  /** Which model backs a tier for a kind of review (#280): operator data, read when a managed job is claimed. */
  modelTiers: ModelTierSource;
  /**
   * Where the key handed out with a claim is noted (encrypted, in the database), so a rotated key can still be masked,
   * and the model of a managed tier (#280), so it can be masked in the result even if the operator changes the tier.
   */
  claimedKeys: Pick<ClaimedKeys, "remember" | "rememberModel">;
  /**
   * #279: where the metadata of a Dynamic job's model is read when its claim is built (the provider's
   * public endpoint metadata, cached for a short time). Left out, a claim reads none and a Dynamic job
   * carries no capabilities, as before.
   */
  modelCapabilities?: ModelCapabilityChecker;
  now: () => Date;
  logger: RunnerApiLogger;
  heartbeatIntervalSeconds: number;
};

/** Why a job does not go on: it ends, it is cancelled, or it is given back to try again later. */
export type Refusal =
  | { kind: "refused"; errorCode: string; detail?: string }
  | { kind: "cancelled"; errorCode: JobErrorCode }
  | { kind: "retry"; reason: string; retryAfterSeconds: number };

type Prepared =
  | { kind: "ready"; response: ClaimResponse; tierModel: string | null }
  /** #320: the claim of a Dispatcher: the credential and no input. */
  | { kind: "split"; response: SplitClaimResponse }
  | Refusal;

/** What the checks of a job established; the input of the job is built from it. */
export type Checked = {
  kind: "checked";
  llm: Extract<LlmAccessResult, { ok: true }>;
  command: ReviewCommand;
  options: JobOptions;
  llmOptions: { model?: string; maxTokens?: number };
  /** The Dynamic options of a Dynamic job; null for a Diff job. */
  dynamic: DynamicReviewOptions | null;
  integration: Integration;
  repo: RepoRef;
  prUrl: string;
  baseRef: string;
  /**
   * #280: the tier and the operator's model for it, when the job runs on the operator's key; null otherwise. The model
   * is already in `options` and `dynamic`; it is kept here so the claim can clamp the token budget to its window and
   * remember it for masking.
   */
  tier: { name: ModelTier; model: string } | null;
};

/** What `buildJobInput` made: the input of the job and when its git token stops working. */
export type Built = {
  kind: "built";
  input: RunnerJobInput;
  tokenExpiresAt: string | null;
  /** The operator's model of the tier the job runs at, or null; remembered for masking (#280). */
  tierModel: string | null;
};

function refuse(errorCode: string, detail?: string): Refusal {
  return detail === undefined
    ? { kind: "refused", errorCode }
    : { kind: "refused", errorCode, detail };
}

export function retryAfterOf(error: unknown): number {
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
    if (!isModelId(model, DEFAULT_LLM_PROVIDER)) return null;
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

/**
 * The options of a job on the operator's key (#280): the operator's model of the project's tier replaces the project's
 * model (Diff) or Dynamic model, the workspace's fallback model is dropped, and the project's token budget stays (it is
 * clamped to the model's window when the job's input is built). Everything else (the tool options, the Dynamic skill
 * and limits) is the project's. What the workspace named never reaches the runner.
 */
function withTierModel(
  options: JobOptions,
  kind: ProjectReviewKind,
  model: string,
): JobOptions {
  const maxTokens = options.llm?.maxTokens;
  return {
    env: options.env,
    llm: { model, ...(maxTokens == null ? {} : { maxTokens }) },
    ...(kind === "dynamic" && options.dynamic !== undefined
      ? { dynamic: { ...options.dynamic, model } }
      : {}),
  };
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
    !isModelId(dynamic.model, DEFAULT_LLM_PROVIDER) ||
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
 * review of the same kind (#199), or null; `attemptedShas` are the heads of the earlier jobs that did
 * not succeed (#255, left out when there are none) and `attemptedShasTruncated` (#257) says the list was
 * cut, left out unless true. Nothing here is a permission or an endpoint.
 */
function claimBaseOf(
  repositoryFullName: string,
  baseRef: string,
  headSha: string,
  previousReviewedSha: string | null,
  attempted: AttemptedShas,
): ClaimBase {
  return {
    repository: repositoryFullName,
    baseRef,
    headSha,
    previousReviewedSha,
    // Left out when empty or false: a runner from before #255/#257 has a closed job contract and
    // rejects a key it does not know.
    ...(attempted.shas.length === 0 ? {} : { attemptedShas: attempted.shas }),
    ...(attempted.truncated ? { attemptedShasTruncated: true } : {}),
    comparison: "full",
  };
}

type ModelCapabilitiesDecision =
  | { kind: "send"; capabilities: DynamicModelCapabilities }
  /** Nothing is sent: the runner's own descriptor applies, exactly as without this feature. */
  | { kind: "none" }
  | { kind: "unsupported" };

/**
 * #279: what the provider's metadata says about the job's Dynamic model (`result`, read by the caller when the claim is
 * built: a short cache sits in front of the provider, so this is not a request per claim). Three outcomes:
 *
 * - A model whose metadata says it cannot do what Dynamic Review needs ends the job, whatever runner claimed it, before
 *   any credential exists.
 * - Metadata that cannot be read (provider unreachable, model unknown to it, no usable window) sends nothing and the
 *   claim goes on: the runner falls back to its own descriptor, and nothing is invented.
 * - Otherwise the descriptor goes to a runner that advertised `dynamic_capabilities` and only to such a runner: the
 *   job input of a previous-release runner is closed and would refuse the key.
 */
function modelCapabilitiesOf(
  deps: ClaimDeps,
  job: Job,
  result: ModelCapabilityResult | undefined,
  features: readonly ClaimFeature[],
): ModelCapabilitiesDecision {
  if (result === undefined) return { kind: "none" };
  if (result.outcome === "unsupported") return { kind: "unsupported" };
  const fallback = (why: string): ModelCapabilitiesDecision => {
    deps.logger.info(
      `[runner-api] job=${job.id} model capabilities not read (${why}); the runner's own descriptor applies`,
    );
    return { kind: "none" };
  };
  if (result.outcome !== "supported") return fallback(result.outcome);
  const capabilities = dynamicCapabilitiesOf(result.capabilities);
  if (capabilities === null) return fallback("no_usable_context_window");
  if (!features.includes("dynamic_capabilities")) return { kind: "none" };
  deps.logger.info(`[runner-api] job=${job.id} model capabilities sent`);
  return { kind: "send", capabilities };
}

/** The context window of a model the provider's metadata states, or null (it was not read, or states none). */
function contextWindowOf(
  result: ModelCapabilityResult | undefined,
): number | null {
  if (result === undefined) return null;
  return result.outcome === "supported" || result.outcome === "unsupported"
    ? result.capabilities.contextLength
    : null;
}

/** How `checkJob` is asked. */
export type CheckOptions = {
  /**
   * The engines the claimant advertised. A Dynamic job needs `opencode`. `null` when that was already
   * decided at claim (the Worker's fetch): the job is Dynamic because the claim allowed it.
   */
  engines: readonly RunnerEngine[] | null;
  /**
   * What a pull request that cannot be read means. At claim (false) every failure but "not found" gives
   * the job back to try later, as it always did. At the Worker's fetch (true) a permanent failure of the
   * connection (the installation was removed, the app is suspended, the scope was refused) ends the job
   * with its stable code instead, like the same failure when the credentials are created.
   */
  classifyReadFailures: boolean;
};

/**
 * Steps 1 to 3 of the module comment: the guard, the LLM access, the options of the job and the pull
 * request. Nothing here creates or reveals a credential of the job.
 */
export async function checkJob(
  deps: ClaimDeps,
  job: Job,
  { engines, classifyReadFailures }: CheckOptions,
): Promise<Checked | Refusal> {
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

  await deps.recordKeyMode(job, keyModeOfAccessSource(llm.source));

  const command = commandOf(job);
  if (command === null) return refuse("job_args_invalid");
  // On the operator's own key the operator chooses the model, never the tenant (#276): the workspace chooses a tier
  // (#280) and the model is the one the operator configured for that tier and this kind of review. The model and
  // fallback model of the review settings stay stored without taking effect. A tier without a model fails the job
  // closed: no silent move to another tier, and not to the instance's default model either. A workspace on its own
  // key is untouched: its settings apply and the tier is ignored.
  const stored = await deps.jobOptions.optionsFor(job);
  let options = stored;
  let tier: Checked["tier"] = null;
  if (llm.source === "operator") {
    const name = stored.modelTier ?? DEFAULT_MODEL_TIER;
    await deps.recordModelTier(job, name);
    const model = await deps.modelTiers.modelFor(name, job.reviewKind);
    // The log names the tier and the kind, never a model.
    if (model === null)
      return refuse(
        "managed_tier_unavailable",
        `tier=${name} kind=${job.reviewKind}`,
      );
    tier = { name, model };
    options = withTierModel(stored, job.reviewKind, model);
  }
  if (Object.keys(options.env).some((key) => !RUNNER_ENV_KEY_PATTERN.test(key)))
    return refuse("job_env_invalid");
  const llmOptions = llmOptionsOf(options);
  if (llmOptions === null) return refuse("job_llm_options_invalid");

  // #195: a Dynamic job is only built for a runner that advertised `opencode`, and it must carry the
  // project's Dynamic options. Both are checked before any credential is created.
  const dynamic =
    job.reviewKind === "dynamic" ? dynamicOptionsOf(options) : null;
  if (job.reviewKind === "dynamic") {
    if (engines !== null && !engines.includes("opencode"))
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
    if (
      classifyReadFailures &&
      error instanceof IntegrationError &&
      !error.retryable &&
      error.code.startsWith("INTEGRATION_ACCESS_")
    )
      return refuse(accessFailureCode(error));
    return {
      kind: "retry",
      reason: "pull_request_unavailable",
      retryAfterSeconds: retryAfterOf(error),
    };
  }

  return {
    kind: "checked",
    llm,
    command,
    options,
    llmOptions,
    dynamic,
    integration,
    repo,
    prUrl,
    baseRef,
    tier,
  };
}

/**
 * Step 4 of the module comment, the only place that creates credentials for a job: the model's
 * capabilities (#279), the git credentials for exactly this repository, and the job's input with the
 * key revealed. Both the legacy claim and the Worker's fetch call it. The revealed copy is a plain
 * object that only lives until the response is built.
 */
export async function buildJobInput(
  deps: ClaimDeps,
  job: Job,
  checked: Checked,
  features: readonly ClaimFeature[],
): Promise<Built | Refusal> {
  const {
    llm,
    command,
    options,
    llmOptions,
    dynamic,
    integration,
    repo,
    tier,
  } = checked;
  const provider = deps.registry.resolve(integration.type);

  // #279: the model's capabilities. The read can wait on the provider, so it comes after every cheap
  // local refusal above, and still before the git credentials are created. A job on a managed tier (#280) reads
  // its model's metadata too, Diff or Dynamic, for the context window its token budget is clamped to: one read
  // serves both (a Dynamic job's model is the tier's).
  const modelToRead = dynamic !== null ? dynamic.model : (tier?.model ?? null);
  // The claim of a managed job asks as a claim (an outage costs one wait, not one per claim) and names the tier in the
  // log line instead of the model.
  const metadata =
    modelToRead === null || deps.modelCapabilities === undefined
      ? undefined
      : await deps.modelCapabilities.check(
          modelToRead,
          tier === null ? {} : { forClaim: true, logAs: `tier=${tier.name}` },
        );
  let capabilities: DynamicModelCapabilities | undefined;
  if (dynamic !== null) {
    const decision = modelCapabilitiesOf(deps, job, metadata, features);
    if (decision.kind === "unsupported")
      return refuse("dynamic_model_features_unsupported");
    if (decision.kind === "send") capabilities = decision.capabilities;
  }

  // The one place that creates credentials for a job.
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
  // The workspace's own key: its budget, else the instance's context window. A managed job: the workspace's budget
  // (the instance's window belongs to another model), cut to the window of the tier's model when that is known
  // (#280), else to the window last read for it, else to a documented bound: never sent unclamped. The workspace
  // cannot know the model, so its settings are not checked against it.
  const maxTokens =
    tier === null
      ? (llmOptions.maxTokens ?? llmAccess.contextWindowTokens)
      : clampMaxTokens(
          llmOptions.maxTokens ?? UNKNOWN_WINDOW_MAX_TOKENS,
          contextWindowOf(metadata) ??
            deps.modelCapabilities?.lastKnownContextLength?.(tier.model) ??
            null,
        );
  // #199: the head of the last successful Dynamic review of this pull request, so the dynamic job
  // can compare against it. A Diff job never carries a base, so it is not looked up.
  const previousReviewedSha =
    job.reviewKind === "dynamic" ? await deps.previousReviewedSha(job) : null;
  const attempted: AttemptedShas =
    job.reviewKind === "dynamic"
      ? await deps.attemptedShas(job)
      : { shas: [], truncated: false };
  // The exact legacy Diff payload for every Diff job, whatever kind of runner asked: the keys are in
  // the order the previous release wrote them, byte for byte (prUrl, command, git, llm, env;
  // llm.provider, model, apiKey, maxTokens), so a golden serialization matches. A Dynamic job is only
  // ever handed to a runner that advertised `opencode`, so its tagged fields never reach an old runner.
  const input: RunnerJobInput =
    dynamic === null
      ? {
          prUrl: checked.prUrl,
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
          prUrl: checked.prUrl,
          command,
          reviewKind: "dynamic",
          dynamic:
            capabilities === undefined ? dynamic : { ...dynamic, capabilities },
          base: claimBaseOf(
            repo.fullName,
            checked.baseRef,
            job.headSha,
            previousReviewedSha,
            attempted,
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
    kind: "built",
    input,
    tokenExpiresAt: git.expiresAt,
    tierModel: tier?.model ?? null,
  };
}

async function prepare(
  deps: ClaimDeps,
  claimed: NonNullable<ClaimResult>,
  engines: readonly RunnerEngine[],
  features: readonly ClaimFeature[],
  split: boolean,
): Promise<Prepared> {
  const { job, leaseToken } = claimed;
  const checked = await checkJob(deps, job, {
    engines,
    classifyReadFailures: false,
  });
  if (checked.kind !== "checked") return checked;

  // #320: a Dispatcher gets the per-job credential and nothing of the job's input; the Worker fetches
  // that (and with it the git token and the model key) with the credential.
  if (split) {
    if (claimed.credential === undefined)
      throw new Error(`Claim of job ${job.id} has no credential.`);
    if (job.leaseExpiresAt === null)
      throw new Error(`Claimed job ${job.id} has no lease expiry.`);
    return {
      kind: "split",
      response: {
        version: RUNNER_API_VERSION,
        job: {
          id: job.id,
          credential: claimed.credential,
          reviewKind: job.reviewKind,
          leaseExpiresAt: job.leaseExpiresAt,
          heartbeatIntervalSeconds: deps.heartbeatIntervalSeconds,
        },
      },
    };
  }

  const built = await buildJobInput(deps, job, checked, features);
  if (built.kind !== "built") return built;
  if (job.leaseExpiresAt === null)
    throw new Error(`Claimed job ${job.id} has no lease expiry.`);
  return {
    kind: "ready",
    tierModel: built.tierModel,
    response: {
      version: RUNNER_API_VERSION,
      job: {
        id: job.id,
        leaseToken,
        leaseExpiresAt: job.leaseExpiresAt,
        heartbeatIntervalSeconds: deps.heartbeatIntervalSeconds,
        tokenExpiresAt: built.tokenExpiresAt,
        input: built.input,
      },
    },
  };
}

/**
 * Who a job is ended for, as the log names it: the claim of a runner (`claim runner=a`, stage `claim`)
 * or the fetch of a Worker (`fetch worker`, stage `fetch`, #320). Never a secret.
 */
export type Origin = { label: string; stage: "claim" | "fetch" };

/** Ends a claimed job as failed with a code; the runner is not told. Throws if the queue fails. */
export async function endJob(
  deps: ClaimDeps,
  claimed: NonNullable<ClaimResult>,
  origin: Origin,
  errorCode: string,
  detail?: string,
): Promise<"ended" | "not_holder"> {
  const result = await deps.queue.complete(claimed.job.id, claimed.leaseToken, {
    ok: false,
    errorCode,
  });
  if (result.status !== "completed") {
    // Not ours any more (the lease ran out in the meantime); whoever holds the job now decides.
    deps.logger.error(
      `[runner-api] ${origin.label} job=${claimed.job.id} could not be ended at ${origin.stage}: ${result.status}`,
    );
    return "not_holder";
  }
  deps.logger.info(
    `[runner-api] ${origin.label} job=${claimed.job.id} ended at ${origin.stage}: ${errorCode}${detail === undefined || detail === "" ? "" : ` (${detail})`}`,
  );
  return "ended";
}

/**
 * Ends a claimed job as cancelled, the way a deactivation ends a waiting one: one statement fenced by
 * the lease token (`cancelClaimed`), no attempt counted, never queued in between. Only this job is
 * touched; the other waiting jobs of the repository were cancelled by the deactivation. Throws if the
 * queue fails; the caller gives the job back.
 */
export async function cancelJob(
  deps: ClaimDeps,
  claimed: NonNullable<ClaimResult>,
  origin: Origin,
  errorCode: JobErrorCode,
): Promise<"cancelled" | "not_holder"> {
  const result = await deps.queue.cancelClaimed(
    claimed.job.id,
    claimed.leaseToken,
    errorCode,
  );
  if (result.status === "not_holder") {
    // Not ours any more (the lease ran out in the meantime); whoever holds the job now decides.
    deps.logger.error(
      `[runner-api] ${origin.label} job=${claimed.job.id} could not be cancelled at ${origin.stage}: not_holder`,
    );
    return "not_holder";
  }
  deps.logger.info(
    `[runner-api] ${origin.label} job=${claimed.job.id} cancelled at ${origin.stage}: ${errorCode}`,
  );
  return "cancelled";
}

/** Gives the job back after an unexpected failure, so it is not stuck under a lease nobody uses. */
export async function giveBack(
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
  features: readonly ClaimFeature[] = [],
  target: { jobId?: string; maxRunning?: number } = {},
): Promise<Response> {
  // #320: a Dispatcher names `worker_credential` and gets a per-job credential instead of the input.
  const split = features.includes("worker_credential");
  const origin: Origin = { label: `claim runner=${runnerId}`, stage: "claim" };
  for (let refused = 0; refused < MAX_REFUSED_PER_REQUEST; refused += 1) {
    // #322: `jobId` and `maxRunning` are passed to the queue only when the caller sent them, so the
    // claim of a runner of the previous release makes exactly the call it made before.
    const claimOptions: ClaimOptions = {
      ...(split ? { workerCredential: true } : {}),
      // #397: a Dispatcher is not the holder; its Worker says so with its job details request.
      ...(!split && features.includes("supersede")
        ? { acceptsSupersede: true }
        : {}),
      ...(target.jobId === undefined ? {} : { jobId: target.jobId }),
      ...(target.maxRunning === undefined
        ? {}
        : { maxRunning: target.maxRunning }),
    };
    const claimed =
      Object.keys(claimOptions).length > 0
        ? await deps.queue.claimNext(runnerId, engines, claimOptions)
        : await deps.queue.claimNext(runnerId, engines);
    if (claimed === null) return noContent();

    // Whatever goes wrong from here on, the job is given back instead of staying under a lease that
    // nobody uses (it would only run out after two minutes).
    try {
      const prepared = await prepare(deps, claimed, engines, features, split);

      if (prepared.kind === "refused") {
        await endJob(
          deps,
          claimed,
          origin,
          prepared.errorCode,
          prepared.detail,
        );
        continue;
      }

      if (prepared.kind === "cancelled") {
        await cancelJob(deps, claimed, origin, prepared.errorCode);
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
          `[runner-api] ${origin.label} job=${claimed.job.id} given back: ${prepared.reason}`,
        );
        return errorResponse(503, "RUNNER_GIT_ACCESS_UNAVAILABLE", {
          retryAfterSeconds: prepared.retryAfterSeconds,
        });
      }

      if (prepared.kind === "split") {
        // The credential is in the response and nowhere else: not in the log line, not in the database.
        deps.logger.info(
          `[runner-api] ${origin.label} job=${claimed.job.id} command=${claimed.job.command} credential issued`,
        );
        return jsonResponse(200, prepared.response);
      }

      // Before the key leaves with the response: if it cannot be remembered, the job is given back (below)
      // and no runner has the key.
      await deps.claimedKeys.remember(
        claimed.job.id,
        prepared.response.job.input.llm.apiKey,
      );
      if (prepared.tierModel !== null)
        await deps.claimedKeys.rememberModel(
          claimed.job.id,
          prepared.tierModel,
        );
      deps.logger.info(
        `[runner-api] ${origin.label} job=${claimed.job.id} command=${claimed.job.command}`,
      );
      return jsonResponse(200, prepared.response);
    } catch (error) {
      deps.logger.error(
        `[runner-api] ${origin.label} job=${claimed.job.id} failed: ${describeError(error)}`,
      );
      await giveBack(deps, claimed, "claim_failed");
      return errorResponse(500, "RUNNER_INTERNAL_ERROR");
    }
  }
  // Many jobs in a row ended at claim time; let the runner ask again instead of holding the request.
  return noContent();
}
