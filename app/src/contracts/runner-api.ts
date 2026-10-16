// SPDX-License-Identifier: Apache-2.0

// Generated from contracts/runner-api.v1.json. Do not edit: change the schema and run `make generate-contracts`.
// `make verify` fails while this file differs from what the schema generates.

/**
 * ISO 8601, UTC.
 */
export type Timestamp = string;
/**
 * The id of a job (a UUID).
 */
export type JobId = string;
/**
 * Proof that the caller holds the job. New for every claim; required by heartbeat and complete. Secret: never log it.
 */
export type LeaseToken = string;
/**
 * The commands the product executes. Since the removal of /ask, /improve and /describe only /review exists (a historical run keeps its original command in the database, never on the wire).
 */
export type Command = "review";
/**
 * An engine a runner can run and may advertise in a claim (#195). pr-agent runs Diff Review, opencode runs Dynamic Review. An empty legacy claim means pr-agent only; a runner only advertises an engine its fail-closed startup self-check proved.
 */
export type Engine = "pr-agent" | "opencode";
/**
 * The review kind a job was queued for (#195), pinned at enqueue time. Absent on a legacy Diff payload means diff. A runner is only handed a job whose kind one of its engines can run, and a Dynamic job is never silently run by PR-Agent.
 */
export type ReviewKind = "diff" | "dynamic";
/**
 * The claim features this version of the contract defines (`features` in ClaimRequest). A reader ignores a feature name it does not know. `dynamic_capabilities` (#279): the runner reads `dynamic.capabilities`. `worker_credential` (#318): the caller is a Dispatcher and wants the split answer; the job input and its secrets reach only the Worker, with the per-job credential. `supersede` (#396): the runner understands `job.superseded` in a heartbeat answer and stops gracefully (it finishes the model requests in flight, sends no more, publishes nothing, reports its result and usage). The app supersedes a running job only when the claim named it. A Worker names it in the `features` of its details request.
 */
export type KnownClaimFeature =
  "dynamic_capabilities" | "worker_credential" | "supersede";
/**
 * #318: the per-job credential. 256 random bits, base64url without padding, behind the prefix `crj_`. The app mints it at claim; it is valid only for that job and only while the claim holds, and it is the one thing a Worker holds (Authorization: Bearer). Secret: never log it, never put it in an argument, an environment variable or a file; the Dispatcher passes it to the Worker on stdin.
 */
export type WorkerCredential = string;
/**
 * US dollars per million tokens as an exact decimal text (no exponent, no sign), for example "0.02016". Zero is a free model.
 */
export type UnitPrice = string;
/**
 * Why a Dynamic Review checkout failed (CheckoutReason in the runner), reported as errorReason next to the code checkout_incomplete. A caller branches on the reason, never on a message. The app accepts any reason of the form below and shows an unknown one with a general sentence.
 */
export type KnownCheckoutReason =
  | "invalid_request"
  | "ref_moved"
  | "ref_missing"
  | "protocol"
  | "pack_invalid"
  | "object_missing"
  | "tree_invalid"
  | "entries"
  | "path_invalid"
  | "budget_transfer"
  | "budget_preparation"
  | "budget_exposed"
  | "diff_too_large"
  | "input_too_large"
  | "cancelled"
  | "timeout"
  | "transport"
  | "isolation"
  | "context";
/**
 * The error codes the runner reports in a result (ErrorCode in the runner, plus runner_shutdown from the job loop). A caller branches on the code, never on a message. The app accepts any code of the form below and stores an unknown one as 'unknown' (the original stays in the stored result), so a newer runner never loses a result.
 */
export type KnownRunnerErrorCode =
  | "invalid_job"
  | "invalid_command"
  | "pr_agent_version_mismatch"
  | "identity_patch_failed"
  | "runner_error"
  | "command_failed"
  | "review_not_published"
  | "review_state_truncated"
  | "review_text_truncated"
  | "pr_not_found"
  | "git_auth"
  | "git_forbidden"
  | "git_rate_limit"
  | "git_unavailable"
  | "git_unprocessable"
  | "git_provider_init"
  | "llm_auth"
  | "llm_quota"
  | "llm_rate_limit"
  | "llm_timeout"
  | "llm_unavailable"
  | "llm_bad_request"
  | "llm_context_length_exceeded"
  | "llm_output_invalid"
  | "model_unknown"
  | "timeout"
  | "runner_shutdown"
  | "unknown"
  | "dynamic_engine_unavailable"
  | "dynamic_isolation_self_check_failed"
  | "dynamic_config_invalid"
  | "checkout_incomplete"
  | "dynamic_policy_violation"
  | "dynamic_budget_exceeded"
  | "dynamic_accounting_failed"
  | "dynamic_model_features_unsupported"
  | "lease_lost"
  | "superseded";
/**
 * Exactly the job the runner reads on stdin (see runner/src/code_reviewer_runner/job.py). Closed: the runner refuses unknown fields. Contains secrets (git.token, llm.apiKey): only the claim response carries it.
 */
export type RunnerJobInput = {
  [k: string]: unknown;
} & {
  prUrl: string;
  command: Command;
  reviewKind?: ReviewKind;
  dynamic?: DynamicReview;
  base?: ClaimBase;
  /**
   * Legacy field of the removed /ask command. A previous release may send it; the runner accepts and ignores it and never hands it to PR-Agent. This app sends no args.
   *
   * @maxItems 1
   */
  args?: [] | [string];
  git: {
    provider: "github";
    baseUrl: string;
    token: string;
    botLogin: string;
  };
  llm: {
    provider: "openrouter";
    model: string;
    apiKey: string;
    baseUrl?: string;
    /**
     * The token budget of a review (it also bounds the fallback models, so it must fit the smallest window of the chain).
     */
    maxTokens?: number;
    /**
     * Models to try, in order, when the main model fails. Optional; the app does not send it in the MVP (no fallback chain is decided), the runner accepts it.
     *
     * @maxItems 5
     */
    fallbackModels?:
      | []
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string];
  };
  env: JobEnv;
};
/**
 * What the runner prints when a job ends (the output of code-reviewer-run-job), plus an optional errorMessage. The runner has redacted secrets from logTail; the app removes anything that still looks like one before it stores the result.
 */
export type RunnerResult = {
  ok: boolean;
  durationMs: number;
  /**
   * Link to the comment PR-Agent wrote; null when it could not be found (the run is still ok). A failed result may carry it too: review_state_truncated and review_text_truncated report a review that was posted but shortened.
   */
  commentUrl?: string | null;
  /**
   * null if and only if ok is true. See KnownRunnerErrorCode.
   */
  errorCode: string | null;
  /**
   * Optional stable finer name of a failure, never free text. For a Dynamic Review checkout failure it is one of KnownCheckoutReason. Absent when the runner gave none; the app stores only a name of the form below.
   */
  errorReason?: string | null;
  /**
   * Optional human readable detail for a failure; never contains secrets.
   */
  errorMessage?: string | null;
  logTail: string;
  logTruncated?: boolean;
  /**
   * What the run used. A failed result carries it too, whenever the run made at least one model call before it failed (a timeout at the end, an answer the validator refuses, a publish error): the app counts such a run exactly like a successful one. A run that failed before its first model call reports null. The cost follows the same rule as for a successful run: exact, or null when any call is unpriced; the token counters are reported either way.
   */
  usage?: RunnerUsage | null;
  [k: string]: unknown;
};
/**
 * Why a Dispatcher gives a claimed job back. `launch_failed`: the Worker could not be started. `worker_exited`: the Worker was started and its container ended with a non-zero exit code before it reported a result (#375); the call is a no-op (409 RUNNER_JOB_ENDED, or 401 for a claim that is gone) when the job already has its result or another claim holds it. Either way the app counts a lost attempt (three attempts, then the job fails, with the reason as its error code). A reader accepts any reason of the right form (ReleaseRequest) and treats an unknown one like launch_failed, so an app that does not know `worker_exited` still gives the job back.
 */
export type KnownReleaseReason = "launch_failed" | "worker_exited";
/**
 * The features an app lists in VersionResponse.features. A reader ignores a name it does not know and refuses to run against an app that lacks one it needs. `worker_api`: /api/workers/v1 exists. `claim_by_job_id`: ClaimRequest.jobId is honoured. `pool_cap`: ClaimRequest.maxRunning is honoured. `release`: the release call exists.
 */
export type KnownAppFeature =
  "worker_api" | "claim_by_job_id" | "pool_cap" | "release";
/**
 * Every error of the API has one of these codes. 401 RUNNER_UNAUTHORIZED, 400 RUNNER_ID_INVALID / RUNNER_REQUEST_INVALID, 404 RUNNER_JOB_NOT_FOUND, 409 RUNNER_LEASE_LOST / RUNNER_RESULT_CONFLICT, 413 RUNNER_BODY_TOO_LARGE, 503 RUNNER_GIT_ACCESS_UNAVAILABLE (with Retry-After), 500 RUNNER_INTERNAL_ERROR. #318 adds 401 WORKER_CREDENTIAL_INVALID (a Worker route got a credential that is not the job's: wrong job, unknown, expired or from an earlier claim; also the fourth call of the details route in one claim, whose three calls are spent: the Worker has nothing left to fetch and stops, the claim itself is not lost) and 409 RUNNER_JOB_ENDED (the app ended the job, for example after a permanent access failure at fetch; the Worker stops).
 */
export type ApiErrorCode =
  | "RUNNER_UNAUTHORIZED"
  | "RUNNER_ID_INVALID"
  | "RUNNER_REQUEST_INVALID"
  | "RUNNER_JOB_NOT_FOUND"
  | "RUNNER_LEASE_LOST"
  | "RUNNER_RESULT_CONFLICT"
  | "RUNNER_BODY_TOO_LARGE"
  | "RUNNER_GIT_ACCESS_UNAVAILABLE"
  | "RUNNER_INTERNAL_ERROR"
  | "WORKER_CREDENTIAL_INVALID"
  | "RUNNER_JOB_ENDED";

/**
 * The optional body of POST /api/runners/v1/claim (#195): the engines the calling runner can run. Absent or empty means ['pr-agent'] (a previous-release runner). Unknown or duplicated engine names are refused with 400 RUNNER_REQUEST_INVALID before any job is claimed. #279 adds the optional `features`: what else this runner understands. The app sends a job optional fields a previous-release runner would reject (the job input is closed) only to a runner that names the matching feature, so `dynamic_capabilities` means the runner reads `dynamic.capabilities`. Unknown feature names are ignored, so a newer runner can name features an older app does not know. Unknown fields are ignored, as everywhere in v1. #318 adds the Dispatcher's fields: `jobId` claims exactly that job (anything else, such as a job that is not due, already running, finished, cancelled or of a kind the advertised engines cannot run, is 204), `maxRunning` is the pool cap (the claim is 204 while that many jobs of the same X-Runner-Id are running), and the feature `worker_credential` selects the split answer (SplitClaimResponse: a per-job credential and no job input). Without that feature the answer is the legacy ClaimResponse, unchanged.
 */
export interface ClaimRequest {
  /**
   * @minItems 1
   * @maxItems 2
   */
  engines?: [Engine] | [Engine, Engine];
  /**
   * @maxItems 16
   */
  features?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
  /**
   * #318: claim exactly this job (a Dispatcher woken by the dispatch webhook). Absent: the next due job, as before.
   */
  jobId?: string;
  /**
   * #318: the pool cap. The app counts the running jobs whose X-Runner-Id equals this request's and answers 204 at or above the cap, inside the claim transaction.
   */
  maxRunning?: number;
  [k: string]: unknown;
}
/**
 * #195: the Dynamic options of a tagged job. Model, skill and the output limit only. A closed object: there is no fixed core, permission, executable command, endpoint or upstream URL here, so a job can never widen what the read-only agent may do. The skill is literal data.
 */
export interface DynamicReview {
  model: string;
  skill: string;
  limits: {
    maxFindings: number;
  };
  capabilities?: DynamicModelCapabilities;
}
/**
 * #279: what the app read from the provider's public metadata about the job's Dynamic model, so any tool-capable model runs without the operator describing it. Optional, and sent only to a runner that advertised the `dynamic_capabilities` feature in its claim. It comes from the app, never from the repository or the model. The runner can only narrow with it: it is intersected with the operator's RUNNER_DYNAMIC_CAPABILITIES (both booleans must hold, the smaller number wins for the limits, the higher unit price wins) and never widens what that allows. `maxOutputTokens` is the output allowance of one call, chosen by the app within the model's stated limit. The two unit prices come together or not at all; a model without them (outside the runner's built-in default) is refused by the runner with dynamic_config_invalid. A closed object.
 */
export interface DynamicModelCapabilities {
  toolChoiceRequired: boolean;
  structuredOutput: boolean;
  maxOutputTokens: number;
  contextWindowTokens: number;
  inputUsdPerMtok?: UnitPrice;
  outputUsdPerMtok?: UnitPrice;
}
/**
 * #195: the checkout facts a Dynamic job carries, pinned when the job was queued or claimed and bounded. `headSha` is the exact queued head; `baseRef` is the branch the pull request merges into (the exact base SHA is resolved during checkout, #196). `previousReviewedSha` is the head of the last successful review of the same kind (#199), or null. `attemptedShas` (#255, optional: absent means none, and the app leaves it out when empty) are the heads of the earlier jobs of the pull request that ran and did not succeed, newest first; the publisher accepts such a head as the state of the summary comment, because a run may have written it and then ended without success. `attemptedShasTruncated` (#257, optional: absent means false, and the app leaves it out unless it is true) says that more heads qualified than the list holds; only then does the publisher rewrite a bot-owned summary whose state head it cannot account for, with a full review, instead of refusing it. `comparison` is the *declared* mode: a hint for preparation, never proof that the comparison is complete — the checkout verifies that before it trusts it.
 */
export interface ClaimBase {
  repository: string;
  baseRef: string;
  headSha: string;
  previousReviewedSha: string | null;
  /**
   * @maxItems 20
   */
  attemptedShas?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
  attemptedShasTruncated?: boolean;
  comparison: "full" | "incremental";
}
/**
 * Extra options of the PR-Agent tools, as strings. The review tool's options (PR_REVIEWER__*) are used; a previous release's option families for the removed tools (PR_DESCRIPTION__*, PR_CODE_SUGGESTIONS__*, PR_QUESTIONS__*) are accepted for v1 compatibility and ignored. Nothing else is allowed here (credentials, endpoints and the model have their own fields).
 */
export interface JobEnv {
  [k: string]: string;
}
/**
 * 200 from POST /api/runners/v1/claim. 204 without a body means there is nothing to do. Cache-Control is always no-store.
 */
export interface ClaimResponse {
  version: 1;
  job: {
    id: JobId;
    leaseToken: LeaseToken;
    leaseExpiresAt: Timestamp;
    /**
     * How often to send a heartbeat; the lease is several times longer.
     */
    heartbeatIntervalSeconds: number;
    /**
     * When the git token stops working; null if it does not expire.
     */
    tokenExpiresAt: Timestamp | null;
    input: RunnerJobInput;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/*
 */
export interface HeartbeatRequest {
  leaseToken: LeaseToken;
  [k: string]: unknown;
}
/**
 * #397, #396: the numbers behind the supersede of a running run, stated once for both sides; a test on each side compares its own constants with these. They are not part of any request or answer. The Worker learns of the push at its next heartbeat (at most 'maxHeartbeatIntervalSeconds'), tells its process at once, and lets the model requests in flight finish: each takes at most 'longestModelRequestSeconds', so the Worker drains for at most 'workerDrainSeconds' (the same number) and ends its process 'killMarginSeconds' before the lease named in the heartbeat answer, whichever comes first. The app keeps the claim for 'claimSeconds' from the push (heartbeats answer 'superseded', the report is taken), which is the heartbeat interval, the longest request and a margin of 60 seconds. It takes a report for 'reportGraceSeconds' more, the time before which it does not settle the usage record with an unknown cost. A report after that is refused with 409, like a heartbeat. A Worker takes the end of its drain from the 'leaseExpiresAt' of the heartbeat answer that said 'superseded': the app sets the lease of a superseded run once, at the push, to 'claimSeconds' after it, and heartbeats do not extend it.
 */
export interface SupersedeTiming {
  maxHeartbeatIntervalSeconds?: 60;
  longestModelRequestSeconds?: 120;
  workerDrainSeconds?: 120;
  killMarginSeconds?: 20;
  claimSeconds?: 240;
  reportGraceSeconds?: 60;
  [k: string]: unknown;
}
/*
 */
export interface HeartbeatResponse {
  version: 1;
  job: {
    id: JobId;
    heartbeatAt: Timestamp;
    leaseExpiresAt: Timestamp;
    /**
     * #396: true when a newer push replaced this run. Sent only to a claim that named the feature `supersede`; absent means not superseded. The runner finishes the model requests in flight, sends no more, publishes nothing, reports its result (errorCode `superseded`, with usage) and exits.
     */
    superseded?: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/*
 */
export interface RunnerUsage {
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  aiCalls: number;
  fallbackUsed: boolean;
  /**
   * The cost in US dollars, or null when it is not known. A Dynamic Review and a Diff Review report the exact sum of the charges their model provider stated for every call, and null when any call has no stated charge or ended without an answer that could have been billed; neither estimates one from tokens or a price table.
   */
  costUsd: number | null;
  /**
   * Why a Dynamic Review was wrapped up before it was done: the model was asked for its answer right away because the run reached its cost limit or its time limit. Absent or null for a complete run; the review it produced is published and says it may be incomplete.
   */
  stoppedEarly?: "cost_limit" | "time_limit" | null;
  [k: string]: unknown;
}
/**
 * The whole request body must not exceed 65536 bytes (413 otherwise).
 */
export interface CompleteRequest {
  leaseToken: LeaseToken;
  result: RunnerResult;
  [k: string]: unknown;
}
/**
 * 200 for a completion and for the repetition of the same completion (alreadyCompleted: true); a different result for a completed job is 409. A result with errorCode runner_shutdown is not stored: the job is given back (status queued) and a repetition is 409, because the runner no longer holds the job.
 */
export interface CompleteResponse {
  version: 1;
  job: {
    id: JobId;
    /**
     * succeeded or failed: the job is finished. queued: the runner reported runner_shutdown, the job was given back and waits for another runner (it fails instead if that was the last allowed attempt).
     */
    status: "succeeded" | "failed" | "queued";
    [k: string]: unknown;
  };
  alreadyCompleted: boolean;
  [k: string]: unknown;
}
/**
 * #318: 200 from POST /api/runners/v1/claim when the request names the feature `worker_credential`. The job's input, the git token and the model key are not in it: the Worker fetches them with the credential (GET /api/workers/v1/jobs/{id}), so the answer to the Dispatcher carries none of them. The credential itself opens the details call, so whoever holds it can fetch them: the Dispatcher is trusted to hand it to the Worker on stdin and to use it for nothing else (the app does not bind a credential to a process). 204 without a body means there is nothing to do. Cache-Control is always no-store. The credential is a secret.
 */
export interface SplitClaimResponse {
  version: 1;
  job: {
    id: JobId;
    credential: WorkerCredential;
    reviewKind: ReviewKind;
    leaseExpiresAt: Timestamp;
    /**
     * How often the lease must be extended; the Dispatcher heartbeats with the credential until the Worker takes over.
     */
    heartbeatIntervalSeconds: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * #318: POST /api/runners/v1/jobs/{id}/release, with the dispatcher credential (RUNNER_TOKEN) in Authorization and the job credential in the body. Gives the job back to the queue (or fails it on the last attempt).
 */
export interface ReleaseRequest {
  credential: WorkerCredential;
  reason: string;
  /**
   * Do not offer the job again before this many seconds have passed.
   */
  retryAfterSeconds?: number;
  [k: string]: unknown;
}
/**
 * #318: 200 from the release. `queued`: the job waits for another claim; `failed`: that was the last allowed attempt.
 */
export interface ReleaseResponse {
  version: 1;
  job: {
    id: JobId;
    status: "queued" | "failed";
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * #364: 200 from GET /api/runners/v1/jobs/{id} (the dispatcher credential only; a per-job credential is refused). What a Dispatcher asks to decide whether the VM of a job is a leftover: the job's status and nothing else, no job input, lease, repository or credential. `running`: the app holds the job under a lease. Any other status: it does not (`queued` also covers a lease that lapsed and a job that was given back). A reader that meets a status it does not know treats the job as running. An unknown id is 404 RUNNER_JOB_NOT_FOUND. An app of a previous release has no such route (a 404 without an ErrorResponse body); it is not a required feature, so a reader goes on without it.
 */
export interface JobStateResponse {
  version: 1;
  job: {
    id: JobId;
    status:
      | "queued"
      | "running"
      | "succeeded"
      | "failed"
      | "superseded"
      | "cancelled";
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * #318: 200 from GET /api/runners/v1/version (dispatcher credential; #322: a Worker may also send its per-job credential with ?jobId=<its job>, which must be the running claim of that job). Lets a Dispatcher or a Worker detect an app that is too old before it claims anything. An app of a previous release has no such route (404), which means it is too old. `version` is the runner API version; `appVersion` is the build of the app, for logs.
 */
export interface VersionResponse {
  version: 1;
  appVersion: string;
  /**
   * @maxItems 64
   */
  features: string[];
  [k: string]: unknown;
}
/*
 */
export interface ErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    /**
     * For RUNNER_REQUEST_INVALID: which fields were refused and why (never their values).
     */
    fields?: {
      field: string;
      code: "required" | "invalid" | "too_long";
      [k: string]: unknown;
    }[];
    retryAfterSeconds?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
