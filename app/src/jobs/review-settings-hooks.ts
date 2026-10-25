// SPDX-License-Identifier: LicenseRef-Proprietary

// #195: what the job queue does when a project's review kind changes. #194 calls
// `ReviewSettingsHooks.onProjectSettingsChanged` in the transaction that wrote the settings; when the
// kind actually changed, the project's waiting jobs were queued for the other engine, so they are
// cancelled with the stable code `review_kind_changed`, in that same transaction. Running jobs finish
// (per-PR serialization is unchanged), and a rejecting call rolls the settings change back: the stored
// kind and the waiting jobs stay as they were. The kind of the workspace defaults (#676) does the same for every project that
// follows it. The hook is made for the workspace of the project
// service that calls it.
import "server-only";
import type { ReviewSettingsHooks } from "../review-settings/hooks.ts";
import { createJobQueue } from "./job-queue.ts";

export function createJobReviewSettingsHooks(
  workspaceId: string,
): ReviewSettingsHooks {
  return {
    async onProjectSettingsChanged(event, executor) {
      if (!event.kindChanged) return;
      await createJobQueue(
        executor,
        workspaceId,
      ).cancelWaitingForReviewKindChange(event.repositoryId);
    },
    // #676: the kind of the workspace defaults changed, so the waiting jobs of every project that follows it were queued for the
    // wrong engine, exactly as after a project's own change. Running jobs finish.
    async onWorkspaceDefaultsKindChanged(event, executor) {
      const queue = createJobQueue(executor, workspaceId);
      for (const repositoryId of event.followingRepositoryIds)
        await queue.cancelWaitingForReviewKindChange(repositoryId);
    },
  };
}
