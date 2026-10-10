// Pins down what the project list is built from: the repositories of all installations as the sync
// stored them (real SQLite, real provider against the fake GitHub), with the state of their
// projects. Activating and deactivating through the real route handler shows in the next load.
import { describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth/access-policy.ts";
import { createProjectsRepository } from "../../db/repositories/projects-repository.ts";
import { createRunsRepository } from "../../db/repositories/runs-repository.ts";
import { createJobQueue } from "../../jobs/job-queue.ts";
import { createLastRunSource } from "../../runs/runs-service.ts";
import { startSyncHarness } from "../../test-support/integration-sync-harness.ts";
import { createProjectRouteHandler } from "../http.ts";
import { createProjectService } from "../service.ts";
import { loadProjectList, type LastRunSource } from "./list-view.ts";

const ACME = { login: "acme", id: 5001, type: "Organization" } as const;
const OCTOCAT = { login: "octocat", id: 583231, type: "User" } as const;

async function startList() {
  const h = await startSyncHarness();
  h.fake.addInstallation({ id: 4242, account: ACME });
  h.fake.setRepositories(4242, [
    { id: 7001, fullName: "acme/widgets" },
    { id: 7002, fullName: "acme/gadgets" },
    { id: 7003, fullName: "acme/<img src=x onerror=alert(1)>" },
  ]);
  h.fake.addInstallation({ id: 4300, account: OCTOCAT });
  h.fake.setRepositories(4300, [{ id: 8001, fullName: "octocat/hello" }]);
  await h.sync.syncAll();
  const projects = createProjectService({
    projects: createProjectsRepository(h.db),
  });
  const handler = createProjectRouteHandler({
    requireUser: async () => ({ id: "u1" }) as unknown as SessionUser,
    service: projects,
  });
  async function put(repositoryId: string, active: boolean) {
    return handler(
      new Request(`https://app.test/api/repositories/${repositoryId}/project`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active }),
      }),
      repositoryId,
    );
  }
  async function idOf(fullName: string) {
    const repo = (await h.repositories.list()).find(
      (candidate) => candidate.fullName === fullName,
    );
    if (repo === undefined) throw new Error(`no ${fullName}`);
    return repo.id;
  }
  return { ...h, projects, put, idOf };
}

describe("the project list", () => {
  // CR-34-T01
  it("lists every repository of both installations, only the activated one with its switch on", async () => {
    const app = await startList();
    await app.projects.activateProject(await app.idOf("acme/widgets"));

    const view = await loadProjectList({ projects: app.projects });

    expect(
      view.rows.map((row) => [row.fullName, row.installation, row.status]),
    ).toEqual([
      ["acme/<img src=x onerror=alert(1)>", "acme", "inactive"],
      ["acme/gadgets", "acme", "inactive"],
      ["acme/widgets", "acme", "active"],
      ["octocat/hello", "octocat", "inactive"],
    ]);
    expect(
      view.rows.filter((row) => row.switchedOn).map((row) => row.fullName),
    ).toEqual(["acme/widgets"]);
  });

  // CR-34-T01
  it("shows the status of the last run of the activated repository", async () => {
    const app = await startList();
    const widgets = await app.idOf("acme/widgets");
    await app.projects.activateProject(widgets);
    const lastRuns: LastRunSource = async () =>
      new Map([[widgets, { status: "succeeded", at: "2026-10-10T12:00:00Z" }]]);

    const view = await loadProjectList({ projects: app.projects, lastRuns });

    expect(
      view.rows.map((row) => [row.fullName, row.lastRun?.status ?? null]),
    ).toEqual([
      ["acme/<img src=x onerror=alert(1)>", null],
      ["acme/gadgets", null],
      ["acme/widgets", "succeeded"],
      ["octocat/hello", null],
    ]);
  });

  // CR-34-T01
  it("takes the last run from the jobs table: running while a runner works, then how it ended", async () => {
    const app = await startList();
    const widgets = await app.idOf("acme/widgets");
    const gadgets = await app.idOf("acme/gadgets");
    await app.projects.activateProject(widgets);
    await app.projects.activateProject(gadgets);
    const queue = createJobQueue(app.db);
    const lastRuns = createLastRunSource({
      runs: createRunsRepository(app.db),
    });
    const prUrl = "https://github.com/acme/widgets/pull/1";
    const created = await queue.enqueue({
      repositoryId: widgets,
      prNumber: 1,
      prUrl,
      headSha: "a".repeat(40),
      command: "review",
      triggerKind: "webhook",
      actorLogin: "octocat",
    });
    const lastRunOf = async (repositoryId: string) =>
      (await loadProjectList({ projects: app.projects, lastRuns })).rows.find(
        (row) => row.repositoryId === repositoryId,
      )?.lastRun ?? null;

    expect(await lastRunOf(widgets)).toMatchObject({ status: "queued" });
    expect(await lastRunOf(gadgets)).toBeNull();

    const claim = await queue.claimNext("runner-1");
    expect(await lastRunOf(widgets)).toMatchObject({ status: "running" });

    if (created.status !== "created" || claim === null)
      throw new Error("the job was not handed out");
    await queue.complete(created.job.id, claim.leaseToken, {
      ok: false,
      errorCode: "timeout",
    });
    const finished = await lastRunOf(widgets);
    expect(finished).toMatchObject({ status: "failed" });
    expect(finished?.at).toBe((await queue.get(created.job.id))?.finishedAt);
    expect(await lastRunOf(gadgets)).toBeNull();
  });

  // CR-34-T03
  it("has no last run for a project that never had one", async () => {
    const app = await startList();
    await app.projects.activateProject(await app.idOf("acme/gadgets"));

    const view = await loadProjectList({ projects: app.projects });

    expect(view.rows.every((row) => row.lastRun === null)).toBe(true);
  });

  // CR-34-T04
  it("shows a repository as active after the route switched it on and as inactive after it was switched off", async () => {
    const app = await startList();
    const gadgets = await app.idOf("acme/gadgets");
    const statusOf = async () =>
      (await loadProjectList({ projects: app.projects })).rows.find(
        (row) => row.repositoryId === gadgets,
      );

    expect((await app.put(gadgets, true)).status).toBe(200);
    expect(await statusOf()).toMatchObject({
      status: "active",
      switchedOn: true,
      hasProject: true,
    });

    expect((await app.put(gadgets, false)).status).toBe(200);
    expect(await statusOf()).toMatchObject({
      status: "inactive",
      switchedOn: false,
      hasProject: true,
    });
  });

  it("shows a repository GitHub no longer lists as unavailable and keeps a project it had", async () => {
    const app = await startList();
    const hello = await app.idOf("octocat/hello");
    await app.projects.activateProject(hello);
    app.fake.setRepositories(4300, []);
    await app.sync.syncAll();

    const view = await loadProjectList({ projects: app.projects });

    expect(view.rows.find((row) => row.repositoryId === hello)).toMatchObject({
      status: "unavailable",
      hasProject: true,
      switchedOn: true,
    });
  });
});
