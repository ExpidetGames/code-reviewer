// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the settings page of a project with real data: a repository that was never activated,
// a project that follows the defaults, the effect of changing the global defaults, a value saved on
// the project, and text from GitHub rendered as text. The page carries exactly one form (the manual
// review panel lives on its own page since #174), the estimated cost sits in the Model card and the
// trail starts at the Projects list. Real SQLite, the real services and routes' handlers; the rendering
// is the real component tree.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

import type { SessionUser } from "../../auth/access-policy.ts";
import {
  describeConfigStatus,
  statusForMembers,
} from "../../config-status/status.ts";
import { createProjectsRepository } from "../../db/repositories/projects-repository.ts";
import { createReviewSettingsRouteHandlers } from "../../review-settings/http.ts";
import { createProjectSettingsApi } from "../../review-settings/ui/api.ts";
import { setupReviewSettings } from "../../test-support/review-settings-harness.ts";
import { testGithubAppStatus } from "../../test-support/github-app.ts";
import { createProjectService } from "../service.ts";
import {
  loadProjectSettingsPage,
  ProjectSettingsPageContent,
  type ProjectSettingsPageData,
} from "./project-settings-page.tsx";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import { TEST_DEFAULT_SKILL } from "../../test-support/review-settings-harness.ts";
import { createIntegrationsRepository } from "../../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../../db/repositories/repositories-repository.ts";
import { createReviewSettingsService } from "../../review-settings/service.ts";
import { createAppSettingsRepository } from "../../db/repositories/app-settings-repository.ts";
import { builtInReviewSettings } from "../../review-settings/settings.ts";

afterEach(cleanup);

async function openProject(
  options: { activate?: boolean; dynamicReviewEnabled?: boolean } = {},
) {
  const s = await setupReviewSettings();
  const projects = createProjectService({
    projects: createProjectsRepository(s.db, await defaultWorkspaceId(s.db)),
  });
  if (options.activate !== false) await projects.activateProject(s.first.id);
  const handlers = createReviewSettingsRouteHandlers({
    requireUser: async () =>
      ({ githubLogin: "octocat" }) as unknown as SessionUser,
    service: s.service,
  });
  // The form's API client, wired to the real handlers instead of the network.
  const api = createProjectSettingsApi(
    async (url, init) => {
      const request = new Request(`https://app.test${url}`, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          "sec-fetch-site": "same-origin",
        },
      });
      if (init?.method === "PUT")
        return handlers.putProject(request, s.first.id);
      if (init?.method === "DELETE")
        return handlers.deleteProject(request, s.first.id);
      return handlers.getProject(request, s.first.id);
    },
    "acme",
    s.first.id,
  );
  async function load(repositoryId = s.first.id) {
    return loadProjectSettingsPage(repositoryId, {
      projects,
      settings: s.service,
      config: () => describeConfigStatus({}, testGithubAppStatus()),
      dynamicReviewEnabled: async () => options.dynamicReviewEnabled ?? false,
    });
  }
  return { ...s, projects, api, load };
}

function renderReady(
  app: Awaited<ReturnType<typeof openProject>>,
  data: Extract<ProjectSettingsPageData, { kind: "ready" }>,
  options: { audience?: "member" | "operator" } = {},
) {
  return render(
    <ProjectSettingsPageContent
      workspaceSlug="acme"
      audience={options.audience ?? "member"}
      data={data}
      api={app.api}
    />,
  );
}

describe("the settings page of a repository that was never activated", () => {
  // #80
  it("shows the form with the default settings and says that no reviews run until it is activated", async () => {
    const app = await openProject({ activate: false });
    const data = await app.load();
    if (data.kind !== "ready") throw new Error("expected the form");

    renderReady(app, data);

    expect(
      screen.getByText(/No reviews run until the project is activated/),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Save review settings" }),
    ).toBeTruthy();
    // The manual review panel is its own page since #174, never on the settings page.
    expect(
      screen.queryByRole("heading", { name: "Open pull requests" }),
    ).toBeNull();
    expect(await app.projectRows()).toEqual([]);
  });

  // #80
  it("saves a setting without activating the repository, and the saved value is there after activation", async () => {
    const user = userEvent.setup();
    const app = await openProject({ activate: false });
    const data = await app.load();
    if (data.kind !== "ready") throw new Error("expected the form");
    renderReady(app, data);

    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "11");
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect((await screen.findByRole("status")).textContent).toMatch(/Saved\./);
    expect(await app.projectRows()).toMatchObject([
      { active: 0, settings: expect.stringContaining('"maxFindings":11') },
    ]);
    expect(
      await app.projects.getActiveProjectForRepository(app.first.id),
    ).toBeUndefined();

    await app.projects.activateProject(app.first.id);
    const after = await app.load();
    if (after.kind !== "ready") throw new Error("expected the form");
    expect(after.row.status).toBe("active");
    expect(after.model.effective.maxFindings).toBe(11);
  });

  it("is not found for a repository id nobody knows", async () => {
    const app = await openProject();

    expect(await app.load("no-such-repository")).toEqual({ kind: "not_found" });
  });
});

describe("the settings page of a project", () => {
  // #174-T01
  it("has exactly one form and shows the estimated cost inside the Model card", async () => {
    const app = await openProject();
    const data = await app.load();
    if (data.kind !== "ready") throw new Error("expected a project");

    const { container } = renderReady(app, data);

    expect(container.querySelectorAll("form")).toHaveLength(1);
    const modelCard = screen
      .getByRole("heading", { name: "Model" })
      .closest('[data-slot="card"]') as HTMLElement;
    expect(
      within(modelCard).getByText(/Estimated cost per review/),
    ).toBeTruthy();
  });

  // #174-T03
  it("offers a Review now action that leads to the review page of the same project", async () => {
    const app = await openProject();
    const data = await app.load();
    if (data.kind !== "ready") throw new Error("expected a project");

    renderReady(app, data);

    const action = screen.getByRole("link", {
      name: `Review ${data.row.fullName} now`,
    });
    expect(action.getAttribute("href")).toBe(
      `/w/acme/projects/${app.first.id}/review`,
    );
    const sections = screen.getByRole("navigation", { name: "Project" });
    expect(
      within(sections)
        .getByRole("link", { name: "Review now" })
        .getAttribute("href"),
    ).toBe(`/w/acme/projects/${app.first.id}/review`);
    expect(
      within(sections)
        .getByRole("link", { name: "Settings" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  // CR-34-T04
  it("starts with the global defaults after it was activated", async () => {
    const app = await openProject();
    await app.service.updateGlobalSettings({ maxFindings: 8 }, "octocat");

    const data = await app.load();
    if (data.kind !== "ready") throw new Error("expected a project");

    expect(data.model.overrides).toEqual({});
    expect(data.model.effective.maxFindings).toBe(8);
    expect(data.model.sources.maxFindings).toBe("global");
  });

  // CR-34-T08
  it("follows a changed global default unless the project has its own value", async () => {
    const app = await openProject();
    await app.service.updateProjectSettings(app.first.id, { maxFindings: 3 });
    await app.service.updateGlobalSettings(
      { maxFindings: 8, maxTokens: 50_000 },
      "octocat",
    );

    const data = await app.load();
    if (data.kind !== "ready") throw new Error("expected a project");

    expect(data.model.effective.maxFindings).toBe(3);
    expect(data.model.effective.maxTokens).toBe(50_000);
    renderReady(app, data);
    const own = screen
      .getByLabelText("Most findings per review")
      .closest("[data-field]") as HTMLElement;
    const inherited = screen
      .getByLabelText("Token budget")
      .closest("[data-field]") as HTMLElement;
    expect(within(own).getByText("Set for this project")).toBeTruthy();
    expect(within(inherited).getByText("Global default")).toBeTruthy();
  });

  // A page that was left stays mounted (Cache Components) and is shown again with fresh data.
  it("shows the new value and its source when the page is rendered again after a global default changed", async () => {
    const app = await openProject();
    const before = await app.load();
    if (before.kind !== "ready") throw new Error("expected a project");
    const view = renderReady(app, before);
    expect(
      (screen.getByLabelText("Token budget") as HTMLInputElement).value,
    ).toBe("100000");

    await app.service.updateGlobalSettings({ maxTokens: 70_000 }, "octocat");
    const after = await app.load();
    if (after.kind !== "ready") throw new Error("expected a project");
    view.rerender(
      <ProjectSettingsPageContent
        workspaceSlug="acme"
        data={after}
        api={app.api}
      />,
    );

    const field = screen
      .getByLabelText("Token budget")
      .closest("[data-field]") as HTMLElement;
    expect(
      (screen.getByLabelText("Token budget") as HTMLInputElement).value,
    ).toBe("70000");
    expect(within(field).getByText("Global default")).toBeTruthy();
  });

  // CR-34-T05
  it("saves a valid change through the route and the next job resolves the new value, while an earlier snapshot keeps the old one", async () => {
    const user = userEvent.setup();
    const app = await openProject();
    const running = await app.service.resolveForRepository(app.first.id);
    const data = await app.load();
    if (data.kind !== "ready") throw new Error("expected a project");
    renderReady(app, data);

    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "11");
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect((await screen.findByRole("status")).textContent).toMatch(/Saved\./);
    const next = await app.service.resolveForRepository(app.first.id);
    expect(next?.settings.maxFindings).toBe(11);
    expect(running?.settings.maxFindings).toBe(5);
    expect(await app.projectRows()).toMatchObject([
      { settings: expect.stringContaining('"maxFindings":11') },
    ]);
  });

  // CR-34-T07
  it("shows the refusal of the route at the field and stores nothing", async () => {
    const user = userEvent.setup();
    const app = await openProject();
    const before = await app.projectRows();
    const data = await app.load();
    if (data.kind !== "ready") throw new Error("expected a project");
    // A budget the model cannot hold: the client check passes, the service refuses.
    renderReady(app, data);

    const model = screen.getByLabelText("Model");
    await user.clear(model);
    await user.type(model, "deepseek/deepseek-v3.2");
    const tokens = screen.getByLabelText("Token budget");
    await user.clear(tokens);
    await user.type(tokens, "500000");
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    const field = tokens.closest("[data-field]") as HTMLElement;
    expect(
      await within(field).findByText(/context window of the chosen model/),
    ).toBeTruthy();
    expect(await app.projectRows()).toEqual(before);
  });

  it("offers no manual review on the settings page while the project is switched off, and says why", async () => {
    const app = await openProject();
    await app.projects.deactivateProject(app.first.id);
    const data = await app.load();
    if (data.kind !== "ready") throw new Error("expected a project");

    renderReady(app, data);

    expect(
      screen.queryByRole("heading", { name: "Open pull requests" }),
    ).toBeNull();
    expect(screen.getByText("Project is inactive")).toBeTruthy();
    expect(
      screen.getByText(/No reviews run until the project is activated/),
    ).toBeTruthy();
  });

  // CR-34-T13
  it("renders a repository name with HTML as text", async () => {
    const app = await openProject();
    await app.db
      .updateTable("repositories")
      .set({ full_name: "acme/<img src=x onerror=alert(1)>" })
      .where("id", "=", app.first.id)
      .execute();
    const data = await app.load();
    if (data.kind === "not_found") throw new Error("expected the repository");

    const { container } = renderReady(app, data);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "acme/<img src=x onerror=alert(1)>",
    );
    expect(container.querySelector("img")).toBeNull();
  });

  // #101-WM-08
  it("tells a member nothing about the LLM variables of the instance (the workspace notice says whether reviews have a key)", async () => {
    const app = await openProject();
    const data = await loadProjectSettingsPage(app.first.id, {
      projects: app.projects,
      settings: app.service,
      // What the page file does for a person who does not run the instance.
      config: () =>
        statusForMembers(describeConfigStatus({}, testGithubAppStatus())),
    });
    if (data.kind !== "ready") throw new Error("expected the form");

    const { container } = render(
      <ProjectSettingsPageContent
        workspaceSlug="acme"
        audience="member"
        data={data}
        api={app.api}
      />,
    );

    expect(screen.queryByText("Reviews are not set up yet")).toBeNull();
    expect(container.textContent).not.toMatch(/GITHUB_APP|LLM_/);
  });
});

// #200-T05, #200-T07
describe("the Review kind card of the settings page of a project", () => {
  const SAVE = { name: "Save review settings" };

  async function readyPage(options: Parameters<typeof openProject>[0] = {}) {
    const app = await openProject(options);
    const data = await app.load();
    if (data.kind !== "ready") throw new Error("expected a project");
    const view = renderReady(app, data);
    return { app, data, view };
  }

  it("shows the real default model and skill of a project that never chose a kind, and says Dynamic Review is not enabled yet", async () => {
    const { data } = await readyPage();

    expect(data.dynamicReviewEnabled).toBe(false);
    expect(
      screen
        .getByRole("radio", { name: "Diff Review" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText("Not enabled on this instance yet.")).toBeTruthy();
  });

  it("does not say anything about the gate when the instance has Dynamic Review enabled", async () => {
    const { data } = await readyPage({ dynamicReviewEnabled: true });

    expect(data.dynamicReviewEnabled).toBe(true);
    expect(screen.queryByText(/Not enabled on this instance/)).toBeNull();
  });

  it("stores a switch to Dynamic Review with its model and skill, shows them after a reload, and resets the skill to the shipped default", async () => {
    const user = userEvent.setup();
    const { app, view } = await readyPage({ dynamicReviewEnabled: true });

    await user.click(screen.getByRole("radio", { name: "Dynamic Review" }));
    const model = screen.getByLabelText("Dynamic Review model");
    await user.clear(model);
    await user.type(model, "vendor/agent-1");
    await user.click(screen.getByRole("button", { name: "Edit skill" }));
    const skill = screen.getByLabelText("Review skill");
    await user.clear(skill);
    await user.type(skill, "Look for security problems only.");
    await user.click(screen.getByRole("button", SAVE));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Switch to Dynamic Review",
      }),
    );
    expect((await screen.findByRole("status")).textContent).toMatch(/Saved\./);

    const stored = JSON.parse((await app.projectRows())[0]?.settings ?? "{}");
    expect(stored).toMatchObject({
      reviewKind: "dynamic",
      dynamicModel: "vendor/agent-1",
      reviewSkill: "Look for security problems only.",
    });
    const reloaded = await app.load();
    if (reloaded.kind !== "ready") throw new Error("expected a project");
    expect(reloaded.model.dynamic?.effective).toEqual({
      reviewKind: "dynamic",
      dynamicModel: "vendor/agent-1",
      reviewSkill: "Look for security problems only.",
    });

    // Resetting the skill is staged, and stored only by the save; it removes only the skill override.
    await user.click(
      screen.getByRole("button", { name: "Reset review skill to default" }),
    );
    expect(
      JSON.parse((await app.projectRows())[0]?.settings ?? "{}"),
    ).toHaveProperty("reviewSkill");
    await user.click(screen.getByRole("button", SAVE));
    await screen.findByText(/Saved\./);
    const afterReset = JSON.parse(
      (await app.projectRows())[0]?.settings ?? "{}",
    );
    expect(afterReset).not.toHaveProperty("reviewSkill");
    expect(afterReset).toMatchObject({
      reviewKind: "dynamic",
      dynamicModel: "vendor/agent-1",
    });
    const final = await app.load();
    if (final.kind !== "ready") throw new Error("expected a project");
    expect(final.model.dynamic?.reviewSkillIsDefault).toBe(true);
    expect(final.model.dynamic?.effective.reviewSkill).toBe(
      TEST_DEFAULT_SKILL.text,
    );
    view.unmount();
  });

  // Lead note (1): an untouched form must never clear the Diff overrides.
  it("stores nothing when the form is saved untouched, and keeps the Diff overrides another client set meanwhile", async () => {
    const user = userEvent.setup();
    const { app } = await readyPage();
    // Another client saves a Diff override after this form was loaded.
    await app.service.updateProjectSettings(app.first.id, { maxFindings: 17 });
    const before = await app.projectRows();

    await user.click(screen.getByRole("button", SAVE));

    expect((await screen.findByRole("status")).textContent).toMatch(
      /No changes to save/,
    );
    expect(await app.projectRows()).toEqual(before);
  });

  // Lead note (2): the explicit Diff-group reset together with a kind switch.
  it("resets the Diff overrides and switches the kind in one save, keeping what was not touched", async () => {
    const user = userEvent.setup();
    const app = await openProject({ dynamicReviewEnabled: true });
    await app.service.updateProjectSettings(app.first.id, {
      maxFindings: 9,
      reviewSkill: "My skill",
    });
    const data = await app.load();
    if (data.kind !== "ready") throw new Error("expected a project");
    renderReady(app, data);

    await user.click(
      screen.getByRole("button", {
        name: "Reset to default for Most findings per review",
      }),
    );
    await user.click(screen.getByRole("radio", { name: "Dynamic Review" }));
    await user.click(screen.getByRole("button", SAVE));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Switch to Dynamic Review",
      }),
    );

    expect((await screen.findByRole("status")).textContent).toMatch(/Saved\./);
    expect(JSON.parse((await app.projectRows())[0]?.settings ?? "{}")).toEqual({
      reviewKind: "dynamic",
      reviewSkill: "My skill",
    });
  });

  it("refuses an oversize multibyte skill at the field, stores nothing and keeps the text", async () => {
    const user = userEvent.setup();
    const app = await openProject({ dynamicReviewEnabled: true });
    await app.service.updateProjectSettings(app.first.id, {
      reviewKind: "dynamic",
    });
    const data = await app.load();
    if (data.kind !== "ready") throw new Error("expected a project");
    renderReady(app, data);
    const before = await app.projectRows();

    await user.click(screen.getByRole("button", { name: "Edit skill" }));
    const skill = screen.getByLabelText("Review skill");
    await user.clear(skill);
    await user.click(skill);
    await user.paste("日".repeat(6000));
    await user.click(screen.getByRole("button", SAVE));

    expect(
      await within(skill.closest("[data-field]") as HTMLElement).findByText(
        /Use at most 16,384 bytes/,
      ),
    ).toBeTruthy();
    expect((skill as HTMLTextAreaElement).value).toBe("日".repeat(6000));
    expect(await app.projectRows()).toEqual(before);
  });

  // #200-T05
  it("shows each project its own values in two workspaces and never another workspace's skill", async () => {
    const app = await openProject({ dynamicReviewEnabled: true });
    const otherWorkspace = await addWorkspace(app.db, "other");
    const otherIntegration = await createIntegrationsRepository(
      app.db,
      otherWorkspace,
    ).create({
      type: "github_app",
      displayName: "other",
      externalId: "9999",
      config: {},
    });
    const otherRepositories = createRepositoriesRepository(
      app.db,
      otherWorkspace,
    );
    await otherRepositories.reconcile(otherIntegration.id, [
      {
        integrationId: otherIntegration.id,
        externalId: "77",
        fullName: "other/widgets",
        url: "https://github.test/other/widgets",
      },
    ]);
    const [otherRepository] = await otherRepositories.list();
    if (otherRepository === undefined) throw new Error("seeding failed");
    const other = { first: otherRepository };
    const otherService = createReviewSettingsService({
      appSettings: createAppSettingsRepository(app.db, otherWorkspace),
      projects: createProjectsRepository(app.db, otherWorkspace),
      builtIn: () => builtInReviewSettings("deepseek/deepseek-v3.2"),
      defaultSkill: () => TEST_DEFAULT_SKILL,
    });
    await otherService.updateProjectSettings(other.first.id, {
      reviewKind: "dynamic",
      reviewSkill: "Secret skill of the other workspace",
    });

    const mine = await app.load();
    if (mine.kind !== "ready") throw new Error("expected a project");

    expect(mine.model.dynamic?.effective.reviewKind).toBe("diff");
    expect(mine.model.dynamic?.reviewSkillIsDefault).toBe(true);
    expect(JSON.stringify(mine.model)).not.toContain("Secret skill");
    // The other workspace's repository is not found through this workspace's services.
    expect(await app.load(other.first.id)).toEqual({ kind: "not_found" });
  });

  // #200-T05
  it("shows the card of an inactive project too, and saves into it without activating it", async () => {
    const user = userEvent.setup();
    const app = await openProject({
      activate: false,
      dynamicReviewEnabled: true,
    });
    const data = await app.load();
    if (data.kind !== "ready") throw new Error("expected a project");
    renderReady(app, data);

    await user.click(screen.getByRole("radio", { name: "Dynamic Review" }));
    await user.click(screen.getByRole("button", SAVE));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Switch to Dynamic Review",
      }),
    );

    await screen.findByText(/Saved\./);
    expect(await app.projectRows()).toMatchObject([
      {
        active: 0,
        settings: expect.stringContaining('"reviewKind":"dynamic"'),
      },
    ]);
  });
});
