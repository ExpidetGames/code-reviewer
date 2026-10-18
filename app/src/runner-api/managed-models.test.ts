// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { Job } from "../jobs/job-types.ts";
import { managedModelsOf } from "./managed-models.ts";

const job = { id: "job-1", workspaceId: "ws-1" } as Job;
const catalog = { allCatalogModelIds: async () => ["vendor/a", "vendor/b"] };

// #434-X3: what the result of a job masks is decided in one place, and the tiers are no part of it. The running
// server (`shared.ts`) and the test harness both build their `managedModels` from this function.
describe("which models a result hides", () => {
  // #434-X3
  it("hides every model of the catalog from a run on the operator's key", async () => {
    const managedModels = managedModelsOf({
      usage: async () => ({ keyMode: "managed" }),
      catalog,
    });
    expect(await managedModels(job)).toEqual({
      managed: true,
      models: ["vendor/a", "vendor/b"],
    });
  });

  // #434-X3
  it("hides nothing from a run on the workspace's own key", async () => {
    const managedModels = managedModelsOf({
      usage: async () => ({ keyMode: "own" }),
      catalog,
    });
    expect(await managedModels(job)).toEqual({ managed: false, models: [] });
  });

  // #434-X3
  it("hides nothing from a job without a usage record", async () => {
    const managedModels = managedModelsOf({
      usage: async () => undefined,
      catalog,
    });
    expect(await managedModels(job)).toEqual({ managed: false, models: [] });
  });

  // #434-X3
  it("treats a record that still carries a tier on the workspace's own key as own (a tier decides nothing any more)", async () => {
    const managedModels = managedModelsOf({
      usage: async () => ({
        keyMode: "own",
        [["model", "Tier"].join("")]: "high",
      }),
      catalog,
    });
    expect(await managedModels(job)).toEqual({ managed: false, models: [] });
  });
});
