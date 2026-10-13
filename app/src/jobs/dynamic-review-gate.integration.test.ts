// SPDX-License-Identifier: Apache-2.0

// Pins down the display reader of the Dynamic Review gate (#200): the project settings page tells the
// truth about the instance gate with a plain read, off while there is no row or the row says off.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { isDynamicReviewEnabled } from "./dynamic-review-gate.ts";

describe("reading the Dynamic Review gate for display", () => {
  // #200-T05
  it("is off without a row, off for a row that says off, and on for a row that says on", async () => {
    const { db } = await createTestDatabase();
    const settings = createInstanceSettingsRepository(db);

    expect(await isDynamicReviewEnabled(db)).toBe(false);
    await settings.set("dynamic_review", { enabled: false }, null);
    expect(await isDynamicReviewEnabled(db)).toBe(false);
    await settings.set("dynamic_review", { enabled: true }, null);
    expect(await isDynamicReviewEnabled(db)).toBe(true);
  });
});
