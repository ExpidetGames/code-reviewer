// SPDX-License-Identifier: Apache-2.0

// #195: what the job queue does when a project's review kind changes. #194 calls
// `ReviewSettingsHooks.onProjectSettingsChanged` in the transaction that wrote the settings; when the
// kind actually changed, the project's waiting jobs were queued for the other engine, so they are
// cancelled with the stable code `review_kind_changed`, in that same transaction. Running jobs finish
// (per-PR serialization is unchanged), and a rejecting call rolls the settings change back: the stored
// kind and the waiting jobs stay as they were. The hook is made for the workspace of the project
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
  };
}
