// @vitest-environment jsdom
// Pins down what the project list shows: the empty state with the steps to install the GitHub App,
// "No run yet" for a project without a run, the status of the last run, the switch with its state,
// and text from GitHub rendered as text. The calls behind the switch are in project-toggle.test.tsx.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

import type { ProjectListView, ProjectRowView } from "./list-view.ts";
import { ProjectList } from "./project-list.tsx";

afterEach(cleanup);

function row(overrides: Partial<ProjectRowView> = {}): ProjectRowView {
  return {
    repositoryId: "repo-1",
    fullName: "acme/widgets",
    url: "https://github.com/acme/widgets",
    installation: "acme",
    status: "inactive",
    switchedOn: false,
    lastRun: null,
    ...overrides,
  };
}

function renderList(
  rows: ProjectRowView[],
  options: {
    installUrl?: string | null;
    activationBlocked?: string | null;
  } = {},
) {
  const view: ProjectListView = { rows };
  return render(
    <ProjectList
      view={view}
      installUrl={options.installUrl ?? null}
      activationBlocked={options.activationBlocked ?? null}
    />,
  );
}

describe("the project list without repositories", () => {
  // CR-34-T02
  it("explains in steps how to install the GitHub App and links to the installation page", () => {
    renderList([], {
      installUrl: "https://github.com/apps/code-reviewer/installations/new",
    });

    expect(
      screen.getByRole("heading", { name: "No repositories yet" }),
    ).toBeTruthy();
    const link = screen.getByRole("link", {
      name: "GitHub App installation page",
    });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/apps/code-reviewer/installations/new",
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("switch")).toBeNull();
  });

  // CR-34-T02
  it("still explains the steps when the app's address is not configured, naming the variable", () => {
    renderList([]);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/GITHUB_APP_SLUG/)).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
});

describe("the project list with repositories", () => {
  // CR-34-T03
  it("says that a project without a run has no run yet, not an empty field", () => {
    renderList([row({ switchedOn: true, status: "active" })]);

    expect(screen.getByText("No run yet")).toBeTruthy();
  });

  // CR-34-T01
  it("shows the status and the time of the last run next to the switch that is on", () => {
    renderList([
      row({
        switchedOn: true,
        status: "active",
        lastRun: { status: "succeeded", at: "2026-10-10T12:34:56Z" },
      }),
    ]);

    const item = screen.getByRole("listitem");
    expect(within(item).getByText(/Succeeded/)).toBeTruthy();
    expect(within(item).getByText("2026-10-10 12:34 UTC")).toBeTruthy();
    expect(within(item).getByText("Active")).toBeTruthy();
    expect(
      within(item)
        .getByRole("switch", { name: "Review acme/widgets" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("names a last run with the words of the Runs page", () => {
    renderList([
      row({
        repositoryId: "a",
        fullName: "acme/a",
        lastRun: { status: "queued", at: "2026-10-10T12:00:00Z" },
      }),
      row({
        repositoryId: "b",
        fullName: "acme/b",
        lastRun: { status: "superseded", at: "2026-10-10T12:00:00Z" },
      }),
    ]);

    const [waiting, replaced] = screen.getAllByRole("listitem");
    expect(waiting?.textContent).toContain("Last run: Waiting");
    expect(replaced?.textContent).toContain("Last run: Replaced");
  });

  it("links the last run to the runs of that project", () => {
    renderList([
      row({
        repositoryId: "repo with space",
        switchedOn: true,
        status: "active",
        lastRun: { status: "failed", at: "2026-10-10T12:34:56Z" },
      }),
    ]);

    expect(
      screen.getByRole("link", { name: "All runs" }).getAttribute("href"),
    ).toBe("/runs?repository=repo%20with%20space");
  });

  // CR-34-T01
  it("lists every repository, with the switch off for the inactive ones", () => {
    renderList([
      row({ repositoryId: "a", fullName: "acme/a" }),
      row({
        repositoryId: "b",
        fullName: "acme/b",
        switchedOn: true,
        status: "active",
      }),
      row({
        repositoryId: "c",
        fullName: "octocat/c",
        installation: "octocat",
      }),
      row({
        repositoryId: "d",
        fullName: "octocat/d",
        installation: "octocat",
      }),
    ]);

    const switches = screen.getAllByRole("switch");
    expect(switches.map((s) => s.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
  });

  // #80
  it("links the name of every repository to its settings, also one that was never activated", () => {
    renderList([
      row({ repositoryId: "a", fullName: "acme/a", status: "inactive" }),
      row({
        repositoryId: "b",
        fullName: "acme/b",
        switchedOn: true,
        status: "active",
      }),
      row({
        repositoryId: "c",
        fullName: "acme/c",
        switchedOn: true,
        status: "unavailable",
      }),
    ]);

    for (const id of ["a", "b", "c"])
      expect(
        screen.getByRole("link", { name: `acme/${id}` }).getAttribute("href"),
      ).toBe(`/projects/${id}`);
  });

  // CR-34-T10
  it("keeps a project that is off from being switched on while the GitHub App is not configured, and says why", () => {
    renderList([row()], {
      activationBlocked: "Configure the GitHub App first.",
    });

    const toggle = screen.getByRole("switch") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText("Configure the GitHub App first.")).toBeTruthy();
  });

  // CR-34-T10
  it("lets a project that is on be switched off even while the GitHub App is not configured", () => {
    renderList([row({ switchedOn: true, status: "active" })], {
      activationBlocked: "Configure the GitHub App first.",
    });

    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("does not offer to switch on a repository the app can no longer read, and says what happens if it comes back", () => {
    renderList([
      row({ status: "unavailable", switchedOn: true }),
      row({ repositoryId: "x", fullName: "acme/x", status: "unavailable" }),
    ]);

    const [withProject, withoutProject] = screen.getAllByRole(
      "switch",
    ) as HTMLButtonElement[];
    expect(withProject?.disabled).toBe(false);
    expect(withoutProject?.disabled).toBe(true);
    expect(
      screen.getByText(/resumes if the repository comes back/),
    ).toBeTruthy();
    expect(
      screen.getByText("The GitHub App can no longer read this repository."),
    ).toBeTruthy();
  });

  // CR-34-T13
  it("renders a repository name with HTML as text and runs nothing", () => {
    const hostile =
      'acme/<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>';
    const { container } = renderList([
      row({ fullName: hostile, installation: "<b>acme</b>" }),
    ]);

    expect(screen.getByText(hostile)).toBeTruthy();
    expect(screen.getByText(/<b>acme<\/b>/)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("leaves out the GitHub link when the repository has no web address", () => {
    renderList([row({ url: null })]);

    expect(screen.queryByRole("link", { name: /on GitHub/ })).toBeNull();
  });
});
