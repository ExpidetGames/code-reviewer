// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The reset of every review default at the end of the "Review defaults" page (#178; it was on "Advanced" before #658): it is
// confirmed in a dialog before the request, and only a person who may change the defaults sees it.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
}));

import {
  dynamicView,
  untouchedGlobalView,
} from "../../test-support/settings-form-models.ts";
import { modelFromGlobalView } from "./form-model.ts";
import { GlobalSettingsPageContent } from "./global-settings-page.tsx";
import { ResetReviewDefaults } from "./reset-defaults.tsx";

afterEach(cleanup);

const DATA = {
  model: modelFromGlobalView(untouchedGlobalView()),
  dynamicReviewEnabled: true,
};

describe("resetting every review default", () => {
  it("confirms before the request", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => ({ ok: true, data: {} }) as never);
    render(<ResetReviewDefaults workspaceSlug="acme" api={{ save }} />);

    await user.click(
      screen.getByRole("button", { name: "Reset every default…" }),
    );
    expect(save).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Yes, reset every default" }),
    );
    await waitFor(() => expect(save).toHaveBeenCalledWith({}));
    expect(await screen.findByText("The defaults are reset.")).toBeTruthy();
  });

  // #658-T06
  it("is at the end of the Review defaults page for a person who may change them, and not for anybody else", () => {
    const { unmount } = render(
      <GlobalSettingsPageContent workspaceSlug="acme" data={DATA} />,
    );
    expect(
      screen.getByRole("button", { name: "Reset every default…" }),
    ).toBeTruthy();
    unmount();

    render(
      <GlobalSettingsPageContent
        workspaceSlug="acme"
        data={DATA}
        canEdit={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Reset every default…" }),
    ).toBeNull();
  });

  // #676-T07: the reset can be refused like a save; it names the projects that hold it back, as the form does.
  it("shows what refused the reset and the projects it names", async () => {
    const user = userEvent.setup();
    const save = vi.fn(
      async () =>
        ({
          ok: false,
          status: 400,
          code: "REVIEW_SETTINGS_INVALID",
          issues: [
            { field: "provider", code: "PROJECT_MODEL_BOUND_TO_PROVIDER" },
            {
              field: "dynamicProvider",
              code: "PROJECT_MODEL_BOUND_TO_PROVIDER",
            },
          ],
          details: { projects: ["acme/widgets", "acme/gadgets"] },
        }) as never,
    );
    render(<ResetReviewDefaults workspaceSlug="acme" api={{ save }} />);

    await user.click(
      screen.getByRole("button", { name: "Reset every default…" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Yes, reset every default" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Some projects chose a model of their own for the current provider.",
    );
    expect(alert.textContent).toContain(
      "Projects: acme/widgets, acme/gadgets.",
    );
    // Said once, not once per field.
    expect(alert.textContent?.split("chose a model of their own").length).toBe(
      2,
    );
    expect(screen.queryByText("The defaults are reset.")).toBeNull();
  });

  // #676-T07
  it("says how many projects switch when the reset changes the review kind of the defaults", async () => {
    const user = userEvent.setup();
    const view = {
      ...untouchedGlobalView(),
      dynamic: dynamicView("dynamic", false),
      followingProjects: 3,
    };
    render(
      <GlobalSettingsPageContent
        workspaceSlug="acme"
        data={{ model: modelFromGlobalView(view), dynamicReviewEnabled: true }}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Reset every default…" }),
    );

    expect((await screen.findByRole("alertdialog")).textContent).toContain(
      "3 projects follow this default and switch to Diff Review.",
    );
  });

  it("does not talk about followers when the reset leaves the kind alone", async () => {
    const user = userEvent.setup();
    const view = { ...untouchedGlobalView(), followingProjects: 3 };
    render(
      <GlobalSettingsPageContent
        workspaceSlug="acme"
        data={{ model: modelFromGlobalView(view), dynamicReviewEnabled: true }}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Reset every default…" }),
    );

    expect((await screen.findByRole("alertdialog")).textContent).not.toContain(
      "follow this default",
    );
  });
});
