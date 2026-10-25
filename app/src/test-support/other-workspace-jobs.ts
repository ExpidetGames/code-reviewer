// SPDX-License-Identifier: LicenseRef-Proprietary

// A job in a workspace other than the fixture's, for the tests that show one workspace's limit leaves another alone.
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createJobQueue } from "../jobs/job-queue.ts";
import { sha, type JobQueueFixture } from "./jobs.ts";

/** Queues a job on a repository of its own in another workspace and returns its id. */
export async function enqueueInWorkspace(
  fixture: JobQueueFixture,
  workspaceId: string,
): Promise<string> {
  const integration = await createIntegrationsRepository(
    fixture.db,
    workspaceId,
    fixture.clock.now,
  ).create({
    type: "github_app",
    displayName: "other",
    externalId: `other-${workspaceId}`,
    config: {},
  });
  const repositories = createRepositoriesRepository(
    fixture.db,
    workspaceId,
    fixture.clock.now,
  );
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: `other-repo-${workspaceId}`,
      fullName: "other/widgets",
      url: "https://github.test/other/widgets",
    },
  ]);
  const [repository] = await repositories.list({
    integrationId: integration.id,
  });
  if (repository === undefined)
    throw new Error("The repository of the other workspace is missing.");
  const result = await createJobQueue(fixture.db, workspaceId, {
    now: fixture.clock.now,
  }).enqueue({
    repositoryId: repository.id,
    prNumber: 1,
    prUrl: "https://github.test/other/widgets/pull/1",
    headSha: sha("f"),
    command: "review",
    triggerKind: "webhook",
    actorLogin: "octocat",
  });
  if (result.status !== "created")
    throw new Error("The job of the other workspace was not created.");
  return result.job.id;
}
