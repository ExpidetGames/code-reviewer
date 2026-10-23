// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the "LLM access" section: an Admin or an Owner gets the form (provider, write-only key,
// save, test); a Member is only told whether reviews have a key; nothing on the page holds the key;
// changing the provider asks for the key again; the hint "LLM not configured" links to the section and
// is gone while a key works. Removing the key is a destructive action at the end of the LLM access page, not of the form
// (`remove-workspace-key.tsx`).
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh, push: vi.fn() }),
}));

import type { WorkspaceLlmSummary } from "../assemble.ts";
import type {
  ProviderKeyStatus,
  WorkspaceLlmKeyStatus,
} from "../workspace-key.ts";
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

/** The state of the key of the one provider the app ships with, as the section takes it. */
const only = (status: WorkspaceLlmKeyStatus): ProviderKeyStatus[] => [
  { provider: "openrouter", status },
];

function section(
  {
    keyStatus = NONE,
    ...props
  }: Partial<Parameters<typeof LlmAccessSection>[0]> & {
    /** Shorthand for the state of the key of the only provider. */
    keyStatus?: WorkspaceLlmKeyStatus;
  } = {},
  api: LlmKeyApi = fakeApi(),
) {
  return render(
    <LlmAccessSection
      workspaceSlug="acme"
      canManage
      keyStatuses={only(keyStatus)}
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
        keyStatuses={only(CONFIGURED)}
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

  it("offers no removal: removing the key is a destructive action at the end of the page, not of the form", () => {
    section({ keyStatus: CONFIGURED, summary: WORKS });

    expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
  });

  it("says that a saved key cannot be read and asks for it again, not as an alert", () => {
    section({
      keyStatus: {
        state: "unreadable",
        provider: "openrouter",
        updatedAt: "2026-10-12T08:00:00.000Z",
        updatedBy: null,
      },
    });

    expect(screen.getByText("The saved key cannot be read.")).toBeTruthy();
    // Server-determined and static: no `role="alert"` (#178 review N1).
    expect(screen.queryByRole("alert")).toBeNull();
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
    ).toBe("/w/acme/settings/llm");
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
    ).toBe("/w/acme/settings/llm");
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

describe("a workspace whose LLM access is provided by the instance (#276)", () => {
  const PROVIDED: WorkspaceLlmSummary = {
    configured: true,
    source: "operator",
  };
  const UNAVAILABLE: WorkspaceLlmSummary = {
    configured: false,
    reason: "operator_key_missing",
  };

  // #276-T09
  it("shows an Admin or an Owner no key form and a note that access is provided, though the workspace has a key of its own", () => {
    const { container } = section({
      keyStatus: CONFIGURED,
      summary: PROVIDED,
    });

    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /save key|test key|remove key/i }),
    ).toBeNull();
    expect(container.textContent).toContain(
      "LLM access for this workspace is provided by this instance.",
    );
    expect(container.textContent).toContain("does not use a key of its own");
    // The key of the workspace is stored and ignored: nothing of it is shown while it is not used.
    expect(container.textContent).not.toMatch(/cdef|openrouter/);
  });

  // #276-T09
  it("shows a Member the same note", () => {
    const admin = section({ keyStatus: CONFIGURED, summary: PROVIDED });
    const adminText = admin.container.textContent;
    cleanup();

    const member = section({
      canManage: false,
      keyStatus: CONFIGURED,
      summary: PROVIDED,
    });

    expect(member.container.textContent).toContain(
      "LLM access for this workspace is provided by this instance.",
    );
    expect(member.container.textContent).not.toContain(
      "Only an Admin or an Owner",
    );
    expect(adminText).toContain("provided by this instance");
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  // #276-T09
  it("says when the instance has no key to give, with no form either: the workspace cannot fix it", () => {
    for (const reason of [
      "operator_key_missing",
      "operator_key_unreadable",
    ] as const)
      for (const canManage of [true, false]) {
        const { container, unmount } = section({
          canManage,
          keyStatus: CONFIGURED,
          summary: { configured: false, reason },
        });

        expect(screen.queryByLabelText("API key")).toBeNull();
        expect(container.textContent).toContain(
          "LLM access for this workspace is provided by this instance.",
        );
        expect(container.textContent).toContain(
          "not available at the moment, so reviews cannot run",
        );
        unmount();
      }
  });

  // #276-T09
  it("keeps the form of a workspace that is not managed, even when the instance has a key", () => {
    section({ keyStatus: NONE, summary: MISSING });

    expect(screen.getByLabelText("API key")).toBeTruthy();
    expect(document.body.textContent).not.toContain(
      "provided by this instance",
    );
  });

  // #276-T09
  it("does not ask a workspace for a key it cannot use: the hint says the instance has no access to give, and does not link to the form", () => {
    const { container } = render(
      <LlmAccessNotice workspaceSlug="acme" summary={UNAVAILABLE} canManage />,
    );

    expect(screen.getByText("LLM access is not available")).toBeTruthy();
    expect(container.textContent).toContain("administrator of this instance");
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.textContent).not.toMatch(/Add a key|add one/);
  });

  // #276-T09
  it("says the same for a key that cannot be read, and for entitlements that cannot be read", () => {
    for (const reason of [
      "operator_key_unreadable",
      "entitlements_invalid",
    ] as const) {
      const { container, unmount } = render(
        <LlmAccessNotice
          workspaceSlug="acme"
          summary={{ configured: false, reason }}
          canManage={false}
        />,
      );

      expect(screen.getByText("LLM access is not available")).toBeTruthy();
      expect(screen.queryByRole("link")).toBeNull();
      expect(container.textContent).not.toMatch(/sk-|APP_SECRET/);
      unmount();
    }
  });

  // #276-T09
  it("shows nothing while the instance provides access", () => {
    const { container } = render(
      <LlmAccessNotice workspaceSlug="acme" summary={PROVIDED} canManage />,
    );

    expect(container.textContent).toBe("");
  });
});

// A second provider that exists only in tests: its id is not in the app's registry, so the card is named by it.
const SECOND_CONFIGURED: WorkspaceLlmKeyStatus = {
  state: "configured",
  provider: "fakeai",
  lastFour: "wxyz",
  updatedAt: "2026-10-12T08:00:00.000Z",
  updatedBy: "admin-1",
};
const TWO_PROVIDERS: ProviderKeyStatus[] = [
  { provider: "openrouter", status: CONFIGURED },
  { provider: "fakeai", status: SECOND_CONFIGURED },
];

describe("one card per provider (#426)", () => {
  // #426-T07
  it("shows a card with its own key form for every provider, each with the state of its own key", () => {
    section({ keyStatuses: TWO_PROVIDERS, summary: WORKS });

    const openrouter = screen.getByRole("region", { name: "OpenRouter" });
    const second = screen.getByRole("region", { name: "fakeai" });
    expect(screen.getAllByRole("form")).toHaveLength(2);
    expect(within(openrouter).getByLabelText("API key")).toBeTruthy();
    expect(within(second).getByLabelText("API key")).toBeTruthy();
    expect(openrouter.textContent).toMatch(/ends in cdef/);
    expect(openrouter.textContent).not.toMatch(/wxyz/);
    expect(second.textContent).toMatch(/ends in wxyz/);
    expect(second.textContent).not.toMatch(/cdef/);
  });

  // #426-T07
  it("saves and tests the key of the card it was typed into, for that provider only", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    section({ keyStatuses: TWO_PROVIDERS, summary: WORKS }, api);
    const second = screen.getByRole("region", { name: "fakeai" });

    await user.type(within(second).getByLabelText("API key"), KEY);
    await user.click(within(second).getByRole("button", { name: "Test key" }));
    await user.click(within(second).getByRole("button", { name: "Save key" }));

    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        provider: "fakeai",
        apiKey: KEY,
      }),
    );
    expect(api.test).toHaveBeenCalledWith({ provider: "fakeai", apiKey: KEY });
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.test).toHaveBeenCalledTimes(1);
    const first = screen.getByRole("region", { name: "OpenRouter" });
    expect(
      (within(first).getByLabelText("API key") as HTMLInputElement).value,
    ).toBe("");
  });

  // #426-T07
  it("tells a Member the state of every provider's key and gives no form", () => {
    const { container } = section({
      canManage: false,
      keyStatuses: [
        { provider: "openrouter", status: { state: "configured" } as never },
        { provider: "fakeai", status: NONE },
      ],
      summary: WORKS,
    });

    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(container.textContent).toContain("OpenRouter: a key is saved");
    expect(container.textContent).toContain("fakeai: no key is saved");
    expect(container.textContent).not.toMatch(/cdef|wxyz/);
  });

  // #426-T07
  it("shows the note that access is provided by this instance instead of the cards, whatever the keys of the workspace", () => {
    for (const canManage of [true, false]) {
      const { container, unmount } = section({
        canManage,
        keyStatuses: TWO_PROVIDERS,
        summary: { configured: true, source: "operator" },
      });

      expect(container.textContent).toContain(
        "LLM access for this workspace is provided by this instance.",
      );
      expect(screen.queryAllByRole("form")).toHaveLength(0);
      expect(screen.queryByRole("region", { name: "OpenRouter" })).toBeNull();
      expect(screen.queryByRole("region", { name: "fakeai" })).toBeNull();
      expect(container.textContent).not.toMatch(/cdef|wxyz|fakeai/);
      unmount();
    }
  });
});
