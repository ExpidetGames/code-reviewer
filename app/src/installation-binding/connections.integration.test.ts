// SPDX-License-Identifier: LicenseRef-Proprietary

// Ending a connection (docs/decisions/0001-editions-setup-and-accounts.md, section 2.9): the connection and its
// repositories are switched off for the workspace, the projects and their history stay stored, nothing happens
// on GitHub, the installation stays the workspace's (the synchronization and the deliveries about it never
// bring it back), and only the same workspace can connect it again.
import { describe, expect, it } from "vitest";
import { createJobQueue } from "../jobs/job-queue.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createBindingHarness } from "../test-support/binding-harness.ts";

const ACME = { login: "acme", id: 5001, type: "Organization" } as const;
const SHA = "a".repeat(40);

/** A workspace whose Owner connected the installation, with a project and a job on one repository. */
async function connected() {
  const h = await createBindingHarness({ tenancy: "multi" });
  const a = await h.workspace("a");
  const owner = await h.person("owner-a", { workspaceId: a.id, role: "owner" });
  h.githubUser(1001, "octo");
  h.github.addOrgMember("acme", "octo", "active", "admin");
  h.install({ id: 4242, account: ACME }, ["acme/widgets", "acme/gadgets"]);
  await h.walk(owner, a.id, { installationId: 4242, githubLogin: "octo" });
  const [integration] = await h.integrationRows();
  if (integration === undefined) throw new Error("not connected");
  const repositories = createRepositoriesRepository(h.db, a.id);
  const [widgets] = await repositories.list({ active: true });
  if (widgets === undefined) throw new Error("no repository");
  await createProjectsRepository(h.db, a.id).activate(widgets.id);
  await createJobQueue(h.db, a.id).enqueue({
    repositoryId: widgets.id,
    prNumber: 7,
    prUrl: "https://github.test/acme/widgets/pull/7",
    headSha: SHA,
    command: "review",
    triggerKind: "webhook",
    actorLogin: "alice",
    deliveryId: "delivery-1",
  });
  return { h, a, owner, integration, widgets };
}

describe("disconnecting", () => {
  // #103-IB-14
  it("disables the connection and its repositories, keeps the projects and runs, and touches nothing on GitHub", async () => {
    const { h, a, integration } = await connected();
    const projectsBefore = await h.db
      .selectFrom("projects")
      .selectAll()
      .execute();
    const jobsBefore = await h.db.selectFrom("jobs").selectAll().execute();
    const requestsBefore = h.github.requests().length;

    const result = await h.binding.connections.disconnect({
      workspaceId: a.id,
      integrationId: integration.id,
    });

    expect(result).toEqual({ ok: true });
    expect(await h.integrationRows()).toEqual([
      expect.objectContaining({ id: integration.id, status: "disconnected" }),
    ]);
    expect(
      (await h.repositoryRows(a.id)).every(
        (repository) => repository.active === 0,
      ),
    ).toBe(true);
    expect(await h.db.selectFrom("projects").selectAll().execute()).toEqual(
      projectsBefore,
    );
    expect(await h.db.selectFrom("jobs").selectAll().execute()).toEqual(
      jobsBefore,
    );
    // Nothing was asked of GitHub, and certainly nothing was deleted there.
    expect(h.github.requests().slice(requestsBefore)).toEqual([]);
    expect(
      h.github.requests().some((request) => request.method === "DELETE"),
    ).toBe(false);
  });

  // #103-IB-14
  it("is repeatable: ending a connection that is ended changes nothing", async () => {
    const { h, a, integration } = await connected();
    await h.binding.connections.disconnect({
      workspaceId: a.id,
      integrationId: integration.id,
    });
    const before = await h.integrationRows();

    const again = await h.binding.connections.disconnect({
      workspaceId: a.id,
      integrationId: integration.id,
    });

    expect(again).toEqual({ ok: true });
    expect(await h.integrationRows()).toEqual(before);
  });

  // #103-IB-14
  it("is not found for the connection of another workspace, which stays as it is", async () => {
    const { h, integration } = await connected();
    const b = await h.workspace("b");

    const result = await h.binding.connections.disconnect({
      workspaceId: b.id,
      integrationId: integration.id,
    });

    expect(result).toEqual({ ok: false, error: "integration_not_found" });
    expect(await h.integrationRows()).toEqual([
      expect.objectContaining({ status: "active" }),
    ]);
  });

  // #103-IB-14
  it("is not undone by the synchronization, by the one of the workspace or by a delivery about the installation", async () => {
    const { h, a, integration } = await connected();
    await h.binding.connections.disconnect({
      workspaceId: a.id,
      integrationId: integration.id,
    });
    h.github.addRepository(4242, { id: 7003, fullName: "acme/extra" });
    const route = h.webhook();

    await h.sync.syncAll();
    await h.sync.syncWorkspace(a.id);
    const created = await route.deliver("installation.created");
    const unsuspended = await route.deliver("installation.unsuspend");

    expect(created.status).toBe(202);
    expect(unsuspended.status).toBe(202);
    expect(await h.integrationRows()).toEqual([
      expect.objectContaining({ status: "disconnected" }),
    ]);
    const repositories = await h.repositoryRows(a.id);
    expect(repositories.every((repository) => repository.active === 0)).toBe(
      true,
    );
    expect(
      repositories.map((repository) => repository.full_name),
    ).not.toContain("acme/extra");
  });

  // #103-IB-14
  it.each([
    ["a pull request that was opened", "pull_request.opened"],
    ["a comment that gives a command", "issue_comment.created.review"],
  ] as const)(
    "starts no review for %s after the disconnect, and answers integration_disabled",
    async (_, fixture) => {
      const { h, a, integration, widgets } = await connected();
      const route = h.webhook(h.reviewingCollaborators);
      // The open pull request of the recorded payloads, and a commenter who may write to the repository.
      h.github.addPullRequest("acme/widgets", {
        number: 7,
        title: "Add widget caching",
        state: "open",
        headSha: "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01",
        headRef: "feature/caching",
        baseRef: "main",
        author: { login: "alice", id: 1001 },
      });
      h.github.setCollaboratorPermission("acme/widgets", "bob", "write");
      // The recorded payloads name repository 7001; this scene's repository has the id the fake gave it.
      const deliver = () =>
        route.deliver(fixture, (payload) => {
          (payload.repository as { id: unknown }).id = Number(
            widgets.externalId,
          );
        });
      const jobs = async () =>
        (await h.db.selectFrom("jobs").selectAll().execute()).length;
      // The same delivery of the connected workspace is a trigger: the test is not vacuous.
      const reviewed = await deliver();
      expect(reviewed.outcome).toBe("trigger_enqueued");

      await h.binding.connections.disconnect({
        workspaceId: a.id,
        integrationId: integration.id,
      });
      const after = await jobs();
      const answer = await deliver();

      expect(answer).toEqual({ status: 202, outcome: "integration_disabled" });
      expect(await jobs()).toBe(after);
    },
  );

  // #103-IB-14
  it("keeps the installation the workspace's: another workspace cannot link it, and the workspace can connect it again", async () => {
    const { h, a, owner, integration } = await connected();
    h.githubUser(1003, "octo2");
    h.github.addOrgMember("acme", "octo2", "active", "admin");
    await h.binding.connections.disconnect({
      workspaceId: a.id,
      integrationId: integration.id,
    });
    const b = await h.workspace("b");
    const ownerB = await h.person("owner-b", {
      workspaceId: b.id,
      role: "owner",
    });

    const foreign = await h.walk(ownerB, b.id, {
      installationId: 4242,
      githubLogin: "octo2",
    });
    const back = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(foreign.final).toMatchObject({
      code: "installation_already_linked",
    });
    expect(back.final).toMatchObject({ code: "linked" });
    expect(await h.integrationRows()).toEqual([
      expect.objectContaining({
        id: integration.id,
        workspace_id: a.id,
        status: "active",
      }),
    ]);
    expect(
      (await h.repositoryRows(a.id)).every(
        (repository) => repository.active === 1,
      ),
    ).toBe(true);
  });

  // #103-IB-14
  it("offers the disconnected installation of the same workspace in the list, and none of another workspace", async () => {
    const { h, a, owner, integration } = await connected();
    await h.binding.connections.disconnect({
      workspaceId: a.id,
      integrationId: integration.id,
    });
    const start = await h.binding.service.startPicker(owner, a.id);
    if (!start.ok) throw new Error("the list did not start");

    const listed = await h.authorize(owner, start.url, "octo");

    if (listed.kind !== "done" || listed.picker === undefined)
      throw new Error("expected the list");
    expect(
      (await h.binding.service.readPicker(owner, a.id, listed.picker))?.map(
        (entry) => entry.installationId,
      ),
    ).toEqual(["4242"]);
  });
});

describe("the synchronization of one workspace", () => {
  // #103-IB-13
  it("reads the repositories of its own connections only, and its answer is about them", async () => {
    const { h, a } = await connected();
    const b = await h.workspace("b");
    const ownerB = await h.person("owner-b", {
      workspaceId: b.id,
      role: "owner",
    });
    h.githubUser(1003, "octo2");
    h.install(
      { id: 4300, account: { login: "beta", id: 5100, type: "Organization" } },
      ["beta/app"],
    );
    h.github.addOrgMember("beta", "octo2", "active", "admin");
    await h.walk(ownerB, b.id, { installationId: 4300, githubLogin: "octo2" });
    h.github.addRepository(4242, { id: 7003, fullName: "acme/extra" });
    h.github.addRepository(4300, { id: 8003, fullName: "beta/extra" });
    // A failure that belongs to B must not show in A's answer.
    h.github.fail({ pathIncludes: "/app/installations/4300", status: 503 });

    const summary = await h.sync.syncWorkspace(a.id);

    expect(summary.repositories.added).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(
      (await h.repositoryRows(a.id)).map((row) => row.full_name),
    ).toContain("acme/extra");
    expect(
      (await h.repositoryRows(b.id)).map((row) => row.full_name),
    ).not.toContain("beta/extra");
  });

  // #103-IB-13
  it("names an error of its own connection with that connection's id and no other", async () => {
    const { h, a, integration } = await connected();
    h.github.fail({ pathIncludes: "/app/installations/4242", status: 503 });

    const summary = await h.sync.syncWorkspace(a.id);

    expect(summary.errors).toEqual([
      expect.objectContaining({
        stage: "connection",
        integrationId: integration.id,
        code: "GITHUB_APP_UNAVAILABLE",
      }),
    ]);
  });

  // #103-IB-13
  it("finds no new connection: an installation nobody linked stays unclaimed", async () => {
    const { h, a } = await connected();
    h.install(
      { id: 4900, account: { login: "other", id: 5900, type: "Organization" } },
      ["other/app"],
    );

    const summary = await h.sync.syncWorkspace(a.id);

    expect(summary.integrations.created).toBe(0);
    expect((await h.integrationRows()).map((row) => row.external_id)).toEqual([
      "4242",
    ]);
  });

  // #103-IB-13
  it("follows GitHub for its own connections: a suspension disables, and a removal deactivates", async () => {
    const { h, a } = await connected();

    h.github.suspendInstallation(4242, true);
    const suspended = await h.sync.syncWorkspace(a.id);
    expect(suspended.integrations.disabled).toBe(1);
    expect(await h.integrationRows()).toEqual([
      expect.objectContaining({ status: "disabled" }),
    ]);

    h.github.suspendInstallation(4242, false);
    await h.sync.syncWorkspace(a.id);
    expect(await h.integrationRows()).toEqual([
      expect.objectContaining({ status: "active" }),
    ]);

    h.github.removeInstallation(4242);
    const removed = await h.sync.syncWorkspace(a.id);
    expect(removed.repositories.deactivated).toBeGreaterThan(0);
  });
});
