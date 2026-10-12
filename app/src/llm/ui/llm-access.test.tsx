// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the "LLM access" section: an Admin or an Owner gets the form (provider, write-only key, save, test,
// remove); a Member is only told whether reviews have a key; nothing on the page holds the key; changing the
// provider asks for the key again; the hint "LLM not configured" links to the section and is gone while a key
// works.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh, push: vi.fn() }),
}));

import type { WorkspaceLlmSummary } from "../assemble.ts";
import type { WorkspaceLlmKeyStatus } from "../workspace-key.ts";
import type { LlmKeyApi } from "./api.ts";
import { LlmAccessNotice } from "./llm-access-notice.tsx";
import { LlmAccessSection } from "./llm-access-section.tsx";

afterEach(() => {
  cleanup();
  navigation.refresh.mockClear();
});

const KEY = "sk-or-v1-dummy-0123456789abcdef0123456789abcdef";

const NONE: WorkspaceLlmKeyStatus = { state: "not_configured" };
const CONFIGURED: WorkspaceLlmKeyStatus = {
  state: "configured",
  provider: "openrouter",
  lastFour: "cdef",
  updatedAt: "2026-10-12T08:00:00.000Z",
  updatedBy: "admin-1",
};
const WORKS: WorkspaceLlmSummary = { configured: true, source: "workspace" };
const MISSING: WorkspaceLlmSummary = { configured: false, reason: "no_key" };

function fakeApi(overrides: Partial<LlmKeyApi> = {}): LlmKeyApi {
  return {
    save: vi.fn(
      async () =>
        ({
          ok: true,
          data: { ok: true, changed: true, key: CONFIGURED },
        }) as never,
    ),
    remove: vi.fn(
      async () => ({ ok: true, data: { ok: true, removed: true } }) as never,
    ),
    test: vi.fn(async () => ({ ok: true, data: { ok: true } }) as never),
    ...overrides,
  };
}

function section(
  props: Partial<Parameters<typeof LlmAccessSection>[0]> = {},
  api: LlmKeyApi = fakeApi(),
) {
  return render(
    <LlmAccessSection
      workspaceSlug="acme"
      canManage
      keyStatus={NONE}
      summary={MISSING}
      api={api}
      {...props}
    />,
  );
}

describe("the LLM access section for an Admin or an Owner", () => {
  // #104-LK-03
  it("saves the typed key with the provider, clears the field and refreshes the page", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    section({}, api);

    await user.type(screen.getByLabelText("API key"), KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        provider: "openrouter",
        apiKey: KEY,
      }),
    );
    expect(await screen.findByText("The key is saved.")).toBeTruthy();
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      "",
    );
    expect(navigation.refresh).toHaveBeenCalled();
  });

  // #104-LK-03
  it("keeps the message 'The key is saved.' when the page brings the new status", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const view = section({}, api);

    await user.type(screen.getByLabelText("API key"), KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText("The key is saved.")).toBeTruthy();
    // What router.refresh() does: the same section with the new status from the server.
    view.rerender(
      <LlmAccessSection
        workspaceSlug="acme"
        canManage
        keyStatus={CONFIGURED}
        summary={WORKS}
        api={api}
      />,
    );

    expect(screen.getByText("The key is saved.")).toBeTruthy();
    expect(view.container.textContent).toMatch(
      /A key is saved \(ends in cdef\)/,
    );
  });

  // #104-LK-03
  it("keeps the key in a password field and never puts a saved key on the page", () => {
    const { container } = section({
      keyStatus: CONFIGURED,
      summary: WORKS,
    });

    expect((screen.getByLabelText("API key") as HTMLInputElement).type).toBe(
      "password",
    );
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      "",
    );
    expect(container.textContent).toMatch(/A key is saved \(ends in cdef\)/);
    expect(container.textContent).not.toContain(KEY);
  });

  // #104-LK-03
  it("sends an empty field to keep the saved key", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    section({ keyStatus: CONFIGURED, summary: WORKS }, api);

    await user.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        provider: "openrouter",
        apiKey: "",
      }),
    );
  });

  // #169: a key of a provider that is no longer offered is not carried over, so the field must be filled.
  it("says that a key of another provider is not carried over", () => {
    section({
      keyStatus: { ...CONFIGURED, provider: "openai" as never },
      summary: WORKS,
    });

    expect(screen.getByText(/and is not carried over/)).toBeTruthy();
  });

  // #169: the "leave the field empty to keep it" hint only makes sense while the key can be kept.
  it("offers the keep-the-key hint only while the saved key can be kept", () => {
    const kept = section({ keyStatus: CONFIGURED, summary: WORKS });
    expect(
      screen.getByRole("button", { name: "About the saved key" }),
    ).toBeTruthy();
    kept.unmount();

    // A key of a provider that is no longer offered is not carried over: the field must be filled.
    section({
      keyStatus: { ...CONFIGURED, provider: "openai" as never },
      summary: WORKS,
    });

    expect(
      screen.queryByRole("button", { name: "About the saved key" }),
    ).toBeNull();
  });

  it("offers no keep-the-key hint for a key that cannot be read", () => {
    section({
      keyStatus: {
        state: "unreadable",
        provider: "openrouter",
        updatedAt: "2026-10-12T08:00:00.000Z",
        updatedBy: null,
      },
      summary: WORKS,
    });

    expect(
      screen.queryByRole("button", { name: "About the saved key" }),
    ).toBeNull();
  });

  it("shows the reason the server gave for a key it refused, next to the field", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      save: vi.fn(
        async () =>
          ({
            ok: false,
            status: 422,
            code: "invalid_input",
            issues: [{ field: "apiKey", code: "api_key_invalid" }],
          }) as never,
      ),
    });
    section({}, api);

    await user.type(screen.getByLabelText("API key"), "has a space");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(
      await screen.findByText(/does not look like an API key/),
    ).toBeTruthy();
    expect(screen.getByLabelText("API key").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(navigation.refresh).not.toHaveBeenCalled();
  });

  // #104-LK-09
  it("tests the typed key, and the saved one when the field is empty", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    section({ keyStatus: CONFIGURED, summary: WORKS }, api);

    await user.click(screen.getByRole("button", { name: "Test key" }));
    await user.type(screen.getByLabelText("API key"), KEY);
    await user.click(screen.getByRole("button", { name: "Test key" }));

    await waitFor(() => expect(api.test).toHaveBeenCalledTimes(2));
    expect(api.test).toHaveBeenNthCalledWith(1, {
      provider: "openrouter",
      apiKey: "",
    });
    expect(api.test).toHaveBeenNthCalledWith(2, {
      provider: "openrouter",
      apiKey: KEY,
    });
    expect(
      await screen.findByText("The provider accepted the key."),
    ).toBeTruthy();
  });

  // #104-LK-09
  it("says why a test failed and shows the cleaned detail as text", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      test: vi.fn(
        async () =>
          ({
            ok: true,
            data: {
              ok: false,
              error: "llm_key_rejected",
              detail: "<b>No auth credentials found</b>",
            },
          }) as never,
      ),
    });
    section({ keyStatus: CONFIGURED, summary: WORKS }, api);

    await user.click(screen.getByRole("button", { name: "Test key" }));

    expect(
      await screen.findByText(/provider did not accept this key/),
    ).toBeTruthy();
    expect(screen.getByText("<b>No auth credentials found</b>")).toBeTruthy();
  });

  it("cannot test without a key to test", () => {
    section();

    expect(
      (screen.getByRole("button", { name: "Test key" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  // #104-LK-08
  it("removes the key after a confirmation", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    section({ keyStatus: CONFIGURED, summary: WORKS }, api);

    await user.click(screen.getByRole("button", { name: "Remove key" }));
    expect(api.remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Yes, remove it" }));

    await waitFor(() => expect(api.remove).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("The key is removed.")).toBeTruthy();
    expect(navigation.refresh).toHaveBeenCalled();
  });

  it("offers no removal when there is no key", () => {
    section();

    expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
  });

  it("says that a saved key cannot be read and asks for it again", () => {
    section({
      keyStatus: {
        state: "unreadable",
        provider: "openrouter",
        updatedAt: "2026-10-12T08:00:00.000Z",
        updatedBy: null,
      },
    });

    expect(screen.getByText("The saved key cannot be read.")).toBeTruthy();
  });

  it("says that the operator can decrypt the key", () => {
    const { container } = section();

    expect(container.textContent).toMatch(/operator of this instance/);
    expect(container.textContent).toMatch(/technically decrypt/);
  });
});

describe("the LLM access section for a Member", () => {
  // #104-LK-04
  it("has no form and says whether reviews have a key", () => {
    const { container } = section({
      canManage: false,
      keyStatus: { state: "configured" } as never,
      summary: WORKS,
    });

    expect(screen.queryByLabelText("API key")).toBeNull();
    // A Member gets no form and no action control: the only button is the help disclosure (#169).
    expect(container.querySelector("form")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /save key|test key|remove key/i }),
    ).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "How the key is stored" }),
    ).toBeTruthy();
    expect(container.textContent).toContain(
      "Reviews of this workspace have an LLM key.",
    );
    expect(container.textContent).toContain("Only an Admin or an Owner");
    expect(container.textContent).not.toMatch(/LLM_API_KEY|cdef/);
  });

  it("says that reviews cannot run without a key", () => {
    const { container } = section({ canManage: false });

    expect(container.textContent).toContain(
      "No LLM key is set, so reviews cannot run.",
    );
  });
});

describe("the hint 'LLM not configured'", () => {
  // #104-LK-13
  it("shows nothing while a key works", () => {
    const { container } = render(
      <LlmAccessNotice workspaceSlug="acme" summary={WORKS} canManage />,
    );

    expect(container.textContent).toBe("");
  });

  // #104-LK-13
  it("links an Admin to the section where the key is entered", () => {
    render(
      <LlmAccessNotice workspaceSlug="acme" summary={MISSING} canManage />,
    );

    expect(screen.getByText("LLM not configured")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Add a key in the settings" })
        .getAttribute("href"),
    ).toBe("/w/acme/settings#llm-access");
  });

  it("tells a Member to ask an Admin or an Owner, and still links to the section", () => {
    const { container } = render(
      <LlmAccessNotice
        workspaceSlug="acme"
        summary={MISSING}
        canManage={false}
      />,
    );

    expect(container.textContent).toContain("Ask an Admin or an Owner");
    expect(
      screen.getByRole("link", { name: "settings" }).getAttribute("href"),
    ).toBe("/w/acme/settings#llm-access");
  });

  it("says when the saved key cannot be read", () => {
    render(
      <LlmAccessNotice
        workspaceSlug="acme"
        summary={{ configured: false, reason: "key_unreadable" }}
        canManage
      />,
    );

    expect(screen.getByText("The saved LLM key cannot be read")).toBeTruthy();
  });
});
