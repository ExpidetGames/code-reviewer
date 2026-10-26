// SPDX-License-Identifier: LicenseRef-Proprietary

// The kind of a job (#715, cut 1). A job row carries its review kind, and the queue, billing, the database
// repositories, the model catalog and the runner API all branch on it. It is a module of its own, without
// imports, so that none of them has to reach into `review-settings` (which owns the settings a project saves)
// or into `jobs` (the queue) for it, and so that it can move into the shared core as it is.

/**
 * The one review kind a project selects (#193, #194). Diff Review is the existing PR-Agent review;
 * Dynamic Review is the read-only agent of the epic. A project has exactly one.
 */
export const PROJECT_REVIEW_KINDS = ["diff", "dynamic"] as const;
export type ProjectReviewKind = (typeof PROJECT_REVIEW_KINDS)[number];
