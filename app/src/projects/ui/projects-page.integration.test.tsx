// SPDX-License-Identifier: LicenseRef-Proprietary

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
import {
  describeConfigStatus,
  statusForMembers,
  type ConfigAudience,
  type GithubAppStatus,
} from "../../config-status/status.ts";
import {
  testGithubAppEnv,
  testGithubAppStatus,
} from "../../test-support/github-app.ts";
import { startSyncHarness } from "../../test-support/integration-sync-harness.ts";
import { createProjectService } from "../service.ts";
import type { AttentionNotice } from "../../components/needs-attention.tsx";
import { loadProjectsPage, ProjectsPageContent } from "./projects-page.tsx";
import { defaultWorkspaceId } from "../../test-support/workspaces.ts";

afterEach(cleanup);

const LLM_KEY = "dummy-llm-key-0123456789";
const WORKING_ENV: Record<string, string | undefined> = {
  ...testGithubAppEnv(),
  LLM_PROVIDER: "openrouter",
  LLM_API_KEY: LLM_KEY,
};
const MISSING_GITHUB: GithubAppStatus = {
  configured: false,
  kind: "missing",
  variables: ["app_id", "github_app_webhook_secret", "github_app_private_key"],
  slug: null,
};

async function openPage(
  github: GithubAppStatus = testGithubAppStatus(),
  audience: ConfigAudience = "operator",
  llmNotice: AttentionNotice | null = null,
) {
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
    projects: createProjectsRepository(h.db, await defaultWorkspaceId(h.db)),
  });
  const widgets = (await h.repositories.list()).find(
    (repo) => repo.fullName === "acme/widgets",
  );
  await projects.activateProject(widgets!.id);
  const data = await loadProjectsPage({
    projects,
    // What the page file does: the whole status for the instance admin, the reduced one for a member.
    config: () =>
      audience === "operator"
        ? describeConfigStatus({}, github)
        : statusForMembers(describeConfigStatus({}, github)),
  });
  return render(
    <ProjectsPageContent
      workspaceSlug="acme"
      audience={audience}
      llmNotice={llmNotice}
      data={data}
    />,
  );
}

describe("the Projects page", () => {
  // #173-T01
  it("has exactly one Needs attention region, also with a configuration hint and the LLM hint", async () => {
    await openPage(MISSING_GITHUB, "operator", {
      id: "llm_access",
      severity: "error",
      title: "LLM not configured",
      detail: "Reviews of this workspace cannot run until it has an LLM key.",
    });

    const regions = screen.getAllByRole("region", { name: "Needs attention" });
    expect(regions).toHaveLength(1);
    expect(
      within(regions[0]!).getByText("GitHub App not configured"),
    ).toBeTruthy();
    expect(within(regions[0]!).getByText("LLM not configured")).toBeTruthy();
  });

  // CR-34-T01
  it("lists the four repositories of two installations, the activated one with its switch on", async () => {
    await openPage();

    const items = within(screen.getByRole("table", { name: "Repositories" }))
      .getAllByRole("row")
      .slice(1);
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
      screen.queryByRole("region", { name: "Needs attention" }),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // #104-LK-13 (the hint about the workspace's LLM key is src/llm/ui/llm-access-notice.tsx)
  it("does not report an absent LLM variable, and shows no key value", async () => {
    const { container } = await openPage();

    expect(screen.queryByText("LLM key missing")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.textContent).not.toContain(LLM_KEY);
  });

  // CR-34-T09
  it("never shows the LLM key, also while the page is fine", async () => {
    const { container } = await openPage();

    expect(container.textContent).not.toContain(LLM_KEY);
    expect(container.innerHTML).not.toContain(LLM_KEY);
  });

  // CR-34-T10
  it("names the missing GitHub App fields and disables switching a project on", async () => {
    const { container } = await openPage(MISSING_GITHUB);

    const region = screen.getByRole("region", { name: "Needs attention" });
    expect(region.textContent).toContain("GitHub App not configured");
    for (const name of [
      "app_id",
      "github_app_webhook_secret",
      "github_app_private_key",
    ])
      expect(region.textContent).toContain(name);
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

  // #101-WM-08
  it("tells a member that GitHub is not set up and to ask the instance admin, without a variable name, and still blocks activating", async () => {
    const { container } = await openPage(MISSING_GITHUB, "member");

    expect(screen.getByText("GitHub is not set up yet")).toBeTruthy();
    expect(screen.queryByText("Reviews are not set up yet")).toBeNull();
    expect(container.textContent).toContain("Ask your instance admin");
    expect(container.textContent).not.toMatch(
      /GITHUB_APP|LLM_|GitHub App not configured/,
    );
    const switches = screen.getAllByRole("switch") as HTMLButtonElement[];
    const off = switches.filter(
      (toggle) => toggle.getAttribute("aria-checked") === "false",
    );
    expect(off.every((toggle) => toggle.disabled)).toBe(true);
  });

  // #101-WM-08
  it("shows a member of a working instance no hint at all", async () => {
    await openPage(undefined, "member");

    expect(
      screen.queryByRole("region", { name: "Needs attention" }),
    ).toBeNull();
  });
});
