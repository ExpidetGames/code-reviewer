// The vocabulary of the job queue: what a job is and what goes in and out. Everything here is plain
// data; the rules live in job-status.ts, job-input.ts and job-queue.ts.
import type { ReviewCommand } from "../integrations/types.ts";
import type { JsonValue } from "../integrations/types.ts";
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
  repositoryId: string;
  prNumber: number;
  prUrl: string;
  /** The head commit of the pull request when the job was created (a reference, not a promise). */
  headSha: string;
  command: ReviewCommand;
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
  command: ReviewCommand;
  /** Defaults to an empty string. */
  args?: string;
  triggerKind: JobTriggerKind;
  actorLogin: string;
  /** The webhook delivery the job comes from; makes the enqueue idempotent per delivery. */
  deliveryId?: string | null;
  /** Defaults to now. A debounce is a later `runAfter`. */
  runAfter?: Date;
};

/** Why `enqueue` returned an existing job instead of creating one. */
export const ENQUEUE_EXISTING_REASONS = [
  /** The same delivery was enqueued before (a redelivery or a second request). */
  "same_delivery",
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
] as const;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

export type HeartbeatResult =
  | { status: "ok"; job: Job }
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

export type CancelClaimedResult =
  { status: "cancelled"; job: Job } | { status: "not_holder" };

export type ReleaseResult =
  /** The job is waiting again with one more lost attempt. */
  | { status: "requeued"; job: Job }
  /** That was the last allowed attempt: the job is failed with the given reason. */
  | { status: "failed"; job: Job }
  | { status: "not_holder" };

/**
 * A claimed job and the proof that the caller holds it. The lease token is random, new for every
 * claim and cleared when the job is requeued, so a stale execution of the same job (even by the same
 * runner id) can no longer heartbeat, complete or release it. It is deliberately not part of `Job`:
 * it is handed to the holder once and never listed or logged.
 */
export type ClaimResult = { job: Job; leaseToken: string } | null;
