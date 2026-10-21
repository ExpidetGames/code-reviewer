// SPDX-License-Identifier: Apache-2.0

// Where a claim adopts the address of a selection made before pins existed (#588), as the running server wires it
// (`createProviderPins(reviewSettingsServiceFor)`): the settings of the job's own workspace, for the job's own project.
import { describe, expect, it } from "vitest";
import { setupReviewSettings } from "../test-support/review-settings-harness.ts";
import { createProviderPins } from "./provider-pins.ts";

describe("the adoption of a pin at a claim", () => {
  async function setup() {
    const app = await setupReviewSettings();
    await app.projects.updateSettingsWith(app.first.id, () => ({
      reviewKind: "dynamic",
      dynamicProvider: "deepseek",
      dynamicModel: "deepseek-v4-pro",
    }));
    const asked: string[] = [];
    const pins = createProviderPins((workspaceId) => {
      asked.push(workspaceId);
      return app.service;
    });
    const pinOf = async () => {
      const [row] = await app.projectRows();
      return (JSON.parse(row!.settings) as { dynamicProviderAddress?: string })
        .dynamicProviderAddress;
    };
    return { ...app, pins, asked, pinOf };
  }

  // #588-T54
  it("pins the address in the settings of the job's workspace and project, and answers the pin in force", async () => {
    const app = await setup();
    const job = { workspaceId: app.workspaceId, repositoryId: app.first.id };

    expect(
      await app.pins.adopt(job, "deepseek", "https://api.deepseek.example"),
    ).toBe("https://api.deepseek.example");
    expect(await app.pinOf()).toBe("https://api.deepseek.example");
    expect(app.asked).toEqual([app.workspaceId]);

    expect(
      await app.pins.adopt(job, "deepseek", "https://api.attacker.example"),
    ).toBe("https://api.deepseek.example");
    expect(await app.pinOf()).toBe("https://api.deepseek.example");
  });

  // #588-T54
  it("answers null for a project that does not select the provider, and writes nothing", async () => {
    const app = await setup();

    expect(
      await app.pins.adopt(
        { workspaceId: app.workspaceId, repositoryId: app.first.id },
        "openai",
        "https://api.openai.example",
      ),
    ).toBeNull();
    expect(await app.pinOf()).toBeUndefined();
  });
});
