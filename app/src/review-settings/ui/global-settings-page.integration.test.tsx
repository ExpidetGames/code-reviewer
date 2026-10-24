// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the "Review defaults" sub-page with real data (#178): the form for the global defaults
// saves through the route handler into the real database and every project that has no value of its
// own follows, while one with its own keeps it. The configuration hints and the instance facts moved
// to the "General" sub-page (general-settings-page.test.tsx).
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

import type { SessionUser } from "../../auth/access-policy.ts";
import { setupReviewSettings } from "../../test-support/review-settings-harness.ts";
import { createReviewSettingsRouteHandlers } from "../http.ts";
import { createGlobalSettingsApi } from "./api.ts";
import {
  GlobalSettingsPageContent,
  loadGlobalSettingsPage,
} from "./global-settings-page.tsx";

afterEach(cleanup);

async function openReviewDefaults() {
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
  const data = await loadGlobalSettingsPage({ settings: s.service });
  const view = render(
    <GlobalSettingsPageContent workspaceSlug="acme" data={data} api={api} />,
  );
  return { ...s, view };
}

describe("the Review defaults sub-page", () => {
  // #178-T02
  it("is exactly one form", async () => {
    const { view } = await openReviewDefaults();

    expect(view.container.querySelectorAll("form")).toHaveLength(1);
  });

  // CR-34-T08
  it("saves a changed global default, and a project without its own value uses it while one with its own keeps it", async () => {
    const user = userEvent.setup();
    const app = await openReviewDefaults();
    await app.projects.activate(app.first.id);
    await app.projects.activate(app.second.id);
    await app.service.updateProjectSettings(app.second.id, { maxFindings: 3 });

    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "9");
    await user.click(
      screen.getByRole("button", { name: "Save review defaults" }),
    );

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
    const app = await openReviewDefaults();

    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "none");
    await user.click(
      screen.getByRole("button", { name: "Save review defaults" }),
    );

    expect(await screen.findByText("Enter a whole number.")).toBeTruthy();
    expect(await app.appSettingRows()).toEqual([]);
  });
});
