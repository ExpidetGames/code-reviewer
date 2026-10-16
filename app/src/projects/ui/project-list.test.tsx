// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down what the project list shows: each repository as a row of the compact table (name,
// installation, state, last run and switch), the empty state with one title and one primary action
// whose walkthrough sits behind a disclosure, the switch that explains itself through
// `aria-describedby`, and text from GitHub rendered as text that truncates.
// The calls behind the switch are in project-toggle.test.tsx.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    canConnect?: boolean;
    activationBlocked?: string | null;
  } = {},
) {
  const view: ProjectListView = { rows };
  return render(
    <ProjectList
      workspaceSlug="acme"
      view={view}
      canConnect={options.canConnect ?? true}
      activationBlocked={options.activationBlocked ?? null}
    />,
  );
}

/** The rows of repositories: every `row` but the header row. */
function repositoryRows(): HTMLElement[] {
  return screen.getAllByRole("row").slice(1);
}

describe("the project list without repositories", () => {
  // #173-T02, CR-34-T02, #103-IB-18
  it("shows one title and one primary action, with the walkthrough behind a disclosure", async () => {
    const user = userEvent.setup();
    renderList([]);

    expect(
      screen.getByRole("heading", { name: "No repositories yet" }),
    ).toBeTruthy();
    const action = screen.getByRole("link", { name: "Connect GitHub" });
    expect(action.getAttribute("href")).toBe("/w/acme/connections");

    const trigger = screen.getByRole("button", {
      name: "How to connect GitHub",
    });
    const steps = document.getElementById(
      trigger.getAttribute("aria-controls")!,
    );
    expect(steps?.hasAttribute("hidden")).toBe(true);
    expect(steps?.querySelectorAll("li")).toHaveLength(3);
    expect(screen.queryByRole("switch")).toBeNull();

    await user.click(trigger);

    expect(steps?.hasAttribute("hidden")).toBe(false);
  });

  // CR-34-T02, #103-IB-15
  it("tells a person who cannot connect GitHub to ask an Owner or Admin, without the steps", () => {
    renderList([], { canConnect: false });

    expect(screen.getByText(/An Owner or Admin of the workspace/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connections" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "How to connect GitHub" }),
    ).toBeNull();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
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

    const item = repositoryRows()[0]!;
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

    const [waiting, replaced] = repositoryRows();
    expect(waiting?.textContent).toContain("Waiting");
    expect(replaced?.textContent).toContain("Superseded");
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
    ).toBe("/w/acme/runs?repository=repo%20with%20space");
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
      ).toBe(`/w/acme/projects/${id}`);
  });

  // CR-34-T10, #173-T03
  it("keeps a project that is off from being switched on while the GitHub App is not configured, and describes the switch with the reason", () => {
    renderList([row()], {
      activationBlocked: "Configure the GitHub App first.",
    });

    const toggle = screen.getByRole("switch") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    const describedBy = toggle.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const reason = document.getElementById(describedBy!);
    expect(reason?.textContent).toBe("Configure the GitHub App first.");
    // The reason is announced with the switch and shown in the hint, not a paragraph on the row.
    expect(reason?.tagName).toBe("SPAN");
    expect(reason?.className).toContain("sr-only");
    expect(
      screen.getByRole("button", {
        name: "Why acme/widgets cannot be switched on",
      }),
    ).toBeTruthy();
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

  it("does not offer to switch on a repository the app can no longer read, and describes the switch with the reason", () => {
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
    // The blocked switch is described by the reason, which is also the hint next to it.
    const describedBy = withoutProject?.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      "The GitHub App can no longer read this repository.",
    );
    expect(
      screen.getByRole("button", {
        name: "Why acme/x cannot be switched on",
      }),
    ).toBeTruthy();
  });

  // CR-34-T13, #173-T04
  it("renders a very long repository name with HTML as text, runs nothing and truncates it", () => {
    const hostile = `acme/${"a".repeat(200)}<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>`;
    const { container } = renderList([
      row({ fullName: hostile, installation: "<b>acme</b>" }),
    ]);

    const name = screen.getByRole("link", { name: hostile });
    expect(name.className).toContain("truncate");
    // The untrusted installation name wraps instead of overflowing its fixed column.
    const installation = screen.getByText(/<b>acme<\/b>/);
    expect(installation.closest("td")?.className).toContain("break-words");
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
