// @vitest-environment jsdom
// Pins down the Runs page and the page of one run with real data: runs made through the job queue in
// a real SQLite file, the filter from the address, and the not-found case. Rendering is the real
// component tree.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectsRepository } from "../../db/repositories/projects-repository.ts";
import { createProjectService } from "../../projects/service.ts";
import { createLastRunSource } from "../runs-service.ts";
import { createRunsFixture } from "../../test-support/runs.ts";
import { loadRunDetailPage, RunDetailPageContent } from "./run-detail-page.tsx";
import { loadRunsPage, RunsPageContent } from "./runs-page.tsx";
import { defaultWorkspaceId } from "../../test-support/workspaces.ts";

afterEach(cleanup);

async function openRuns() {
  const f = await createRunsFixture();
  const projects = createProjectService({
    projects: createProjectsRepository(f.db, await defaultWorkspaceId(f.db)),
  });
  await projects.activateProject(f.repositoryId);
  await projects.activateProject(f.otherRepositoryId);
  const gadgetsFailed = await f.finished({ ok: false, errorCode: "timeout" });
  const gadgetsDone = await f.finished({
    ok: true,
    result: { ok: true, commentUrl: null },
  });
  const widgetsFailed = await f.finished(
    { ok: false, errorCode: "llm_quota" },
    { repositoryId: f.otherRepositoryId },
  );
  const widgetsWaiting = await f.waiting({
    repositoryId: f.otherRepositoryId,
  });
  const lastRuns = createLastRunSource({ runs: f.runsRepository });
  async function page(
    searchParams: Record<string, string | string[] | undefined> = {},
  ) {
    const data = await loadRunsPage(searchParams, {
      runs: f.runs,
      projects,
      lastRuns,
    });
    return render(<RunsPageContent data={data} />);
  }
  return {
    f,
    projects,
    page,
    gadgetsFailed,
    gadgetsDone,
    widgetsFailed,
    widgetsWaiting,
  };
}

function rowTexts(): string[] {
  return within(screen.getByRole("list", { name: "Runs" }))
    .getAllByRole("listitem")
    .map((row) => row.textContent ?? "");
}

describe("the Runs page", () => {
  // CR-35-T01
  it("lists the runs of both projects, the newest first", async () => {
    const app = await openRuns();

    await app.page();

    const rows = rowTexts();
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain(`acme/widgets #${app.widgetsWaiting.prNumber}`);
    expect(rows[0]).toContain("Waiting");
    expect(rows[1]).toContain(`acme/widgets #${app.widgetsFailed.prNumber}`);
    expect(rows[1]).toContain("Failed");
    expect(rows[2]).toContain(`acme/gadgets #${app.gadgetsDone.prNumber}`);
    expect(rows[2]).toContain("Succeeded");
    expect(rows[3]).toContain(`acme/gadgets #${app.gadgetsFailed.prNumber}`);
  });

  // CR-35-T02
  it("shows only the runs that match the project and then also the status from the address", async () => {
    const app = await openRuns();

    await app.page({ repository: app.f.repositoryId });
    expect(rowTexts()).toHaveLength(2);
    expect(rowTexts().every((row) => row.includes("acme/gadgets"))).toBe(true);
    cleanup();

    await app.page({ repository: app.f.repositoryId, status: "failed" });
    expect(rowTexts()).toHaveLength(1);
    expect(rowTexts()[0]).toContain("acme/gadgets");
    expect(rowTexts()[0]).toContain("Failed");
  });

  it("offers the projects and statuses in the filter and keeps the chosen ones selected", async () => {
    const app = await openRuns();

    await app.page({ repository: app.f.otherRepositoryId, status: "failed" });

    const project = screen.getByLabelText("Project") as HTMLSelectElement;
    const status = screen.getByLabelText("Status") as HTMLSelectElement;
    expect([...project.options].map((option) => option.text)).toEqual([
      "All projects",
      "acme/gadgets",
      "acme/widgets",
    ]);
    expect(project.value).toBe(app.f.otherRepositoryId);
    expect(status.value).toBe("failed");
    expect([...status.options].map((option) => option.text)).toEqual([
      "All statuses",
      "Waiting",
      "Running",
      "Succeeded",
      "Failed",
      "Cancelled",
      "Replaced",
    ]);
    expect(
      screen.getByRole("link", { name: "Reset filter" }).getAttribute("href"),
    ).toBe("/runs");
  });

  it("moves the selects with the address when the filter is reset or the person goes back", async () => {
    const app = await openRuns();
    const data = (
      searchParams: Record<string, string | string[] | undefined>,
    ) =>
      loadRunsPage(searchParams, {
        runs: app.f.runs,
        projects: createProjectService({
          projects: createProjectsRepository(app.f.db, app.f.workspaceId),
        }),
      });
    const { rerender } = render(
      <RunsPageContent
        data={await data({
          repository: app.f.repositoryId,
          status: "failed",
        })}
      />,
    );
    const values = () => [
      (screen.getByLabelText("Project") as HTMLSelectElement).value,
      (screen.getByLabelText("Status") as HTMLSelectElement).value,
    ];
    expect(values()).toEqual([app.f.repositoryId, "failed"]);

    // "Reset filter" is a link to /runs: the page renders again with no filter.
    rerender(<RunsPageContent data={await data({})} />);
    expect(values()).toEqual(["", ""]);

    // Back brings the filter back.
    rerender(<RunsPageContent data={await data({ status: "succeeded" })} />);
    expect(values()).toEqual(["", "succeeded"]);
  });

  // #80
  it("does not offer a repository that only holds saved settings, as it can never have runs", async () => {
    const f = await createRunsFixture();
    const projects = createProjectService({
      projects: createProjectsRepository(f.db, f.workspaceId),
    });
    await createProjectsRepository(f.db, f.workspaceId).updateSettings(
      f.repositoryId,
      {
        maxFindings: 2,
      },
    );
    const data = await loadRunsPage(
      {},
      {
        runs: f.runs,
        projects,
        lastRuns: createLastRunSource({ runs: f.runsRepository }),
      },
    );

    render(<RunsPageContent data={data} />);

    const project = screen.getByLabelText("Project") as HTMLSelectElement;
    expect([...project.options].map((option) => option.text)).toEqual([
      "All projects",
    ]);
  });

  // #80
  it("still offers a project that was switched off after it had runs", async () => {
    const app = await openRuns();
    await app.projects.deactivateProject(app.f.repositoryId);

    await app.page();

    const project = screen.getByLabelText("Project") as HTMLSelectElement;
    expect([...project.options].map((option) => option.text)).toEqual([
      "All projects",
      "acme/gadgets",
      "acme/widgets",
    ]);
  });

  // CR-35-T03
  it("explains an empty result and offers to reset the filter", async () => {
    const app = await openRuns();

    await app.page({ status: "running" });

    expect(
      screen.getByRole("heading", { name: "No runs for this filter" }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("link", { name: "Reset filter" }).length,
    ).toBeGreaterThan(0);
  });

  // CR-35-T03
  it("says there are no runs yet before the first one", async () => {
    const f = await createRunsFixture();
    const projects = createProjectService({
      projects: createProjectsRepository(f.db, await defaultWorkspaceId(f.db)),
    });
    const data = await loadRunsPage({}, { runs: f.runs, projects });

    render(<RunsPageContent data={data} />);

    expect(screen.getByRole("heading", { name: "No runs yet" })).toBeTruthy();
  });

  it("does not take a filter it does not know for no filter", async () => {
    const app = await openRuns();

    await app.page({ status: "exploded" });

    expect(
      screen.getByRole("heading", { name: "This filter is not valid" }),
    ).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Runs" })).toBeNull();
  });
});

describe("the page of one run", () => {
  // CR-35-T04
  it("shows the run with its error sentence, code and log", async () => {
    const app = await openRuns();
    const job = await app.f.finished(
      {
        ok: false,
        errorCode: "git_rate_limit",
        result: { ok: false, logTail: "429 from GitHub", logTruncated: false },
      },
      { triggerKind: "manual", actorLogin: "alice" },
    );
    const data = await loadRunDetailPage(job.id, { runs: app.f.runs });
    if (data.kind !== "ready") throw new Error("the run was not found");

    render(<RunDetailPageContent data={data} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      `acme/gadgets #${job.prNumber}`,
    );
    expect(
      screen.getByText(
        "GitHub is limiting requests right now. Try again later.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("git_rate_limit")).toBeTruthy();
    expect(screen.getByText("Started by alice")).toBeTruthy();
    expect(screen.getByText("429 from GitHub")).toBeTruthy();
  });

  // CR-35-T05
  it("finds nothing for an unknown or invalid id", async () => {
    const app = await openRuns();

    for (const id of ["00000000-0000-4000-8000-000000000000", "7", "x'--"]) {
      expect(await loadRunDetailPage(id, { runs: app.f.runs })).toEqual({
        kind: "not_found",
      });
    }
  });
});
