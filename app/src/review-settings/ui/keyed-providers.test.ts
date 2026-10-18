// SPDX-License-Identifier: Apache-2.0

// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ProviderKeyStatus } from "../../llm/workspace-key.ts";
import { keyedProvidersOf } from "./keyed-providers.ts";

const when = { updatedAt: "2026-10-01T00:00:00.000Z", updatedBy: null };

describe("the providers of a workspace that have a key", () => {
  // #433-T11
  it("lists the providers with a readable key, and not those without or with an unreadable one", () => {
    const statuses: ProviderKeyStatus[] = [
      {
        provider: "openrouter",
        status: {
          state: "configured",
          provider: "openrouter",
          lastFour: null,
          ...when,
        },
      },
      { provider: "fakeai", status: { state: "not_configured" } },
      {
        provider: "other",
        status: { state: "unreadable", provider: "other", ...when },
      },
    ];

    expect(keyedProvidersOf(statuses)).toEqual(["openrouter"]);
  });

  // #433-T11
  it("is empty when no provider has a key", () => {
    expect(
      keyedProvidersOf([
        { provider: "openrouter", status: { state: "not_configured" } },
      ]),
    ).toEqual([]);
  });
});
