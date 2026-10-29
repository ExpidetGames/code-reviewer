// SPDX-License-Identifier: LicenseRef-Proprietary

// Repositories of one customer never reach another (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.9): two workspaces each link their own installation, and the deliveries of GitHub, the synchronization and
// the jobs that come of them stay with the workspace the installation is linked to.
import { describe, expect, it } from "vitest";
import { createJobQueue } from "../jobs/job-queue.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createProjectService } from "../projects/service.ts";
import { builtInReviewSettings } from "../review-settings/settings.ts";
import { createBindingHarness } from "../test-support/binding-harness.ts";
import {
  FIXTURE_HEAD_SHA,
  fixturePullRequest,
} from "../test-support/webhook-harness.ts";
import { createJobQueueReviewTriggerIntake } from "../webhooks/job-queue-intake.ts";

const ACME = { login: "acme", id: 5001, type: "Organization" } as const;
const BETA = { login: "beta", id: 5100, type: "Organization" } as const;

async function twoWorkspaces() {
  const h = await createBindingHarness({ tenancy: "multi" });
  const a = await h.workspace("a");
  const b = await h.workspace("b");
  const ownerA = await h.person("owner-a", {
    workspaceId: a.id,
    role: "owner",
  });
  const ownerB = await h.person("owner-b", {
    workspaceId: b.id,
    role: "owner",
  });
  h.githubUser(1001, "octo");
  h.githubUser(1003, "octo2");
  h.github.addOrgMember("acme", "octo", "active", "admin");
  h.github.addOrgMember("beta", "octo2", "active", "admin");
  h.install({ id: 4242, account: ACME });
  h.github.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
  h.install({ id: 4300, account: BETA });
  h.github.setRepositories(4300, [{ id: 8001, fullName: "beta/app" }]);
  h.install(
    { id: 4900, account: { login: "other", id: 5900, type: "Organization" } },
    ["other/secret"],
  );
  await h.walk(ownerA, a.id, { installationId: 4242, githubLogin: "octo" });
  await h.walk(ownerB, b.id, { installationId: 4300, githubLogin: "octo2" });
  for (const [workspace, name] of [
    [a, "acme/widgets"],
    [b, "beta/app"],
  ] as const) {
    const repositories = createRepositoriesRepository(h.db, workspace.id);
    const repository = (await repositories.list()).find(
      (row) => row.fullName === name,
    );
    if (repository === undefined) throw new Error(`no repository ${name}`);
    await createProjectsRepository(h.db, workspace.id).activate(repository.id);
  }
  h.github.addPullRequest("acme/widgets", fixturePullRequest());
  h.github.addPullRequest("beta/app", fixturePullRequest());
  const route = h.webhook((workspaceId) => ({
    projects: createProjectService({
      projects: createProjectsRepository(h.db, workspaceId),
    }),
    settingsFor: async () => builtInReviewSettings("test/model"),
    intake: createJobQueueReviewTriggerIntake({
      queue: createJobQueue(h.db, workspaceId),
      repositories: createRepositoriesRepository(h.db, workspaceId),
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    }),
  }));
  return { h, a, b, route };
}

/** The recorded pull request event, as sent for the installation `installationId` and its repository. */
function opened(
  installationId: number,
  repository: { id: number; fullName: string },
) {
  return (payload: Record<string, unknown>) => {
    const name = repository.fullName.split("/")[1] ?? "";
    payload.installation = { id: installationId };
    const repo = {
      ...(payload.repository as object),
      id: repository.id,
      name,
      full_name: repository.fullName,
    };
    payload.repository = repo;
    const request = payload.pull_request as {
      head: { repo: object };
      base: { repo: object };
    };
    request.head.repo = { id: repository.id, full_name: repository.fullName };
    request.base.repo = { id: repository.id, full_name: repository.fullName };
  };
}

describe("two workspaces with one installation each", () => {
  // #103-IB-13
  it("gives each workspace its own connection and repositories, and no other", async () => {
    const { h, a, b } = await twoWorkspaces();

    expect(await h.integrationRows()).toEqual([
      expect.objectContaining({ external_id: "4242", workspace_id: a.id }),
      expect.objectContaining({ external_id: "4300", workspace_id: b.id }),
    ]);
    expect((await h.repositoryRows(a.id)).map((row) => row.full_name)).toEqual([
      "acme/widgets",
    ]);
    expect((await h.repositoryRows(b.id)).map((row) => row.full_name)).toEqual([
      "beta/app",
    ]);
    // The installation nobody linked is in neither.
    expect(
      (await h.repositoryRows()).map((row) => row.full_name),
    ).not.toContain("other/secret");
  });

  // #103-IB-13
  it("makes the job of a delivery in the workspace of its installation, and in no other", async () => {
    const { h, a, b, route } = await twoWorkspaces();

    const forA = await route.deliver("pull_request.opened");
    const forB = await route.deliver(
      "pull_request.opened",
      opened(4300, { id: 8001, fullName: "beta/app" }),
    );

    expect(forA).toEqual({ status: 202, outcome: "trigger_enqueued" });
    expect(forB).toEqual({ status: 202, outcome: "trigger_enqueued" });
    const jobs = await h.db
      .selectFrom("jobs")
      .innerJoin("repositories", "repositories.id", "jobs.repository_id")
      .select([
        "jobs.workspace_id",
        "repositories.full_name",
        "repositories.workspace_id as repository_workspace",
      ])
      .orderBy("repositories.full_name")
      .execute();
    expect(jobs).toEqual([
      {
        workspace_id: a.id,
        full_name: "acme/widgets",
        repository_workspace: a.id,
      },
      { workspace_id: b.id, full_name: "beta/app", repository_workspace: b.id },
    ]);
  });

  // #103-IB-13
  it("lets a delivery for one installation change nothing of the other workspace", async () => {
    const { h, b, route } = await twoWorkspaces();
    const before = {
      jobs: await h.db
        .selectFrom("jobs")
        .selectAll()
        .where("workspace_id", "=", b.id)
        .execute(),
      repositories: await h.repositoryRows(b.id),
      integrations: (await h.integrationRows()).filter(
        (row) => row.workspace_id === b.id,
      ),
    };

    await route.deliver("pull_request.opened");
    await route.deliver("pull_request.synchronize");
    await route.deliver("installation_repositories.added");

    expect(
      await h.db
        .selectFrom("jobs")
        .selectAll()
        .where("workspace_id", "=", b.id)
        .execute(),
    ).toEqual(before.jobs);
    expect(await h.repositoryRows(b.id)).toEqual(before.repositories);
    expect(
      (await h.integrationRows()).filter((row) => row.workspace_id === b.id),
    ).toEqual(before.integrations);
  });

  // #103-IB-13
  it("makes no job for a delivery about an installation nobody linked, even for a repository of an active project", async () => {
    const { h, route } = await twoWorkspaces();

    const answer = await route.deliver(
      "pull_request.opened",
      opened(4900, { id: 9001, fullName: "other/secret" }),
    );

    expect(answer).toEqual({ status: 202, outcome: "unknown_installation" });
    expect(await h.db.selectFrom("jobs").selectAll().execute()).toEqual([]);
  });

  // #103-IB-13
  it("treats a repository of workspace B named by an installation of workspace A as nothing of A's", async () => {
    const { h, route } = await twoWorkspaces();

    // The payload claims installation 4242 (A's) but names B's repository: A has no such repository.
    const answer = await route.deliver(
      "pull_request.opened",
      opened(4242, { id: 8001, fullName: "beta/app" }),
    );

    expect(answer.status).toBe(202);
    expect(answer.outcome).not.toBe("trigger_enqueued");
    expect(await h.db.selectFrom("jobs").selectAll().execute()).toEqual([]);
  });

  // #103-IB-13
  it("keeps the head commit of the fixture in the one pull request each workspace sees", async () => {
    const { h, a, route } = await twoWorkspaces();
    await route.deliver("pull_request.opened");

    const [job] = await h.db
      .selectFrom("jobs")
      .select(["workspace_id", "head_sha"])
      .execute();

    expect(job).toEqual({ workspace_id: a.id, head_sha: FIXTURE_HEAD_SHA });
  });
});
