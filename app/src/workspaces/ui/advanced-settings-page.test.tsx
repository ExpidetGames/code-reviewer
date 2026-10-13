// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the "Advanced" sub-page of the workspace settings (#178): it is actions only (no form),
// and every destructive action is confirmed in a dialog before the request (#178-T04): the workspace
// key removal (an Admin or an Owner, `manage_llm_key`) and resetting every review default
// (`manage_review_defaults`). A person with neither permission sees no action.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh, push: vi.fn() }),
}));

import type { LlmKeyApi } from "../../llm/ui/api.ts";
import { AdvancedSettingsPageContent } from "./advanced-settings-page.tsx";

afterEach(() => {
  cleanup();
  navigation.refresh.mockClear();
});

function fakeKeyApi(): LlmKeyApi {
  return {
    save: vi.fn(
      async () => ({ ok: true, data: { ok: true, changed: true } }) as never,
    ),
    remove: vi.fn(
      async () => ({ ok: true, data: { ok: true, removed: true } }) as never,
    ),
    test: vi.fn(async () => ({ ok: true, data: { ok: true } }) as never),
  };
}

function renderAdvanced(
  props: Partial<Parameters<typeof AdvancedSettingsPageContent>[0]> = {},
) {
  return render(
    <AdvancedSettingsPageContent
      workspaceSlug="acme"
      canManageKey
      keyConfigured
      canResetDefaults
      {...props}
    />,
  );
}

describe("the Advanced settings sub-page", () => {
  // #178-T04
  it("confirms removing the workspace key in a dialog before the request", async () => {
    const user = userEvent.setup();
    const api = fakeKeyApi();
    const { container } = renderAdvanced({ removeApi: api });

    expect(container.querySelectorAll("form")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Remove the key…" }));
    expect(api.remove).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Yes, remove it" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("The key is removed.")).toBeTruthy();
    expect(navigation.refresh).toHaveBeenCalled();
  });

  it("confirms resetting every review default before the request", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => ({ ok: true, data: {} }) as never);
    renderAdvanced({ resetApi: { save } });

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

  it("offers no removal when there is no key", () => {
    renderAdvanced({ keyConfigured: false });

    expect(
      screen.queryByRole("button", { name: "Remove the key…" }),
    ).toBeNull();
  });

  it("shows no action to a person who may not change the key or the defaults", () => {
    renderAdvanced({ canManageKey: false, canResetDefaults: false });

    expect(
      screen.queryByRole("button", {
        name: /Remove the key|Reset every default/,
      }),
    ).toBeNull();
    expect(screen.getByText(/Only an Admin or an Owner/)).toBeTruthy();
  });
});
