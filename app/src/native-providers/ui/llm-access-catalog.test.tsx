// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// The LLM access section with the catalog providers (#555): the card comes after the two cards of the registry, for an Admin or
// an Owner and for a Member; a workspace on the instance's access shows the note only, with no provider named anywhere.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { LlmAccessSection } from "../../llm/ui/llm-access-section.tsx";

afterEach(cleanup);

const CATALOG = {
  providers: [{ id: "deepseek", label: "DeepSeek", modelCount: 5 }],
  keyStatuses: [],
};
const NOT_SAVED = { state: "not_configured" } as const;
const KEYS = [
  { provider: "openrouter", status: NOT_SAVED },
  { provider: "anthropic", status: NOT_SAVED },
];

describe("the catalog providers on the LLM access page", () => {
  // #555-T01
  it("comes after the cards of the registry's providers for an Admin or an Owner", () => {
    render(
      <LlmAccessSection
        workspaceSlug="acme"
        canManage
        keyStatuses={KEYS}
        catalog={CATALOG}
        summary={{ configured: false, reason: "no_key" }}
      />,
    );

    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(["OpenRouter", "Anthropic", "Other providers"]);
  });

  // #555-T01
  it("is shown to a Member as a list of what has a key, without a form", () => {
    render(
      <LlmAccessSection
        workspaceSlug="acme"
        canManage={false}
        keyStatuses={KEYS}
        catalog={{
          ...CATALOG,
          keyStatuses: [
            {
              provider: "deepseek",
              status: {
                state: "configured",
                provider: "deepseek",
                lastFour: null,
                updatedAt: "2026-10-12T08:00:00.000Z",
                updatedBy: null,
              },
            },
          ],
        }}
        summary={{ configured: true, source: "workspace" }}
      />,
    );

    expect(screen.getByText("DeepSeek: a key is saved.")).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  // #555-T08
  it("is not shown for a workspace on the instance's access: the note only, and no provider named", () => {
    const { container } = render(
      <LlmAccessSection
        workspaceSlug="acme"
        canManage
        keyStatuses={KEYS}
        summary={{ configured: true, source: "operator" }}
      />,
    );

    expect(
      screen.getByText(
        "The LLM for this workspace is billed via code-review.com.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Other providers")).toBeNull();
    for (const hidden of ["DeepSeek", "OpenRouter", "Anthropic", "deepseek"])
      expect(container.textContent).not.toContain(hidden);
  });

  // #555-T01
  it("is left out when the catalog offers nothing", () => {
    render(
      <LlmAccessSection
        workspaceSlug="acme"
        canManage
        keyStatuses={KEYS}
        catalog={{ providers: [], keyStatuses: [] }}
        summary={{ configured: false, reason: "no_key" }}
      />,
    );

    expect(screen.queryByText("Other providers")).toBeNull();
  });
});
