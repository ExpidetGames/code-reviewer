// @vitest-environment jsdom
// Pins down the Projects page with real data: the list is built from a real SQLite file filled by the
// sync against the fake GitHub, and the configuration hints follow the environment. The hints name
// variables and never values; a complete configuration shows none; a missing GitHub App setting
// blocks activating. Rendering is the real component tree; only the navigation hook is stood in.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

import { createProjectsRepository } from "../../db/repositories/projects-repository.ts";
import { describeConfigStatus } from "../../config-status/status.ts";
import { githubAppInstallUrl } from "../../config-status/status.ts";
import { testGithubAppEnv } from "../../test-support/github-app.ts";
import { startSyncHarness } from "../../test-support/integration-sync-harness.ts";
import { createProjectService } from "../service.ts";
import { loadProjectsPage, ProjectsPageContent } from "./projects-page.tsx";

afterEach(cleanup);

const LLM_KEY = "dummy-llm-key-0123456789";
const WORKING_ENV = {
  ...testGithubAppEnv(),
  LLM_PROVIDER: "openrouter",
  LLM_API_KEY: LLM_KEY,
};

async function openPage(env: Record<string, string | undefined> = WORKING_ENV) {
  const h = await startSyncHarness();
  h.fake.addInstallation({
    id: 4242,
    account: { login: "acme", id: 5001, type: "Organization" },
  });
  h.fake.setRepositories(4242, [
    { id: 7001, fullName: "acme/widgets" },
    { id: 7002, fullName: "acme/gadgets" },
  ]);
  h.fake.addInstallation({
    id: 4300,
    account: { login: "octocat", id: 583231, type: "User" },
  });
  h.fake.setRepositories(4300, [
    { id: 8001, fullName: "octocat/hello" },
    { id: 8002, fullName: "octocat/world" },
  ]);
  await h.sync.syncAll();
  const projects = createProjectService({
    projects: createProjectsRepository(h.db),
  });
  const widgets = (await h.repositories.list()).find(
    (repo) => repo.fullName === "acme/widgets",
  );
  await projects.activateProject(widgets!.id);
  const data = await loadProjectsPage({
    projects,
    config: () => describeConfigStatus(env),
    installUrl: () => githubAppInstallUrl(env),
  });
  return render(<ProjectsPageContent data={data} />);
}

describe("the Projects page", () => {
  // CR-34-T01
  it("lists the four repositories of two installations, the activated one with its switch on", async () => {
    await openPage();

    const items = within(
      screen.getByRole("list", { name: "Repositories" }),
    ).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    const on = screen
      .getAllByRole("switch")
      .filter((toggle) => toggle.getAttribute("aria-checked") === "true");
    expect(on.map((toggle) => toggle.getAttribute("aria-label"))).toEqual([
      "Review acme/widgets",
    ]);
    const widgets = items.find((item) =>
      within(item).queryByText("acme/widgets"),
    );
    expect(within(widgets!).getByText("Active")).toBeTruthy();
    expect(within(widgets!).getByText("No run yet")).toBeTruthy();
  });

  // CR-34-T11
  it("shows no configuration hint when every value is there", async () => {
    await openPage();

    expect(
      screen.queryByRole("region", { name: "Configuration problems" }),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // CR-34-T09
  it("shows 'LLM key missing' without any key value when no LLM key is set", async () => {
    const { container } = await openPage({
      ...WORKING_ENV,
      LLM_API_KEY: undefined,
    });

    expect(screen.getByText("LLM key missing")).toBeTruthy();
    expect(container.textContent).not.toContain(LLM_KEY);
  });

  // CR-34-T09
  it("never shows the LLM key, also while the page is fine", async () => {
    const { container } = await openPage();

    expect(container.textContent).not.toContain(LLM_KEY);
    expect(container.innerHTML).not.toContain(LLM_KEY);
  });

  // CR-34-T10
  it("names the missing GitHub App variables and disables switching a project on", async () => {
    const { container } = await openPage({
      ...WORKING_ENV,
      GITHUB_APP_ID: undefined,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_APP_WEBHOOK_SECRET: undefined,
    });

    const hint = screen
      .getByText("GitHub App not configured")
      .closest("div") as HTMLElement;
    for (const name of [
      "GITHUB_APP_ID",
      "GITHUB_APP_WEBHOOK_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
    ])
      expect(hint.textContent).toContain(name);
    expect(container.innerHTML).not.toContain(
      WORKING_ENV.GITHUB_APP_PRIVATE_KEY ?? "x",
    );
    const switches = screen.getAllByRole("switch") as HTMLButtonElement[];
    const off = switches.filter(
      (toggle) => toggle.getAttribute("aria-checked") === "false",
    );
    expect(off.length).toBe(3);
    expect(off.every((toggle) => toggle.disabled)).toBe(true);
    // The project that is on can still be switched off.
    const on = switches.find(
      (toggle) => toggle.getAttribute("aria-checked") === "true",
    );
    expect(on?.disabled).toBe(false);
  });
});
