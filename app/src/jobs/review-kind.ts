// SPDX-License-Identifier: LicenseRef-Proprietary

// #195: the one resolver of a job's review kind, run **inside the enqueue transaction**. A job's kind
// is decided when it is enqueued, from the project's stored settings, and never again. Resolving it
// inside the same transaction as the insert, after jobs-repository locks the repository row,
// makes the read atomic against a settings change: the settings write and the enqueue take the
// same lock, so a job can never be queued for a kind the project just left (the producer cannot
// read Diff, lose the race to a settings change, and then insert a stale Diff job).
import type { Kysely } from "kysely";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import type { Database } from "../db/schema.ts";
import { parseStoredProjectDynamicOverrides } from "../review-settings/validate.ts";
import type { ProjectReviewKind } from "../review-settings/settings.ts";

/** Resolves the review kind a new job of a repository must carry. Runs with the enqueue's executor. */
export type ReviewKindResolver = (
  executor: Kysely<Database>,
  repositoryId: string,
) => Promise<ProjectReviewKind>;

/**
 * The stored kind of a repository's project. A repository without a project row — nothing saved,
 * never activated — resolves to Diff, the kind that needs no Dynamic configuration.
 */
export function createStoredReviewKindResolver(
  workspaceId: string,
  now: () => Date = () => new Date(),
): ReviewKindResolver {
  return async (executor, repositoryId) => {
    const project = await createProjectsRepository(
      executor,
      workspaceId,
      now,
    ).get(repositoryId);
    return (
      parseStoredProjectDynamicOverrides(project?.settings).reviewKind ?? "diff"
    );
  };
}
