// SPDX-License-Identifier: Apache-2.0

// The wiring of the runner API on the running server (#614): the collaborators that fail closed when left out are really passed. A
// claim that finds no `providerPins` cannot adopt the address of a selection made before pins existed (#588), so the line that
// wires it is held by a test, with the rest of the wiring stubbed.
import { describe, expect, it, vi } from "vitest";

const wiring = vi.hoisted(() => ({
  deps: undefined as Record<string, unknown> | undefined,
  adopted: [] as unknown[][],
  asked: [] as string[],
}));

vi.mock("./api.ts", () => ({
  createRunnerApi: (deps: Record<string, unknown>) => {
    wiring.deps = deps;
    return {};
  },
}));
vi.mock("../db/startup.ts", () => ({ getDatabase: () => ({}) }));
vi.mock("../jobs/shared.ts", () => ({ getRunnerQueue: () => ({}) }));
vi.mock("../llm/shared.ts", () => ({
  getWorkspaceLlm: () => ({}),
  modelCapabilities: {},
}));
vi.mock("../native-cost/shared.ts", () => ({ getNativeCost: () => ({}) }));
vi.mock("../projects/shared.ts", () => ({ projectServiceFor: () => ({}) }));
vi.mock("../review-settings/shared.ts", () => ({
  reviewSettingsServiceFor: (workspaceId: string) => {
    wiring.asked.push(workspaceId);
    return {
      adoptProviderAddress: (...args: unknown[]) => {
        wiring.adopted.push(args);
        return Promise.resolve("https://api.pinned.example");
      },
    };
  },
}));

import { getRunnerApi } from "./shared.ts";

describe("the runner API as the running server wires it", () => {
  // #614-T05
  it("hands the claim the pins of the job's own workspace's settings, for the job's own project", async () => {
    getRunnerApi();

    const pins = wiring.deps?.["providerPins"] as
      | {
          adopt: (
            job: { workspaceId: string; repositoryId: string },
            provider: string,
            address: string,
          ) => Promise<string | null>;
        }
      | undefined;
    expect(pins).toBeDefined();
    expect(
      await pins!.adopt(
        { workspaceId: "workspace-1", repositoryId: "repository-1" },
        "deepseek",
        "https://api.deepseek.example",
      ),
    ).toBe("https://api.pinned.example");
    expect(wiring.asked).toEqual(["workspace-1"]);
    expect(wiring.adopted).toEqual([
      ["repository-1", "deepseek", "https://api.deepseek.example"],
    ]);
  });
});
