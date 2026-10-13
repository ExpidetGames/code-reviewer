// SPDX-License-Identifier: Apache-2.0

// #195: the one resolver producers use to pin a job's review kind. A job's kind is decided when it is
// enqueued, from the project's settings, and never again: the queue stores it, the claim routes by it
// and a later settings change cancels the waiting jobs of the old kind. Every producer (the webhook
// intake, the Review now button) goes through `createReviewKindResolver`, so a new producer cannot
// invent its own kind or queue a Dynamic project's review as a Diff one.
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import type { ReviewSettingsService } from "../review-settings/service.ts";

/** Resolves the review kind a new job of a repository must carry. */
export type ReviewKindResolver = (
  repositoryId: string,
) => Promise<ProjectReviewKind>;

/**
 * `settings` is the review settings service of the workspace of the repository (a job's repository is
 * always in the job's workspace). A repository without a project row — nothing saved, never
 * activated — resolves to Diff, the kind that needs no Dynamic configuration.
 */
export function createReviewKindResolver(
  settings: Pick<ReviewSettingsService, "resolveForRepository">,
): ReviewKindResolver {
  return async (repositoryId) => {
    const resolved = await settings.resolveForRepository(repositoryId);
    return resolved?.dynamic.reviewKind ?? "diff";
  };
}
