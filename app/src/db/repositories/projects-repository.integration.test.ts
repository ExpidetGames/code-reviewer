// SPDX-License-Identifier: Apache-2.0

// Pins down the projects table against a real SQLite file: activating a repository creates its one
// project, deactivating keeps the row and its settings, activating again reuses the row, a repository
// the platform no longer lists cannot be activated but keeps its project row, and two simultaneous
// activations end in exactly one project.
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import type { RepoRef } from "../../integrations/types.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { defaultWorkspaceId } from "../../test-support/workspaces.ts";
import { createIntegrationsRepository } from "./integrations-repository.ts";
import { createProjectsRepository } from "./projects-repository.ts";
import { createRepositoriesRepository } from "./repositories-repository.ts";

async function setup() {
  const { db } = await createTestDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 10, 12, 0, tick++));
  const integrations = createIntegrationsRepository(db, workspaceId, now);
  const repositories = createRepositoriesRepository(db, workspaceId, now);
  const integration = await integrations.create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const remote = (id: number, fullName = `acme/repo-${id}`): RepoRef => ({
    integrationId: integration.id,
    externalId: String(id),
    fullName,
    url: `https://github.test/${fullName}`,
  });
  await repositories.reconcile(integration.id, [remote(1), remote(2)]);
  const [first, second] = await repositories.list();
  if (first === undefined || second === undefined)
    throw new Error("seeding failed");
  return {
    db,
    now,
    integration,
    integrations,
    repositories,
    remote,
    first,
    second,
    projects: createProjectsRepository(db, workspaceId, now),
    projectsWithWarning: (warn: (message: string) => void) =>
      createProjectsRepository(db, workspaceId, now, undefined, warn),
    rows: () => db.selectFrom("projects").selectAll().execute(),
  };
}

describe("activating a repository", () => {
  // CR-24-T01
  it("creates an active project that refers to the repository and, through it, to the integration", async () => {
    const { projects, first, integration, rows } = await setup();

    const result = await projects.activate(first.id);

    expect(result).toMatchObject({
      kind: "activated",
      outcome: "created",
      project: { repositoryId: first.id, active: true, settings: {} },
    });
    expect(await rows()).toHaveLength(1);
    const entries = await projects.list();
    expect(entries.find((entry) => entry.repository.id === first.id)).toEqual(
      expect.objectContaining({
        status: "active",
        repository: expect.objectContaining({
          id: first.id,
          fullName: first.fullName,
          integration: expect.objectContaining({ id: integration.id }),
        }),
      }),
    );
  });

  // CR-24-T06
  it("reuses the row of a deactivated project and keeps its settings", async () => {
    const { projects, first, db, rows } = await setup();
    const created = await projects.activate(first.id);
    if (created.kind !== "activated") throw new Error("not activated");
    await db
      .updateTable("projects")
      .set({ settings: JSON.stringify({ model: "cheap" }) })
      .execute();
    await projects.deactivate(first.id);

    const again = await projects.activate(first.id);

    expect(again).toMatchObject({
      kind: "activated",
      outcome: "reactivated",
      project: {
        id: created.project.id,
        active: true,
        settings: { model: "cheap" },
      },
    });
    expect(await rows()).toHaveLength(1);
  });

  it("reports an already active project as unchanged and does not touch it", async () => {
    const { projects, first, rows } = await setup();
    await projects.activate(first.id);
    const before = await rows();

    const again = await projects.activate(first.id);

    expect(again).toMatchObject({ kind: "activated", outcome: "unchanged" });
    expect(await rows()).toEqual(before);
  });

  // CR-24-T07
  it("ends two simultaneous activations in exactly one project", async () => {
    const { projects, first, rows } = await setup();

    const results = await Promise.all([
      projects.activate(first.id),
      projects.activate(first.id),
      projects.activate(first.id),
    ]);

    expect(await rows()).toHaveLength(1);
    expect(results.map((result) => result.kind)).toEqual([
      "activated",
      "activated",
      "activated",
    ]);
    expect(
      results.filter(
        (result) => result.kind === "activated" && result.outcome === "created",
      ),
    ).toHaveLength(1);
  });

  // CR-24-T08
  it("refuses a repository the platform no longer lists and creates no project", async () => {
    const { projects, first, repositories, integration, remote, rows } =
      await setup();
    await repositories.reconcile(integration.id, [remote(2)]);

    const result = await projects.activate(first.id);

    expect(result).toEqual({ kind: "repository_unavailable" });
    expect(await rows()).toEqual([]);
  });

  // CR-24-T09
  it("refuses an unknown repository id and creates nothing", async () => {
    const { projects, rows } = await setup();

    const result = await projects.activate("no-such-repository");

    expect(result).toEqual({ kind: "repository_not_found" });
    expect(await rows()).toEqual([]);
  });

  // CR-24-T08
  it("does not reactivate the project of a repository that has disappeared", async () => {
    const { projects, first, repositories, integration, remote } =
      await setup();
    await projects.activate(first.id);
    await projects.deactivate(first.id);
    await repositories.reconcile(integration.id, [remote(2)]);

    const result = await projects.activate(first.id);

    expect(result).toEqual({ kind: "repository_unavailable" });
    expect(await projects.get(first.id)).toMatchObject({ active: false });
  });
});

describe("a repository of a suspended or removed installation", () => {
  // CR-24-T08
  it("cannot be activated while its integration is disabled, even if the repository row is still active", async () => {
    const { projects, first, integrations, integration, rows } = await setup();
    await integrations.setStatus(integration.id, "disabled");

    const result = await projects.activate(first.id);

    expect(result).toEqual({ kind: "integration_unavailable" });
    expect(await rows()).toEqual([]);
  });

  it("can be activated again once the integration is back", async () => {
    const { projects, first, integrations, integration } = await setup();
    await integrations.setStatus(integration.id, "disabled");
    await integrations.setStatus(integration.id, "active");

    expect(await projects.activate(first.id)).toMatchObject({
      kind: "activated",
    });
  });

  it("keeps its project row but counts as unavailable and not as an active project", async () => {
    const { projects, first, integrations, integration, rows } = await setup();
    await projects.activate(first.id);
    const before = await rows();

    await integrations.setStatus(integration.id, "disabled");

    expect(await rows()).toEqual(before);
    expect(await projects.findActiveForRepository(first.id)).toBeUndefined();
    expect(
      await projects.findActiveForExternalRepository(
        integration.id,
        first.externalId,
      ),
    ).toBeUndefined();
    expect((await projects.list()).map((entry) => entry.status)).toEqual([
      "unavailable",
      "unavailable",
    ]);
  });
});

describe("deactivating a project", () => {
  // CR-24-T02
  it("switches it off and keeps the row and its settings", async () => {
    const { projects, first, db, rows } = await setup();
    await projects.activate(first.id);
    await db
      .updateTable("projects")
      .set({ settings: JSON.stringify({ model: "cheap" }) })
      .execute();
    const [before] = await rows();

    const result = await projects.deactivate(first.id);

    expect(result).toMatchObject({ kind: "deactivated", changed: true });
    expect(result.kind === "deactivated" && result.project).toMatchObject({
      id: before?.id,
      active: false,
      settings: { model: "cheap" },
    });
    expect(await rows()).toHaveLength(1);
    expect(await projects.findActiveForRepository(first.id)).toBeUndefined();
  });

  it("does nothing for a repository that never had a project", async () => {
    const { projects, first, rows } = await setup();

    const result = await projects.deactivate(first.id);

    expect(result).toEqual({
      kind: "deactivated",
      project: undefined,
      changed: false,
    });
    expect(await rows()).toEqual([]);
  });

  // CR-24-T09
  it("reports an unknown repository", async () => {
    const { projects, rows } = await setup();

    expect(await projects.deactivate("no-such-repository")).toEqual({
      kind: "repository_not_found",
    });
    expect(await rows()).toEqual([]);
  });

  it("tells the callback inside the transaction, once per call that finds a project", async () => {
    const { projects, first, db } = await setup();
    await projects.activate(first.id);
    const seen: Array<{ active: boolean; inTransaction: boolean }> = [];

    await projects.deactivate(first.id, async (project, executor) => {
      seen.push({
        active: project.active,
        inTransaction: executor.isTransaction,
      });
    });
    await projects.deactivate(first.id, async (project, executor) => {
      seen.push({
        active: project.active,
        inTransaction: executor.isTransaction,
      });
    });

    expect(seen).toEqual([
      { active: false, inTransaction: true },
      { active: false, inTransaction: true },
    ]);
    expect(db.isTransaction).toBe(false);
  });

  it("stays active when the callback fails", async () => {
    const { projects, first } = await setup();
    await projects.activate(first.id);

    await expect(
      projects.deactivate(first.id, async () => {
        throw new Error("the jobs could not be discarded");
      }),
    ).rejects.toThrow("the jobs could not be discarded");

    expect(await projects.findActiveForRepository(first.id)).toMatchObject({
      active: true,
    });
  });
});

describe("looking a project up", () => {
  it("finds the active project of a repository by its id", async () => {
    const { projects, first, second } = await setup();
    await projects.activate(first.id);

    expect(await projects.findActiveForRepository(first.id)).toMatchObject({
      repositoryId: first.id,
    });
    expect(await projects.findActiveForRepository(second.id)).toBeUndefined();
  });

  it("finds the active project of a repository by the platform's id", async () => {
    const { projects, first, integration } = await setup();
    await projects.activate(first.id);

    expect(
      await projects.findActiveForExternalRepository(
        integration.id,
        first.externalId,
      ),
    ).toMatchObject({ repositoryId: first.id });
    expect(
      await projects.findActiveForExternalRepository(integration.id, "999"),
    ).toBeUndefined();
    expect(
      await projects.findActiveForExternalRepository(
        "other-integration",
        first.externalId,
      ),
    ).toBeUndefined();
  });

  // CR-21-T04 (the project half)
  it("keeps the project row of a repository that disappeared but no longer counts it as active", async () => {
    const { projects, first, repositories, integration, remote, rows } =
      await setup();
    await projects.activate(first.id);
    const [before] = await rows();

    await repositories.reconcile(integration.id, [remote(2)]);

    expect(await rows()).toEqual([before]);
    expect(await projects.findActiveForRepository(first.id)).toBeUndefined();
    expect(
      await projects.findActiveForExternalRepository(
        integration.id,
        first.externalId,
      ),
    ).toBeUndefined();
  });

  // CR-21-T05 (the project half)
  it("keeps the project rows when the whole installation is gone", async () => {
    const { projects, first, second, repositories, integration, rows } =
      await setup();
    await projects.activate(first.id);
    await projects.activate(second.id);
    const before = await rows();

    await repositories.deactivateAll(integration.id);

    expect(await rows()).toEqual(before);
    expect((await projects.list()).map((entry) => entry.status)).toEqual([
      "unavailable",
      "unavailable",
    ]);
  });
});

describe("finding one repository with its project", () => {
  it("returns the same entry the list has for it", async () => {
    const { projects, first } = await setup();
    await projects.activate(first.id);

    const found = await projects.find(first.id);

    expect(found).toEqual(
      (await projects.list()).find((entry) => entry.repository.id === first.id),
    );
    expect(found).toMatchObject({ status: "active" });
  });

  it("returns an entry without a project for a repository that was never activated", async () => {
    const { projects, second } = await setup();

    expect(await projects.find(second.id)).toMatchObject({
      project: null,
      status: "inactive",
    });
  });

  it("returns nothing for an unknown id and for a repository that disappeared and never had a project", async () => {
    const { projects, repositories, integration, second } = await setup();
    await repositories.deactivateAll(integration.id);

    expect(await projects.find("no-such-repository")).toBeUndefined();
    expect(await projects.find(second.id)).toBeUndefined();
  });
});

describe("listing the repositories with their projects", () => {
  it("shows every available repository with its status, ordered by name", async () => {
    const { projects, first, integration } = await setup();
    await projects.activate(first.id);

    const entries = await projects.list();

    expect(
      entries.map((entry) => [entry.repository.fullName, entry.status]),
    ).toEqual([
      ["acme/repo-1", "active"],
      ["acme/repo-2", "inactive"],
    ]);
    expect(entries[0]?.project).toMatchObject({ repositoryId: first.id });
    expect(entries[1]?.project).toBeNull();
    expect(entries[1]?.repository.integration).toEqual({
      id: integration.id,
      type: "github_app",
      displayName: "acme",
      status: "active",
    });
  });

  it("shows a deactivated project as inactive", async () => {
    const { projects, first } = await setup();
    await projects.activate(first.id);
    await projects.deactivate(first.id);

    const entries = await projects.list();

    expect(entries[0]).toMatchObject({
      status: "inactive",
      project: { active: false },
    });
  });

  // CR-24-T08
  it("shows a project whose repository disappeared as unavailable and hides a repository that never had one", async () => {
    const { projects, first, repositories, integration, remote } =
      await setup();
    await projects.activate(first.id);

    await repositories.reconcile(integration.id, [remote(2, "acme/repo-2")]);

    const entries = await projects.list();
    expect(
      entries.map((entry) => [entry.repository.fullName, entry.status]),
    ).toEqual([
      ["acme/repo-1", "unavailable"],
      ["acme/repo-2", "inactive"],
    ]);

    await repositories.reconcile(integration.id, []);
    const afterRemoval = await projects.list();
    expect(afterRemoval.map((entry) => entry.repository.fullName)).toEqual([
      "acme/repo-1",
    ]);
  });
});

describe("updating the settings of a project", () => {
  // CR-25-T11
  it("replaces the stored settings, moves the update time and leaves everything else alone", async () => {
    const { projects, first, rows } = await setup();
    await projects.activate(first.id);
    const before = (await rows())[0];

    const updated = await projects.updateSettings(first.id, {
      maxFindings: 2,
      allowedCommands: ["review"],
      fallbackModel: null,
    });

    expect(updated).toMatchObject({
      repositoryId: first.id,
      active: true,
      settings: {
        maxFindings: 2,
        allowedCommands: ["review"],
        fallbackModel: null,
      },
    });
    expect(updated?.updatedAt).not.toBe(before?.updated_at);
    expect(await projects.get(first.id)).toEqual(updated);
    const replaced = await projects.updateSettings(first.id, {
      maxFindings: 9,
    });
    expect(replaced?.settings).toEqual({ maxFindings: 9 });
  });

  it("reaches only the project of the repository it was asked for", async () => {
    const { projects, first, second } = await setup();
    await projects.activate(first.id);
    await projects.activate(second.id);

    await projects.updateSettings(first.id, { maxFindings: 2 });

    expect((await projects.get(second.id))?.settings).toEqual({});
  });

  // #80
  it("creates an inactive project for a repository that has none, so settings can be saved before activation", async () => {
    const { projects, first, rows } = await setup();

    const saved = await projects.updateSettings(first.id, { maxFindings: 2 });

    expect(saved).toMatchObject({
      repositoryId: first.id,
      active: false,
      settings: { maxFindings: 2 },
    });
    expect(await rows()).toHaveLength(1);
    expect(await projects.findActiveForRepository(first.id)).toBeUndefined();
    const listed = (await projects.list()).find(
      (entry) => entry.repository.id === first.id,
    );
    expect(listed?.status).toBe("inactive");
  });

  // #80
  it("keeps settings saved before the first activation when the project is activated", async () => {
    const { projects, first, rows } = await setup();
    await projects.updateSettings(first.id, { maxFindings: 2 });

    const result = await projects.activate(first.id);

    expect(result).toMatchObject({
      kind: "activated",
      outcome: "reactivated",
      project: { active: true, settings: { maxFindings: 2 } },
    });
    expect(await rows()).toHaveLength(1);
  });

  // #80
  it("stores settings for a repository of a suspended installation as an inactive project that cannot be activated", async () => {
    const { projects, integrations, integration, first } = await setup();
    await integrations.setStatus(integration.id, "disabled");

    const saved = await projects.updateSettings(first.id, { maxFindings: 2 });

    expect(saved).toMatchObject({
      active: false,
      settings: { maxFindings: 2 },
    });
    expect(await projects.activate(first.id)).toEqual({
      kind: "integration_unavailable",
    });
  });

  // #80
  it("ends a first save racing with an activation in one active project that keeps the saved settings", async () => {
    const { projects, first, rows } = await setup();

    await Promise.all([
      projects.updateSettings(first.id, { maxFindings: 2 }),
      projects.activate(first.id),
    ]);

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect((await projects.get(first.id))?.active).toBe(true);
    // Whichever ran first, the row ends up switched on.
    expect(stored[0]?.active).toBe(1);
  });

  // #80
  it("writes nothing for an unknown repository or one the platform no longer lists and that has no project", async () => {
    const { projects, first, rows, repositories, integration, remote } =
      await setup();
    await repositories.reconcile(integration.id, [remote(2)]);

    expect(
      await projects.updateSettings("no-such-repository", {}),
    ).toBeUndefined();
    expect(
      await projects.updateSettings(first.id, { maxFindings: 2 }),
    ).toBeUndefined();
    expect(await rows()).toEqual([]);
  });

  it("keeps the settings through a deactivation and a new activation", async () => {
    const { projects, first } = await setup();
    await projects.activate(first.id);
    await projects.updateSettings(first.id, { maxFindings: 2 });

    await projects.deactivate(first.id);
    const off = await projects.updateSettings(first.id, { maxFindings: 3 });
    await projects.activate(first.id);

    expect(off).toMatchObject({ active: false, settings: { maxFindings: 3 } });
    expect((await projects.get(first.id))?.settings).toEqual({
      maxFindings: 3,
    });
  });
});

describe("settings that are not valid JSON", () => {
  // CR-25-T11 (a damaged row must not take the project list or the claim down)
  it("read as no settings everywhere a project is read, with a warning that names the project and not the text", async () => {
    const { projectsWithWarning, first, db } = await setup();
    const warn = vi.fn();
    const projects = projectsWithWarning(warn);
    await projects.activate(first.id);
    await sql`update projects set settings = '{damaged secret-looking-text'`.execute(
      db,
    );

    const got = await projects.get(first.id);
    const active = await projects.findActiveForRepository(first.id);
    const listed = (await projects.list()).find(
      (entry) => entry.repository.id === first.id,
    );

    expect(got).toMatchObject({ active: true, settings: {} });
    expect(active?.settings).toEqual({});
    expect(listed?.project?.settings).toEqual({});
    expect(listed?.status).toBe("active");
    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) {
      const line = String(call[0]);
      expect(line).toContain("PROJECT_SETTINGS_UNREADABLE");
      expect(line).toContain(got?.id);
      expect(line).not.toContain("secret-looking-text");
    }
  });

  it("are replaced by the next save of settings", async () => {
    const { projectsWithWarning, first, db } = await setup();
    const projects = projectsWithWarning(() => undefined);
    await projects.activate(first.id);
    await sql`update projects set settings = 'nope'`.execute(db);

    const saved = await projects.updateSettings(first.id, { maxFindings: 2 });

    expect(saved?.settings).toEqual({ maxFindings: 2 });
  });
});
