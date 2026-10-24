// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the removal of the stored keys at the end of the "LLM" page (#178, moved there from "Advanced" by #658):
// it is actions only (no form), and every removal is confirmed in a dialog before the request (#178-T04).
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh, push: vi.fn() }),
}));

import type { LlmKeyApi } from "./api.ts";
import { RemoveWorkspaceKeys } from "./remove-workspace-keys.tsx";

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

function renderRemoval(
  props: Partial<Parameters<typeof RemoveWorkspaceKeys>[0]> = {},
) {
  return render(
    <RemoveWorkspaceKeys
      workspaceSlug="acme"
      keys={[{ provider: "openrouter", configured: true }]}
      {...props}
    />,
  );
}

describe("the removal of the stored keys", () => {
  // #178-T04, #178 review M1
  it("confirms removing the workspace key before the request, and keeps the confirmation after the refresh", async () => {
    const user = userEvent.setup();
    const api = fakeKeyApi();
    const view = renderRemoval({ api });

    expect(view.container.querySelectorAll("form")).toHaveLength(0);
    await user.click(
      screen.getByRole("button", { name: "Remove the OpenRouter key…" }),
    );
    expect(api.remove).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Yes, remove it" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("The key is removed.")).toBeTruthy();
    expect(navigation.refresh).toHaveBeenCalled();

    // What `router.refresh()` does: the server re-renders the page with the key gone. The zone goes,
    // the confirmation stays (the component owns the state, so the refresh does not unmount it).
    view.rerender(
      <RemoveWorkspaceKeys
        workspaceSlug="acme"
        keys={[{ provider: "openrouter", configured: false }]}
        api={api}
      />,
    );
    expect(screen.getByText("The key is removed.")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Remove the OpenRouter key…" }),
    ).toBeNull();
  });

  // #426-T07
  it("offers one removal for each provider that has a key, and removes only that one", async () => {
    const user = userEvent.setup();
    const api = fakeKeyApi();
    renderRemoval({
      api,
      keys: [
        { provider: "openrouter", configured: true },
        { provider: "fakeai", configured: true },
        { provider: "third", configured: false },
      ],
    });

    expect(
      screen.getByRole("button", { name: "Remove the OpenRouter key…" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Remove the third key/ }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Remove the fakeai key…" }),
    );
    await user.click(screen.getByRole("button", { name: "Yes, remove it" }));

    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("fakeai"));
    expect(api.remove).toHaveBeenCalledTimes(1);
  });

  it("offers no removal when there is no key", () => {
    renderRemoval({
      keys: [{ provider: "openrouter", configured: false }],
    });

    expect(
      screen.queryByRole("button", { name: "Remove the OpenRouter key…" }),
    ).toBeNull();
  });

  describe("on the access of the instance (a managed workspace)", () => {
    const PROVIDER = /openrouter/i;

    // #435-T06
    it("still removes a key the workspace stored earlier, without naming its provider", async () => {
      const user = userEvent.setup();
      const api = fakeKeyApi();
      const view = renderRemoval({
        instanceAccess: "provided",
        api,
        keys: [
          { provider: "openrouter", configured: true },
          { provider: "fakeai", configured: false },
        ],
      });

      expect(view.container.textContent).not.toMatch(PROVIDER);
      await user.click(
        screen.getByRole("button", { name: "Remove the stored key…" }),
      );
      expect(document.body.textContent).not.toMatch(PROVIDER);
      await user.click(screen.getByRole("button", { name: "Yes, remove it" }));

      await waitFor(() =>
        expect(api.remove).toHaveBeenCalledWith("openrouter"),
      );
      expect(api.remove).toHaveBeenCalledTimes(1);
      expect(await screen.findByText("The key is removed.")).toBeTruthy();
    });

    it("lists the provider by name for a workspace on its own key, as before", () => {
      renderRemoval({
        instanceAccess: null,
        keys: [{ provider: "openrouter", configured: true }],
      });

      expect(
        screen.getByRole("button", { name: "Remove the OpenRouter key…" }),
      ).toBeTruthy();
    });
  });
});

describe("the removal with a key of a catalog provider (#555)", () => {
  // #555-T02
  it("lists the removal of a catalog provider's key by the name the catalog gives it, and removes that provider's key only", async () => {
    const user = userEvent.setup();
    const api = fakeKeyApi();
    renderRemoval({
      api,
      keys: [
        { provider: "openrouter", configured: true },
        { provider: "deepseek", configured: true, label: "DeepSeek" },
      ],
    });

    await user.click(
      screen.getByRole("button", { name: "Remove the DeepSeek key…" }),
    );
    await user.click(screen.getByRole("button", { name: "Yes, remove it" }));

    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("deepseek"));
    expect(api.remove).toHaveBeenCalledTimes(1);
  });

  // #555-T08
  it("names no provider for a workspace on the instance's access, not even for a catalog key it stored earlier", () => {
    const view = renderRemoval({
      instanceAccess: "provided",
      keys: [
        { provider: "openrouter", configured: false },
        { provider: "deepseek", configured: true, label: "DeepSeek" },
      ],
    });

    expect(view.container.textContent).not.toContain("DeepSeek");
    expect(view.container.textContent).not.toContain("deepseek");
    expect(
      screen.getByRole("button", { name: "Remove the stored key…" }),
    ).toBeTruthy();
  });
});

describe("the removal on the LLM access page (#658)", () => {
  // #658-T06
  it("is at the end of the page for an Admin or an Owner, and not for a Member", async () => {
    const { LlmSettingsPageContent } = await import("./llm-settings-page.tsx");
    const page = (canManage: boolean) => (
      <LlmSettingsPageContent
        workspaceSlug="acme"
        canManage={canManage}
        keyStatuses={[
          {
            provider: "openrouter",
            status: {
              state: "configured",
              provider: "openrouter",
              lastFour: "1234",
              updatedAt: "2026-10-23T08:00:00.000Z",
              updatedBy: null,
            },
          },
        ]}
        removableKeys={[{ provider: "openrouter", configured: true }]}
        summary={{ configured: true, source: "workspace" }}
      />
    );
    const view = render(page(true));
    expect(
      screen.getByRole("button", { name: "Remove the OpenRouter key…" }),
    ).toBeTruthy();
    view.unmount();

    render(page(false));
    expect(screen.queryByRole("button", { name: /Remove the/ })).toBeNull();
  });
});
