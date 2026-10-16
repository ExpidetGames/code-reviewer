// SPDX-License-Identifier: Apache-2.0

// The trigger policy for automatic reviews: which pull request events start a review, which wait and
// which are dropped. Pure functions, no database and no GitHub; the webhook handler asks them and
// does the I/O around them (the project's settings, the current state of the pull request).
//
// What decides, in this order:
//
//   1. the pull request is closed          -> skipped (a closed pull request is not reviewed)
//   2. the pull request is a draft         -> skipped until it is marked ready (`ready_for_review`
//                                             arrives as an `opened` trigger and starts the review)
//   3. the project switched this kind off  -> skipped (`autoReviewOnOpen` for opened, reopened and
//                                             ready for review, `autoReviewOnPush` for new commits)
//   4. otherwise a job is created and is due at once, a push included (#395): there is no debounce. A
//      new push replaces the waiting job of the older commit and supersedes its running one (the queue).
//
// Pull requests from forks and pull requests opened by bots are reviewed like any other.
import type { PullRequestRef, ReviewTrigger } from "../integrations/types.ts";
import { isAutomaticReviewEnabled } from "../review-settings/effective.ts";
import type { ReviewSettings } from "../review-settings/settings.ts";

/** The triggers a pull request event produces; a comment command is not one of them. */
export type PullRequestTrigger = Extract<
  ReviewTrigger,
  { kind: "opened" | "updated" }
>;

export const AUTOMATIC_SKIP_REASONS = [
  /** The pull request is closed or merged. */
  "pull_request_closed",
  /** The pull request is a draft; it is reviewed once it is marked ready. */
  "draft",
  /** The project (or the global defaults) switched this kind of automatic review off. */
  "automatic_review_disabled",
  /** The trigger is about a commit that is no longer the head of the pull request. */
  "stale_head",
  /** GitHub does not know the pull request (any more). */
  "pull_request_not_found",
] as const;
export type AutomaticSkipReason = (typeof AUTOMATIC_SKIP_REASONS)[number];

export type AutomaticDecision =
  { action: "enqueue" } | { action: "skip"; reason: AutomaticSkipReason };

export function decideAutomaticTrigger(input: {
  trigger: PullRequestTrigger;
  settings: ReviewSettings;
}): AutomaticDecision {
  const { trigger, settings } = input;
  if (trigger.state !== "open")
    return { action: "skip", reason: "pull_request_closed" };
  if (trigger.draft) return { action: "skip", reason: "draft" };
  if (!isAutomaticReviewEnabled(settings, trigger.kind))
    return { action: "skip", reason: "automatic_review_disabled" };
  return { action: "enqueue" };
}

/**
 * Compares a trigger with the pull request as the platform reports it now. Deliveries can arrive
 * late and out of order: a `synchronize` for an older commit must not replace the waiting job of the
 * newer one, and a late delivery for a pull request that was closed meanwhile must not start a
 * review. Returns `null` when the trigger still holds.
 */
export function checkAgainstCurrentPullRequest(
  trigger: PullRequestTrigger,
  current: PullRequestRef,
): Extract<AutomaticDecision, { action: "skip" }> | null {
  if (current.state !== "open")
    return { action: "skip", reason: "pull_request_closed" };
  if (current.headSha.toLowerCase() !== trigger.headSha.toLowerCase())
    return { action: "skip", reason: "stale_head" };
  if (current.draft) return { action: "skip", reason: "draft" };
  return null;
}
