// @vitest-environment jsdom
// Pins down the settings page of a project with real data: a repository that is not a project yet,
// a project that follows the defaults, the effect of changing the global defaults, a value saved on
// the project, and text from GitHub rendered as text. Real SQLite, the real services and routes'
// handlers; the rendering is the real component tree.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

import type { SessionUser } from "../../auth/access-policy.ts";
import { describeConfigStatus } from "../../config-status/status.ts";
import { createProjectsRepository } from "../../db/repositories/projects-repository.ts";
import { createReviewSettingsRouteHandlers } from "../../review-settings/http.ts";
import { createProjectSettingsApi } from "../../review-settings/ui/api.ts";
import { setupReviewSettings } from "../../test-support/review-settings-harness.ts";
import { testGithubAppEnv } from "../../test-support/github-app.ts";
import { createProjectService } from "../service.ts";
import {
  loadProjectSettingsPage,
  ProjectSettingsPageContent,
} from "./project-settings-page.tsx";

afterEach(cleanup);

const WORKING_ENV = {
  ...testGithubAppEnv(),
  LLM_PROVIDER: "openrouter",
  LLM_API_KEY: "dummy-llm-key-0123456789",
};

async function openProject(options: { activate?: boolean } = {}) {
  const s = await setupReviewSettings();
  const projects = createProjectService({
    projects: createProjectsRepository(s.db),
  });
  if (options.activate !== false) await projects.activateProject(s.first.id);
  const handlers = createReviewSettingsRouteHandlers({
    requireUser: async () =>
      ({ githubLogin: "octocat" }) as unknown as SessionUser,
    service: s.service,
  });
  // The form's API client, wired to the real handlers instead of the network.
  const api = createProjectSettingsApi(async (url, init) => {
    const request = new Request(`https://app.test${url}`, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string>),
        "sec-fetch-site": "same-origin",
      },
    });
    if (init?.method === "PUT") return handlers.putProject(request, s.first.id);
    if (init?.method === "DELETE")
      return handlers.deleteProject(request, s.first.id);
    return handlers.getProject(request, s.first.id);
  }, s.first.id);
  async function load(repositoryId = s.first.id) {
    return loadProjectSettingsPage(repositoryId, {
      projects,
      settings: s.service,
      config: () => describeConfigStatus(WORKING_ENV),
    });
  }
  return { ...s, projects, api, load };
}

describe("the settings page of a repository that is not a project yet", () => {
  // CR-34-T04
  it("says to switch it on first and offers no form", async () => {
    const app = await openProject({ activate: false });
    const data = await app.load();
    if (data.kind === "not_found") throw new Error("expected the repository");

    render(<ProjectSettingsPageContent data={data} api={app.api} />);

    expect(data.kind).toBe("no_project");
    expect(
      screen.getByText("This repository is not a project yet"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
  });

  it("is not found for a repository id nobody knows", async () => {
    const app = await openProject();

    expect(await app.load("no-such-repository")).toEqual({ kind: "not_found" });
  });
});

describe("the settings page of a project", () => {
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
    render(<ProjectSettingsPageContent data={data} api={app.api} />);
    const own = screen
      .getByLabelText("Most findings per review")
      .closest(".field") as HTMLElement;
    const inherited = screen
      .getByLabelText("Token budget")
      .closest(".field") as HTMLElement;
    expect(within(own).getByText("Set for this project")).toBeTruthy();
    expect(within(inherited).getByText("Global default")).toBeTruthy();
  });

  // A page that was left stays mounted (Cache Components) and is shown again with fresh data.
  it("shows the new value and its source when the page is rendered again after a global default changed", async () => {
    const app = await openProject();
    const before = await app.load();
    if (before.kind !== "ready") throw new Error("expected a project");
    const view = render(
      <ProjectSettingsPageContent data={before} api={app.api} />,
    );
    expect(
      (screen.getByLabelText("Token budget") as HTMLInputElement).value,
    ).toBe("100000");

    await app.service.updateGlobalSettings({ maxTokens: 70_000 }, "octocat");
    const after = await app.load();
    if (after.kind !== "ready") throw new Error("expected a project");
    view.rerender(<ProjectSettingsPageContent data={after} api={app.api} />);

    const field = screen
      .getByLabelText("Token budget")
      .closest(".field") as HTMLElement;
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
    render(<ProjectSettingsPageContent data={data} api={app.api} />);

    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "11");
    await user.click(
      screen.getByRole("button", { name: "Save project settings" }),
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
    render(<ProjectSettingsPageContent data={data} api={app.api} />);

    const model = screen.getByLabelText("Model");
    await user.clear(model);
    await user.type(model, "deepseek/deepseek-v3.2");
    const tokens = screen.getByLabelText("Token budget");
    await user.clear(tokens);
    await user.type(tokens, "500000");
    await user.click(
      screen.getByRole("button", { name: "Save project settings" }),
    );

    const field = tokens.closest(".field") as HTMLElement;
    expect(
      await within(field).findByText(/context window of the chosen model/),
    ).toBeTruthy();
    expect(await app.projectRows()).toEqual(before);
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

    const { container } = render(
      <ProjectSettingsPageContent data={data} api={app.api} />,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "acme/<img src=x onerror=alert(1)>",
    );
    expect(container.querySelector("img")).toBeNull();
  });
});
