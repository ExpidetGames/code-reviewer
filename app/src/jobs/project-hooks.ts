// What the job queue does when a project is switched off: its waiting jobs are cancelled (status
// `cancelled`, error code `project_deactivated`); running jobs finish. The hook runs in the
// transaction of the deactivation, with that transaction as the executor, so the project is off and
// its waiting jobs are cancelled together or not at all. It is made for the workspace of the project
// service that calls it.
import "server-only";
import type { ProjectHooks } from "../projects/hooks.ts";
import { createJobQueue } from "./job-queue.ts";

export function createJobProjectHooks(workspaceId: string): ProjectHooks {
  return {
    async onProjectDeactivated(event, executor) {
      await createJobQueue(executor, workspaceId).cancelWaitingForRepository(
        event.repositoryId,
      );
    },
  };
}
