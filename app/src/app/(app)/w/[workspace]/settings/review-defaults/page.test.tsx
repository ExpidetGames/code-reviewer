// SPDX-License-Identifier: Apache-2.0

// @vitest-environment node
// The "Review defaults" page decides what its form is handed. A workspace on the operator's key never gets a
// provider id in the form's props, not even one it stored a key of its own for earlier, and the page does not
// read the key statuses for it (#433, "the form never receives provider or model for a managed workspace").
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const state = vi.hoisted(() => ({
  managed: false,
  statusAll: vi.fn(),
}));

vi.mock("@/workspaces/access-runtime", () => ({
  requireWorkspace: async () => ({
    workspace: { id: "workspace-1", slug: "acme" },
    role: "owner",
  }),
}));
vi.mock("@/llm/shared", () => ({
  getWorkspaceLlm: () => ({
    keyServiceFor: () => ({ statusAll: state.statusAll }),
  }),
}));
vi.mock("@/review-settings/shared", () => ({
  reviewSettingsServiceFor: () => ({}),
}));
vi.mock("@/usage/shared", () => ({ planPageLinkedFor: async () => false }));
vi.mock("@/review-settings/ui/global-settings-page", () => ({
  loadGlobalSettingsPage: async () => ({ model: { managed: state.managed } }),
  GlobalSettingsPageContent: () => null,
}));

import ReviewDefaultsSettingsPage from "./page.tsx";

const OWN_OPENROUTER_KEY = [
  {
    provider: "openrouter",
    status: {
      state: "configured",
      provider: "openrouter",
      lastFour: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
      updatedBy: null,
    },
  },
];

async function renderedProps(): Promise<Record<string, unknown>> {
  const element = (await ReviewDefaultsSettingsPage({
    params: Promise.resolve({ workspace: "acme" }),
  })) as ReactElement<Record<string, unknown>>;
  return element.props;
}

describe("the Review defaults page", () => {
  // #433-T04
  it("hands a workspace on the operator's key no provider id, even with a stored key of its own", async () => {
    state.managed = true;
    state.statusAll.mockResolvedValue(OWN_OPENROUTER_KEY);

    const props = await renderedProps();

    expect(props).not.toHaveProperty("keyedProviders");
    expect(state.statusAll).not.toHaveBeenCalled();
  });

  // #433-T11
  it("hands a workspace on its own key the providers that have a stored key", async () => {
    state.managed = false;
    state.statusAll.mockResolvedValue(OWN_OPENROUTER_KEY);

    expect((await renderedProps()).keyedProviders).toEqual(["openrouter"]);
  });
});
