// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// The choice of the key mode on the LLM access page while billing is on (#496): "Use our models" and "Use my own provider key", each
// with one sentence about what is charged and no rate; an Admin or an Owner changes it, a Member reads it; a workspace without a key
// of its own cannot pick its own key; the key forms stay on the page whichever is chosen, so the key can be saved before switching.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh, push: vi.fn() }),
}));

import type { WorkspaceLlmSummary } from "../assemble.ts";
import type { ProviderKeyStatus } from "../workspace-key.ts";
import type { LlmKeyModeApi } from "./key-mode-api.ts";
import { KeyModeCard } from "./key-mode-card.tsx";
import { LlmAccessSection } from "./llm-access-section.tsx";

afterEach(() => {
  cleanup();
  navigation.refresh.mockClear();
});

function fakeApi(
  overrides: Partial<LlmKeyModeApi> = {},
): LlmKeyModeApi & { set: ReturnType<typeof vi.fn> } {
  return {
    set: vi.fn(
      async (keyMode: "managed" | "own") =>
        ({ ok: true, data: { keyMode } }) as never,
    ),
    ...overrides,
  } as LlmKeyModeApi & { set: ReturnType<typeof vi.fn> };
}

function card(
  props: Partial<Parameters<typeof KeyModeCard>[0]> = {},
  api = fakeApi(),
) {
  render(
    <KeyModeCard canManage keyMode="managed" hasOwnKey api={api} {...props} />,
  );
  return api;
}

describe("the key mode card", () => {
  // #496-T09
  it("shows both choices with one sentence each about what is charged, and the one that applies", () => {
    const { container } = render(
      <KeyModeCard canManage keyMode="managed" hasOwnKey api={fakeApi()} />,
    );

    const ours = screen.getByRole("radio", { name: /Use our models/ });
    const own = screen.getByRole("radio", { name: /Use my own provider key/ });
    expect(ours.getAttribute("aria-checked")).toBe("true");
    expect(own.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/charged for AI and infrastructure/)).toBeTruthy();
    expect(screen.getByText(/charged for infrastructure only/)).toBeTruthy();
    // No rate, no formula, no figure on the card.
    expect(container.textContent).not.toMatch(/\$|USD|×|factor|per minute/i);
  });

  // #496-T09
  it("shows a Member the same card read-only, with nothing to press", () => {
    card({ canManage: false, keyMode: "own" });

    const own = screen.getByRole("radio", { name: /Use my own provider key/ });
    expect(own.getAttribute("aria-checked")).toBe("true");
    expect(own.hasAttribute("disabled")).toBe(true);
    expect(
      screen
        .getByRole("radio", { name: /Use our models/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Save choice" })).toBeNull();
    expect(
      screen.getByText(/Only an Admin or an Owner of the workspace can change/),
    ).toBeTruthy();
  });

  // #496-T07
  it("saves the other choice, says so and refreshes the page", async () => {
    const user = userEvent.setup();
    const api = card();

    await user.click(screen.getByRole("radio", { name: /Use my own/ }));
    await user.click(screen.getByRole("button", { name: "Save choice" }));

    await waitFor(() => expect(api.set).toHaveBeenCalledWith("own"));
    expect(await screen.findByText("The choice is saved.")).toBeTruthy();
    expect(navigation.refresh).toHaveBeenCalled();
  });

  // #496-T07
  it("does not offer to save what is already chosen", () => {
    card();

    expect(
      screen
        .getByRole("button", { name: "Save choice" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  // #496-T05
  it("cannot pick the own key without one, and says where to save it", () => {
    card({ hasOwnKey: false });

    expect(
      screen
        .getByRole("radio", { name: /Use my own provider key/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText(/Save a provider key below first/)).toBeTruthy();
  });

  // #496-T05
  it("lets a workspace that chose its own key and lost it switch to our models", async () => {
    const user = userEvent.setup();
    const api = card({ keyMode: "own", hasOwnKey: false });

    await user.click(screen.getByRole("radio", { name: /Use our models/ }));
    await user.click(screen.getByRole("button", { name: "Save choice" }));

    await waitFor(() => expect(api.set).toHaveBeenCalledWith("managed"));
  });

  // #496-T05
  it("translates a refusal of the server into a sentence, never into the code", async () => {
    const user = userEvent.setup();
    card(
      {},
      fakeApi({
        set: vi.fn(
          async () =>
            ({
              ok: false,
              status: 409,
              code: "own_key_missing",
              issues: [],
            }) as never,
        ),
      }),
    );

    await user.click(screen.getByRole("radio", { name: /Use my own/ }));
    await user.click(screen.getByRole("button", { name: "Save choice" }));

    expect(
      await screen.findByText(/Save an API key for your own provider first/),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("own_key_missing");
    expect(navigation.refresh).not.toHaveBeenCalled();
  });

  // #496-T09
  it("says that a key saved below stays stored but unused while our models are chosen", () => {
    card({ keyMode: "managed" });

    expect(screen.getByText(/stays stored and is not used/)).toBeTruthy();
  });
});

describe("the LLM access section with the choice", () => {
  const PROVIDED: WorkspaceLlmSummary = {
    configured: true,
    source: "operator",
  };
  const keyStatuses: ProviderKeyStatus[] = [
    { provider: "openrouter", status: { state: "not_configured" } },
  ];

  // #496-T09
  it("keeps the key form on the page when our models are chosen, so a key can be saved before switching", () => {
    render(
      <LlmAccessSection
        workspaceSlug="acme"
        canManage
        keyStatuses={keyStatuses}
        summary={PROVIDED}
        keyChoice={{ keyMode: "managed", hasOwnKey: false }}
      />,
    );

    expect(screen.getByLabelText("API key")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Use our models/ })).toBeTruthy();
    expect(
      screen.queryByText(
        "LLM access for this workspace is provided by this instance.",
      ),
    ).toBeNull();
  });

  // #496-T03
  it("is the same section as before when billing is off: no choice, the instance's access card", () => {
    render(
      <LlmAccessSection
        workspaceSlug="acme"
        canManage
        keyStatuses={keyStatuses}
        summary={PROVIDED}
      />,
    );

    expect(screen.queryByRole("radio")).toBeNull();
    expect(
      screen.getByText(
        "LLM access for this workspace is provided by this instance.",
      ),
    ).toBeTruthy();
  });
});
