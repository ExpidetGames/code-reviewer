// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the Settings page with real data: the form for the global defaults saves through the
// route handler into the real database and every project that has no value of its own follows, the
// LLM state is shown without the key, and the instance block names what is wrong.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

import type { SessionUser } from "../../auth/access-policy.ts";
import { describeConfigStatus } from "../../config-status/status.ts";
import { testGithubAppEnv } from "../../test-support/github-app.ts";
import { setupReviewSettings } from "../../test-support/review-settings-harness.ts";
import { createReviewSettingsRouteHandlers } from "../http.ts";
import { createGlobalSettingsApi } from "./api.ts";
import {
  GlobalSettingsPageContent,
  loadGlobalSettingsPage,
} from "./global-settings-page.tsx";

afterEach(cleanup);

const LLM_KEY = "dummy-llm-key-0123456789";
const WORKING_ENV = {
  ...testGithubAppEnv(),
  LLM_PROVIDER: "openrouter",
  LLM_API_KEY: LLM_KEY,
};

async function openSettings(
  env: Record<string, string | undefined> = WORKING_ENV,
) {
  const s = await setupReviewSettings();
  const handlers = createReviewSettingsRouteHandlers({
    requireUser: async () =>
      ({ githubLogin: "octocat" }) as unknown as SessionUser,
    service: s.service,
  });
  const api = createGlobalSettingsApi(
    async (url, init) =>
      handlers.putGlobal(
        new Request(`https://app.test${url}`, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string>),
            "sec-fetch-site": "same-origin",
          },
        }),
      ),
    "acme",
  );
  const data = await loadGlobalSettingsPage({
    settings: s.service,
    config: () => describeConfigStatus(env),
  });
  const view = render(
    <GlobalSettingsPageContent workspaceSlug="acme" data={data} api={api} />,
  );
  return { ...s, view };
}

describe("the Settings page", () => {
  // CR-34-T08
  it("saves a changed global default, and a project without its own value uses it while one with its own keeps it", async () => {
    const user = userEvent.setup();
    const app = await openSettings();
    await app.projects.activate(app.first.id);
    await app.projects.activate(app.second.id);
    await app.service.updateProjectSettings(app.second.id, { maxFindings: 3 });

    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "9");
    await user.click(screen.getByRole("button", { name: "Save defaults" }));

    expect((await screen.findByRole("status")).textContent).toMatch(/Saved\./);
    expect(
      (await app.service.resolveForRepository(app.first.id))?.settings
        .maxFindings,
    ).toBe(9);
    expect(
      (await app.service.resolveForRepository(app.second.id))?.settings
        .maxFindings,
    ).toBe(3);
    expect(await app.appSettingRows()).toMatchObject([
      { key: "review_defaults", updated_by: "octocat" },
    ]);
  });

  // CR-34-T06 (the page's own check, before anything reaches the route)
  it("names a wrong value at its field and stores nothing", async () => {
    const user = userEvent.setup();
    const app = await openSettings();

    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "none");
    await user.click(screen.getByRole("button", { name: "Save defaults" }));

    expect(await screen.findByText("Enter a whole number.")).toBeTruthy();
    expect(await app.appSettingRows()).toEqual([]);
  });

  // CR-34-T09
  it("shows that the LLM key is missing and names the variable, never a value", async () => {
    const app = await openSettings({ ...WORKING_ENV, LLM_API_KEY: undefined });

    expect(screen.getByText("LLM key missing")).toBeTruthy();
    expect(screen.getByText("LLM_API_KEY", { selector: ".mono" })).toBeTruthy();
    expect(app.view.container.textContent).not.toContain(LLM_KEY);
  });

  // CR-34-T11
  it("shows provider and model and no hint while the configuration is complete", async () => {
    const app = await openSettings();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("openrouter")).toBeTruthy();
    expect(app.view.container.textContent).not.toContain(LLM_KEY);
  });
});
