// SPDX-License-Identifier: LicenseRef-Proprietary

// The addresses the projects of one workspace pinned for a catalog provider (#588): what the key test of that provider is held to.
// Scoped to the workspace like every read of customer data.
import { describe, expect, it } from "vitest";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import {
  seedRepositories,
  setupReviewSettings,
} from "../test-support/review-settings-harness.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
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
    // Another workspace with a project of its own that pinned another address for the same provider.
    const otherWorkspace = await addWorkspace(app.db, "beta");
    const other = await seedRepositories(app.db, otherWorkspace, "9999");
    const otherProjects = createProjectsRepository(app.db, otherWorkspace);
    await otherProjects.updateSettingsWith(other.first.id, () => ({
      dynamicProvider: "deepseek",
      dynamicModel: "m",
      dynamicProviderAddress: "https://api.deepseek-beta.example",
    }));

    expect(await createPinnedAddressReader(app.projects)("deepseek")).toEqual([
      "https://api.deepseek.example",
    ]);
    expect(await createPinnedAddressReader(otherProjects)("deepseek")).toEqual([
      "https://api.deepseek-beta.example",
    ]);
  });

  // #588-T26
  it("leaves out the project being saved, and lists only the projects that use the provider when asked to", async () => {
    const app = await setup();
    await app.projects.updateSettingsWith(app.first.id, () => ({
      reviewKind: "dynamic",
      dynamicProvider: "deepseek",
      dynamicModel: "m",
      dynamicProviderAddress: "https://api.deepseek.example",
    }));
    // Diff Review keeps a dormant Dynamic selection; a switched-off project has one too.
    await app.projects.updateSettingsWith(app.second.id, () => ({
      reviewKind: "diff",
      dynamicProvider: "deepseek",
      dynamicModel: "m",
      dynamicProviderAddress: "https://api.deepseek-dormant.example",
    }));
    const read = createPinnedAddressReader(app.projects);

    expect((await read("deepseek")).sort()).toEqual([
      "https://api.deepseek-dormant.example",
      "https://api.deepseek.example",
    ]);
    expect(await read("deepseek", { inUseOnly: true })).toEqual([
      "https://api.deepseek.example",
    ]);
    expect(
      await read("deepseek", { exceptRepositoryId: app.first.id }),
    ).toEqual(["https://api.deepseek-dormant.example"]);

    await app.projects.deactivate(app.first.id);
    expect(await read("deepseek", { inUseOnly: true })).toEqual([]);
  });

  // #676: a project that stores no kind has the kind of the workspace defaults (review fix 7).
  it("counts a project that follows a Dynamic default of the workspace as using the provider, and not one that follows a Diff default", async () => {
    const app = await setup();
    await app.projects.updateSettingsWith(app.first.id, () => ({
      dynamicProvider: "deepseek",
      dynamicModel: "m",
      dynamicProviderAddress: "https://api.deepseek.example",
    }));
    let workspaceKind: "diff" | "dynamic" | undefined = "dynamic";

    const read = createPinnedAddressReader(
      app.projects,
      async () => workspaceKind,
    );

    expect(await read("deepseek", { inUseOnly: true })).toEqual([
      "https://api.deepseek.example",
    ]);
    workspaceKind = "diff";
    expect(await read("deepseek", { inUseOnly: true })).toEqual([]);
    workspaceKind = undefined;
    expect(await read("deepseek", { inUseOnly: true })).toEqual([]);
    // Without the scope every project counts, as before.
    expect(await read("deepseek")).toEqual(["https://api.deepseek.example"]);
  });
});
