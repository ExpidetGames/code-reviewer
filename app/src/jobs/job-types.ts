// SPDX-License-Identifier: Apache-2.0

// The vocabulary of the job queue: what a job is and what goes in and out. Everything here is plain
// data; the rules live in job-status.ts, job-input.ts and job-queue.ts.
import type {
  ReviewCommand,
  StoredReviewCommand,
} from "../integrations/types.ts";
import type { JsonValue } from "../integrations/types.ts";
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import type { JobStatus } from "./job-status.ts";

/**
 * What started a job. `webhook` is automatic (a pull request was opened or updated); `comment` is a
 * command written in a pull request; `manual` is the start button in the UI. Stored in the
 * database, so a value is never renamed or reused.
 */
export const JOB_TRIGGER_KINDS = ["webhook", "comment", "manual"] as const;
export type JobTriggerKind = (typeof JOB_TRIGGER_KINDS)[number];

/** A job as the rest of the app sees it. Timestamps are ISO 8601 text in UTC. */
export type Job = {
  id: string;
  /** The workspace of the job's repository; the runner API scopes everything it looks up with it. */
  workspaceId: string;
  repositoryId: string;
  prNumber: number;
  prUrl: string;
  /** The head commit of the pull request when the job was created (a reference, not a promise). */
  headSha: string;
  /**
   * The review kind the job was queued for (#195): `diff` runs PR-Agent, `dynamic` runs the
   * read-only agent. It is pinned when the job is enqueued from the project's settings, so a later
   * kind change cancels this waiting job instead of running it under the wrong engine.
   */
  reviewKind: ProjectReviewKind;
  /** The command of the job. Historical rows may still carry a removed one (#203). */
  command: StoredReviewCommand;
  /** Text after the command; an empty string when there is none. Untrusted: it comes from a comment. */
  args: string;
  triggerKind: JobTriggerKind;
  /** The login of the person or bot that caused the job. */
  actorLogin: string;
  /** The webhook delivery that created the job; null for a manual job. */
  deliveryId: string | null;
  status: JobStatus;
  /** The job is not handed out before this moment. */
  runAfter: string;
  /** How many attempts were lost (lease ran out, claim given back). */
  attempts: number;
  runnerId: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  /** What the runner reported, when the job succeeded (or failed with details). */
  result: JsonValue | null;
  /** Why the job did not succeed (see JOB_ERROR_CODES), or why it was cancelled. */
  errorCode: string | null;
  /** The newer job that replaced this one, when its status is `superseded`. */
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** When the job reached a final status. */
  finishedAt: string | null;
};

export type EnqueueJobInput = {
  repositoryId: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  /**
   * The review kind the job runs (#195). Test-only: no producer sets it. The queue resolves the kind
   * from the project's settings inside the enqueue transaction through the one shared resolver
   * (`review-kind.ts`), so no entry point can choose it. Left out, the stored kind applies; a project
   * that never chose one is `diff`.
   */
  reviewKind?: ProjectReviewKind;
  command: ReviewCommand;
  /** Defaults to an empty string. */
  args?: string;
  triggerKind: JobTriggerKind;
  actorLogin: string;
  /** The webhook delivery the job comes from; makes the enqueue idempotent per delivery. */
  deliveryId?: string | null;
  /**
   * The comment the command was written in, for a `comment` job. The comment is recorded with the
   * job that answers it (a new one, or an equal one that was already waiting or running), and the
   * same comment never gets a second job (`same_comment`), however often and under whatever
   * delivery id it arrives.
   */
  commentId?: string | null;
  /** Defaults to now. A later `runAfter` holds the job back (a job given back with a retry time). */
  runAfter?: Date;
};

/** Why `enqueue` returned an existing job instead of creating one. */
export const ENQUEUE_EXISTING_REASONS = [
  /** The same delivery was enqueued before (a redelivery or a second request). */
  "same_delivery",
  /** A job for this comment was created before (a replayed delivery under another delivery id). */
  "same_comment",
  /** An automatic job for this head commit and command already exists. */
  "same_head",
  /** A waiting or running job for this pull request and command already exists. */
  "already_active",
] as const;
export type EnqueueExistingReason = (typeof ENQUEUE_EXISTING_REASONS)[number];

export type EnqueueResult =
  | {
      status: "created";
      job: Job;
      /** The waiting jobs the new one replaced. */
      supersededJobIds: string[];
    }
  | { status: "existing"; job: Job; reason: EnqueueExistingReason };

/** What a runner reports when it is done with a job. */
export type JobOutcome =
  | { ok: true; result: JsonValue }
  | { ok: false; errorCode: string; result?: JsonValue };

/** The stable codes the queue itself puts into `error_code`. The runner adds its own on failure. */
export const JOB_ERROR_CODES = [
  /** The lease ran out on the last allowed attempt. */
  "lease_expired",
  /** The job ran longer than the hard timeout plus the grace period. */
  "timeout",
  /** Cancelled because the project was deactivated. */
  "project_deactivated",
  /** Cancelled because the pull request was closed. */
  "pull_request_closed",
  /** Cancelled because the pull request was turned into a draft (automatic jobs only). */
  "pull_request_draft",
  /** Cancelled because the project's review kind changed while the job was waiting (#195). */
  "review_kind_changed",
  /** Cancelled because no runner that can run this job claimed it within the deadline (#195). */
  "no_capable_runner",
  /** Failed because Dynamic Review is not enabled on this instance yet (#195 rollout gate). */
  "dynamic_review_disabled",
  /** Cancelled because the job's command was removed from the product (#203). */
  "command_removed",
  /** Failed because no Dispatcher took the job within the give-up time of a hosted deployment (#328). */
  "dispatch_unavailable",
  /** Failed at claim because an operator suspended the workspace's reviews (#277). */
  "workspace_suspended",
  /** Failed at claim because the workspace used up a limit of its period (#277; the log names which). */
  "quota_exhausted",
  /** Failed at claim because the workspace's entitlements could not be read; never treated as unlimited (#277). */
  "entitlements_invalid",
] as const;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

export type HeartbeatResult =
  | { status: "ok"; job: Job }
  /**
   * #397: a newer push replaced this run. The claim is still valid for the drain window, so the holder can finish
   * the model requests in flight and report what they cost; its lease is not extended. The holder must stop
   * sending model requests and publish nothing.
   */
  | { status: "superseded"; job: Job }
  /**
   * The caller does not hold the job: its lease token is not the current one (the lease was lost and
   * the job requeued or handed on, even to the same runner id), the job is finished, or it ran past
   * the hard limit (it is failed with `timeout` by this very call). The runner must stop.
   */
  | { status: "not_holder" };

export type CompleteResult =
  | { status: "completed"; job: Job }
  /** The same outcome was reported before; nothing changed. */
  | { status: "already_completed"; job: Job }
  /** The job was completed before with a different outcome. */
  | { status: "outcome_conflict"; job: Job }
  | { status: "not_holder" };

/** #320: what counting a fetch of the job details of a claim answered. */
export type CountFetchResult =
  /** One more fetch is counted; the Worker may go on. */
  | "counted"
  /** The claim holds, but its fetches are used up. */
  | "exhausted"
  /** The caller does not hold the job (any more). */
  | "not_holder";

export type CancelClaimedResult =
  { status: "cancelled"; job: Job } | { status: "not_holder" };

export type ReleaseResult =
  /** The job is waiting again with one more lost attempt. */
  | { status: "requeued"; job: Job }
  /** That was the last allowed attempt: the job is failed with the given reason. */
  | { status: "failed"; job: Job }
  /** The job carried a removed command (#203) and was cancelled instead of requeued. */
  | { status: "cancelled"; job: Job }
  | { status: "not_holder" };

/**
 * A claimed job and the proof that the caller holds it. The lease token is random, new for every
 * claim and cleared when the job is requeued, so a stale execution of the same job (even by the same
 * runner id) can no longer heartbeat, complete or release it. It is deliberately not part of `Job`:
 * it is handed to the holder once and never listed or logged.
 */
export type ClaimResult = {
  job: Job;
  /**
   * What the queue fences the claim on. For a claim made with `workerCredential` this is the stored
   * (hashed) form of the credential, never the credential itself.
   */
  leaseToken: string;
  /**
   * #320: the per-job credential of a claim made with `workerCredential`, shown here once so the
   * claim response can hand it out. It is not stored anywhere: the database keeps only its hash.
   */
  credential?: string;
} | null;
