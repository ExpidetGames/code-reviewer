// SPDX-License-Identifier: LicenseRef-Proprietary

// #195: the engines a runner can advertise and the review kinds each engine can run. A claim carries
// the engines of the calling runner (`contracts/runner-api.v1.json`, `ClaimRequest`); an empty legacy
// request means `pr-agent` only. The claim statement filters on the review kind, so a runner that
// cannot run a kind is never handed such a job — not even briefly, and without counting an attempt or
// creating credentials.
import type { ProjectReviewKind } from "../review-settings/settings.ts";

/**
 * The engines a runner may claim for. `pr-agent` runs Diff Review, `opencode` runs Dynamic Review.
 * The names are the enum of `Engine` in the contract; a test compares this list with the file.
 */
export const RUNNER_ENGINES = ["pr-agent", "opencode"] as const;
export type RunnerEngine = (typeof RUNNER_ENGINES)[number];

/** The one engine a caller that sends no list (a previous-release runner) is trusted with. */
export const DEFAULT_ENGINES: readonly RunnerEngine[] = ["pr-agent"];

/** The review kinds one engine can run. */
export const REVIEW_KINDS_OF_ENGINE: Record<
  RunnerEngine,
  readonly ProjectReviewKind[]
> = {
  "pr-agent": ["diff"],
  opencode: ["dynamic"],
};

/** Every kind the given engines together can run, without duplicates. */
export function reviewKindsForEngines(
  engines: readonly RunnerEngine[],
): ProjectReviewKind[] {
  const kinds = new Set<ProjectReviewKind>();
  for (const engine of engines)
    for (const kind of REVIEW_KINDS_OF_ENGINE[engine]) kinds.add(kind);
  return [...kinds];
}
