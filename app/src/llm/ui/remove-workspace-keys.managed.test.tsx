// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// What the removal of the keys hands to the browser for a workspace on the access of the instance (#435): the props of a
// client component travel in the page's payload whether or not the component draws anything, so a card for a provider
// with no key (which draws nothing) would still carry the provider's id and name to the Owner. The real removal card
// is replaced by a recorder of its props.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const handed = vi.hoisted(
  () => [] as Array<{ provider: string; label: string | null }>,
);
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("./remove-workspace-key.tsx", () => ({
  RemoveWorkspaceKey: (props: { provider: string; label: string | null }) => {
    handed.push({ provider: props.provider, label: props.label });
    return null;
  },
}));

import { RemoveWorkspaceKeys } from "./remove-workspace-keys.tsx";

afterEach(() => {
  cleanup();
  handed.length = 0;
});

const KEYS = [
  { provider: "openrouter", configured: false },
  { provider: "fakeai", configured: false },
];

function renderRemoval(
  props: Partial<Parameters<typeof RemoveWorkspaceKeys>[0]>,
) {
  return render(
    <RemoveWorkspaceKeys workspaceSlug="acme" keys={KEYS} {...props} />,
  );
}

describe("the props the removal of the keys hands to the cards", () => {
  // #435-T06
  it.each(["provided", "key_unavailable", "settings_unreadable"] as const)(
    "carries no provider for a workspace on the access of the instance with no stored key (%s)",
    (instanceAccess) => {
      renderRemoval({ instanceAccess });

      expect(handed).toEqual([]);
    },
  );

  // #435-T06
  it("carries the provider of a stored key and no name for it", () => {
    renderRemoval({
      instanceAccess: "provided",
      keys: [
        { provider: "openrouter", configured: true },
        { provider: "fakeai", configured: false },
      ],
    });

    expect(handed).toEqual([{ provider: "openrouter", label: null }]);
  });

  it("carries every provider by name for a workspace on its own key", () => {
    renderRemoval({ instanceAccess: null });

    expect(handed.map((card) => card.provider)).toEqual([
      "openrouter",
      "fakeai",
    ]);
    expect(handed.every((card) => card.label !== null)).toBe(true);
  });
});
