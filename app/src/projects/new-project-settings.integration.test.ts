// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { DYNAMIC_REVIEW_SETTING_KEY } from "../jobs/dynamic-review-gate.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { newProjectSettings } from "./new-project-settings.ts";

// #656-T02
describe("the settings a new project starts with", () => {
  it("name Dynamic Review while the instance has it turned on", async () => {
    const { db } = await createTestDatabase();
    await createInstanceSettingsRepository(db).set(DYNAMIC_REVIEW_SETTING_KEY, {
      enabled: true,
    });

    expect(await newProjectSettings(db)).toEqual({ reviewKind: "dynamic" });
  });

  it("name no kind while Dynamic Review is off, so the project keeps working as a Diff Review", async () => {
    const { db } = await createTestDatabase();

    expect(await newProjectSettings(db)).toEqual({});
  });
});
