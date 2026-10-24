// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// The "Other providers" card of the LLM access page (#555): every provider the catalog offers, searchable; choosing one
// shows its write-only key form; a provider with a key says so. The list is what the server offered, so an excluded or blocked
// provider is simply not in it (pinned by the catalog tests).
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import type { LlmKeyApi } from "../../llm/ui/api.ts";
import type { ProviderKeyStatus } from "../../llm/workspace-key.ts";
import type { NativeProviderView } from "../catalog.ts";
import { CatalogProvidersCard } from "./catalog-providers-card.tsx";

afterEach(cleanup);

const PROVIDERS: NativeProviderView[] = [
  { id: "deepseek", label: "DeepSeek", modelCount: 5 },
  { id: "fireworks_ai", label: "Fireworks AI", modelCount: 1 },
  { id: "openai", label: "OpenAI", modelCount: 12 },
];
const KEYED: ProviderKeyStatus[] = [
  {
    provider: "openai",
    status: {
      state: "configured",
      provider: "openai",
      lastFour: "wxyz",
      updatedAt: "2026-10-12T08:00:00.000Z",
      updatedBy: "admin-1",
    },
  },
];

function fakeApi(overrides: Partial<LlmKeyApi> = {}): LlmKeyApi {
  return {
    save: vi.fn(
      async () =>
        ({
          ok: true,
          data: {
            ok: true,
            changed: true,
            key: KEYED[0]?.status,
          },
        }) as never,
    ),
    remove: vi.fn(
      async () => ({ ok: true, data: { ok: true, removed: true } }) as never,
    ),
    test: vi.fn(async () => ({ ok: true, data: { ok: true } }) as never),
    ...overrides,
  };
}

function card(
  props: Partial<Parameters<typeof CatalogProvidersCard>[0]> = {},
  api: LlmKeyApi = fakeApi(),
) {
  return render(
    <CatalogProvidersCard
      workspaceSlug="acme"
      canManage
      providers={PROVIDERS}
      keyStatuses={KEYED}
      api={api}
      {...props}
    />,
  );
}

describe("the providers of the catalog", () => {
  // #555-T01
  it("lists every offered provider with the number of its models, and says which ones have a key", () => {
    card();

    const list = screen.getByRole("list", { name: "Providers" });
    const names = within(list)
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "");
    expect(names).toHaveLength(3);
    expect(names.join("|")).toContain("DeepSeek");
    expect(names.join("|")).toContain("5 models");
    expect(names.join("|")).toContain("1 model");
    expect(within(list).getByText("Key saved")).toBeTruthy();
  });

  // #555-T01
  it("is searched by the name of the provider and by its slug", async () => {
    const user = userEvent.setup();
    card();

    await user.type(screen.getByLabelText("Search providers"), "fire");
    expect(
      within(screen.getByRole("list", { name: "Providers" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining("Fireworks AI")]);

    await user.clear(screen.getByLabelText("Search providers"));
    await user.type(screen.getByLabelText("Search providers"), "open_x");
    expect(screen.getByText("No provider matches.")).toBeTruthy();
  });

  // #555-T02
  it("shows the write-only key form of the chosen provider and saves the key for that provider", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    card({}, api);

    await user.click(screen.getByRole("button", { name: /DeepSeek/ }));
    await user.type(screen.getByLabelText("API key"), "sk-typed-0123456789");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        provider: "deepseek",
        apiKey: "sk-typed-0123456789",
      }),
    );
  });

  // #555-T02
  it("shows 'not verified' as such, and not as an error, when the provider has no way to check a key", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      test: vi.fn(
        async () =>
          ({ ok: true, data: { ok: true, verified: false } }) as never,
      ),
    });
    card({}, api);

    await user.click(screen.getByRole("button", { name: /DeepSeek/ }));
    await user.type(screen.getByLabelText("API key"), "sk-typed-0123456789");
    await user.click(screen.getByRole("button", { name: "Test key" }));

    expect(await screen.findByText(/could not be verified/i)).toBeTruthy();
    expect(screen.queryByText(/did not accept/i)).toBeNull();
    expect(screen.queryByText("The provider accepted the key.")).toBeNull();
  });

  // #555-T02
  it("never puts a saved key on the page, only whether one is saved and its last four characters", async () => {
    const user = userEvent.setup();
    card();

    await user.click(screen.getByRole("button", { name: /OpenAI/ }));

    expect(screen.getByText(/A key is saved \(ends in wxyz\)/)).toBeTruthy();
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      "",
    );
  });

  // #555-T01
  it("tells a person who cannot manage the key which providers have one, and offers no form", () => {
    card({ canManage: false });

    expect(screen.queryByLabelText("Search providers")).toBeNull();
    expect(screen.getByText(/OpenAI: a key is saved/)).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  // #555-T01
  it("mentions a saved key whose provider the catalog no longer offers, so it can be removed at the end of the page", () => {
    card({
      keyStatuses: [
        ...KEYED,
        {
          provider: "google",
          status: {
            state: "configured",
            provider: "google",
            lastFour: null,
            updatedAt: "2026-10-12T08:00:00.000Z",
            updatedBy: null,
          },
        },
      ],
    });

    expect(screen.getByText(/google/i)).toBeTruthy();
    expect(screen.getByText(/not available/i)).toBeTruthy();
  });
});
