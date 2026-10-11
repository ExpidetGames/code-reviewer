// SPDX-License-Identifier: Apache-2.0

// The runner API serves the whole instance: a runner is handed the oldest due job of ANY workspace,
// with the credentials of that job's own connection, and the answer has the same shape as ever.
// Everything the claim looks up for a job (repository, connection, project, settings) is looked up in
// the workspace of the job.
import { describe, expect, it } from "vitest";
import { createIntegrationsRepository } from "../../src/db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import { createJobQueue } from "../../src/jobs/job-queue.ts";
import { sha } from "../../src/test-support/jobs.ts";
import { startRunnerApiHarness } from "../../src/test-support/runner-api-harness.ts";
import { addWorkspace } from "../../src/test-support/workspaces.ts";

/** A second workspace with its own connection (installation 4343) and repository "other/tools". */
async function addSecondWorkspace(
  h: Awaited<ReturnType<typeof startRunnerApiHarness>>,
) {
  const workspaceId = await addWorkspace(h.db, "other");
  const integration = await createIntegrationsRepository(
    h.db,
    workspaceId,
    h.clock.now,
  ).create({
    type: "github_app",
    displayName: "other",
    externalId: "4343",
    config: {},
  });
  const repositories = createRepositoriesRepository(
    h.db,
    workspaceId,
    h.clock.now,
  );
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: "7101",
      fullName: "other/tools",
      url: "https://github.test/other/tools",
    },
  ]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  h.fake.addInstallation({
    id: 4343,
    account: { login: "other", id: 5002, type: "Organization" },
  });
  h.fake.setRepositories(4343, [{ id: 7101, fullName: "other/tools" }]);
  h.fake.addPullRequest("other/tools", {
    number: 7,
    title: "Change 7",
    state: "open",
    headSha: sha("a"),
    headRef: "feature/change-7",
    baseRef: "main",
    author: { login: "alice", id: 1001 },
  });
  const queue = createJobQueue(h.db, workspaceId, { now: h.clock.now });
  const enqueued = await queue.enqueue({
    repositoryId: repository.id,
    prNumber: 7,
    prUrl: "https://github.test/other/tools/pull/7",
    headSha: sha("a"),
    command: "review",
    triggerKind: "webhook",
    actorLogin: "octocat",
  });
  if (enqueued.status !== "created") throw new Error("seeding failed");
  return { workspaceId, job: enqueued.job };
}

describe("claiming jobs of two workspaces", () => {
  // DM-09
  it("hands out each job once, the older one first, whatever its workspace", async () => {
    const h = await startRunnerApiHarness();
    const first = await h.enqueueNew();
    h.clock.advance(1000);
    const second = await addSecondWorkspace(h);

    const one = await h.claim();
    const two = await h.claim();
    const three = await h.claim();

    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(three.status).toBe(204);
    expect((await one.json()).job.id).toBe(first.id);
    expect((await two.json()).job.id).toBe(second.job.id);
  });

  // DM-09
  it("gives the job of the second workspace the credentials of its own connection and the same answer shape", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();
    h.clock.advance(1000);
    await addSecondWorkspace(h);

    const inFirst = await h.claimed();
    const inSecond = await h.claimed();

    const installations = h.fake
      .tokenRequests()
      .filter((request) => request.repositoryIds !== null)
      .map((request) => request.installationId);
    expect(installations).toEqual([4242, 4343]);
    expect(inSecond.job.input.prUrl).toBe(
      "https://github.test/other/tools/pull/7",
    );
    expect(Object.keys(inSecond)).toEqual(Object.keys(inFirst));
    expect(Object.keys(inSecond.job)).toEqual(Object.keys(inFirst.job));
    expect(Object.keys(inSecond.job.input)).toEqual(
      Object.keys(inFirst.job.input),
    );
    expect(Object.keys(inSecond.job.input.git)).toEqual(
      Object.keys(inFirst.job.input.git),
    );
  });

  // DM-09
  it("lets the runner finish the job of the second workspace like any other", async () => {
    const h = await startRunnerApiHarness();
    h.clock.advance(1000);
    await addSecondWorkspace(h);
    const claimed = await h.claimed();

    const heartbeat = await h.heartbeat(claimed.job.id, claimed.job.leaseToken);
    const complete = await h.complete(claimed.job.id, claimed.job.leaseToken);

    expect(heartbeat.status).toBe(200);
    expect(complete.status).toBe(200);
    expect(await h.queue.get(claimed.job.id)).toMatchObject({
      status: "succeeded",
    });
  });
});
