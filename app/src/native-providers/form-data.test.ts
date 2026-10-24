// SPDX-License-Identifier: LicenseRef-Proprietary

// What the project settings form of a workspace on its own key is given about the catalog (#555): the catalog providers the
// workspace holds a key for, the provider the project has now, the token cap and whether billing is on. A workspace on the
// operator's key is given nothing, and nothing is read for it.
import { describe, expect, it, vi } from "vitest";
import { nativeFormDataFor } from "./form-data.ts";

const OFFERED = [
  { id: "deepseek", label: "DeepSeek", modelCount: 5 },
  { id: "openai", label: "OpenAI", modelCount: 12 },
  { id: "fireworks_ai", label: "Fireworks AI", modelCount: 3 },
];
const configured = (provider: string) => ({
  provider,
  status: {
    state: "configured" as const,
    provider,
    lastFour: null,
    updatedAt: "2026-10-12T08:00:00.000Z",
    updatedBy: null,
  },
});

function deps(overrides: { keyed?: string[]; unreadable?: string[] } = {}) {
  const reads = {
    providers: vi.fn(() => Promise.resolve(OFFERED)),
    statuses: vi.fn(() =>
      Promise.resolve([
        ...(overrides.keyed ?? []).map(configured),
        ...(overrides.unreadable ?? []).map((provider) => ({
          provider,
          status: {
            state: "unreadable" as const,
            provider,
            updatedAt: "2026-10-12T08:00:00.000Z",
            updatedBy: null,
          },
        })),
      ]),
    ),
    billingOn: vi.fn(() => Promise.resolve(true)),
    tokenCap: vi.fn(() => Promise.resolve(4_000_000)),
  };
  return {
    reads,
    deps: {
      catalog: { providers: reads.providers },
      keys: { nativeStatuses: reads.statuses },
      billingOn: reads.billingOn,
      tokenCap: reads.tokenCap,
    },
  };
}

describe("the catalog data of a project form", () => {
  // #555-T08
  it("is nothing for a workspace on the operator's key, and nothing is read", async () => {
    const { deps: d, reads } = deps({ keyed: ["deepseek"] });

    expect(
      await nativeFormDataFor(
        { managed: true, currentProvider: "deepseek" },
        d,
      ),
    ).toBeUndefined();
    for (const read of Object.values(reads))
      expect(read).not.toHaveBeenCalled();
  });

  // #555-T01
  it("offers the catalog providers the workspace holds a key for, by name", async () => {
    const { deps: d } = deps({ keyed: ["openai", "deepseek"] });

    const data = await nativeFormDataFor(
      { managed: false, currentProvider: "openrouter" },
      d,
    );

    expect(data).toEqual({
      providers: [
        { id: "deepseek", label: "DeepSeek", hasKey: true },
        { id: "openai", label: "OpenAI", hasKey: true },
      ],
      tokenCap: 4_000_000,
      billingOn: true,
    });
  });

  // #555-T01
  it("keeps the provider the project has now in the list even without a key or a catalog entry, marked as having none", async () => {
    const { deps: d } = deps({ keyed: [] });

    const withoutKey = await nativeFormDataFor(
      { managed: false, currentProvider: "fireworks_ai" },
      d,
    );
    const gone = await nativeFormDataFor(
      { managed: false, currentProvider: "google" },
      d,
    );

    expect(withoutKey?.providers).toEqual([
      { id: "fireworks_ai", label: "Fireworks AI", hasKey: false },
    ]);
    expect(gone?.providers).toEqual([
      { id: "google", label: "google", hasKey: false },
    ]);
  });

  // #555-T01
  it("treats a key that cannot be read as no key", async () => {
    const { deps: d } = deps({ unreadable: ["deepseek"] });

    const data = await nativeFormDataFor(
      { managed: false, currentProvider: "openrouter" },
      d,
    );

    expect(data?.providers).toEqual([]);
  });

  // #555-T01
  it("does not list a provider of the registry as a catalog provider", async () => {
    const { deps: d } = deps({ keyed: [] });

    const data = await nativeFormDataFor(
      { managed: false, currentProvider: "anthropic" },
      d,
    );

    expect(data?.providers).toEqual([]);
  });
});
