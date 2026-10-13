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
import { defaultWorkspaceId } from "../../test-support/workspaces.ts";

afterEach(cleanup);

async function openProject(options: { activate?: boolean } = {}) {
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
