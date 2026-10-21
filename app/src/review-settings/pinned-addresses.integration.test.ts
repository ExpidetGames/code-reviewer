// SPDX-License-Identifier: Apache-2.0

// The addresses the projects of one workspace pinned for a catalog provider (#588): what the key test of that provider is held to.
// Scoped to the workspace like every read of customer data.
import { describe, expect, it } from "vitest";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { setupReviewSettings } from "../test-support/review-settings-harness.ts";
import { createPinnedAddressReader } from "./pinned-addresses.ts";

describe("the addresses pinned for a catalog provider in a workspace", () => {
  async function setup() {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.projects.activate(app.second.id);
    return app;
  }

  // #588-T26
  it("lists the pin of every project that selects the provider, and nothing of other providers or of projects without a pin", async () => {
    const app = await setup();
    await app.projects.updateSettingsWith(app.first.id, () => ({
      dynamicProvider: "deepseek",
      dynamicModel: "m",
      dynamicProviderAddress: "https://api.deepseek.example",
    }));
    await app.projects.updateSettingsWith(app.second.id, () => ({
      dynamicProvider: "openai",
      dynamicModel: "m",
      dynamicProviderAddress: "https://api.openai.example",
    }));
    const read = createPinnedAddressReader(app.projects);

    expect(await read("deepseek")).toEqual(["https://api.deepseek.example"]);
    expect(await read("openai")).toEqual(["https://api.openai.example"]);
    expect(await read("google")).toEqual([]);
  });

  // #588-T26
  it("lists an address once, and only the pins of this workspace's projects", async () => {
    const app = await setup();
    for (const repository of [app.first, app.second])
      await app.projects.updateSettingsWith(repository.id, () => ({
        dynamicProvider: "deepseek",
        dynamicModel: "m",
        dynamicProviderAddress: "https://api.deepseek.example",
      }));
    const otherWorkspace = createProjectsRepository(
      app.db,
      "another-workspace",
    );

    expect(await createPinnedAddressReader(app.projects)("deepseek")).toEqual([
      "https://api.deepseek.example",
    ]);
    expect(await createPinnedAddressReader(otherWorkspace)("deepseek")).toEqual(
      [],
    );
  });
});
