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

import { estimateReviewCost } from "../cost.ts";
import { builtInReviewSettings, type ReviewSettingField } from "../settings.ts";
import { modelFromGlobalView } from "./form-model.ts";
import { GlobalSettingsPageContent } from "./global-settings-page.tsx";
import { ResetReviewDefaults } from "./reset-defaults.tsx";

afterEach(cleanup);

const BUILT_IN = builtInReviewSettings("anthropic/claude-haiku-5.5");
const DATA = {
  model: modelFromGlobalView({
    overrides: {},
    effective: BUILT_IN,
    sources: Object.fromEntries(
      Object.keys(BUILT_IN).map((field) => [field, "built_in"]),
    ) as Record<ReviewSettingField, "built_in">,
    cost: estimateReviewCost(BUILT_IN),
    modelManagedByInstance: false,
    builtIn: BUILT_IN,
    updatedAt: null,
    updatedBy: null,
  }),
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
});
