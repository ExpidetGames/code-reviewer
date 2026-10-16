// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { readPlanManagementUrl, savePlanManagementUrl } from "./settings.ts";

async function start() {
  const { db } = await createTestDatabase();
  return { db, settings: createInstanceSettingsRepository(db) };
}

describe("the plan management setting", () => {
  // #284-T01
  it("is unset on an instance that never saved it", async () => {
    const { settings } = await start();

    expect(await readPlanManagementUrl(settings)).toBeNull();
  });

  // #284-T11
  it.each([
    ["http:", "http://billing.example/plans"],
    ["credentials", "https://user:pw@billing.example/plans"],
    ["a fragment", "https://billing.example/plans#x"],
  ])("refuses %s on save and stores nothing", async (_name, input) => {
    const { settings } = await start();

    const result = await savePlanManagementUrl(settings, input, null);

    expect(result.ok).toBe(false);
    expect(await settings.get("plan_management_url")).toBeUndefined();
  });

  it("saves the normal form of a valid address, replaces it and removes it with null", async () => {
    const { settings } = await start();

    expect(
      await savePlanManagementUrl(settings, "https://billing.example", null),
    ).toEqual({ ok: true });
    expect(await readPlanManagementUrl(settings)).toBe(
      "https://billing.example/",
    );
    await savePlanManagementUrl(settings, "https://other.example/p", null);
    expect(await readPlanManagementUrl(settings)).toBe(
      "https://other.example/p",
    );

    expect(await savePlanManagementUrl(settings, null, null)).toEqual({
      ok: true,
    });
    expect(await readPlanManagementUrl(settings)).toBeNull();
  });

  it("records who saved it", async () => {
    const { db, settings } = await start();
    await db
      .insertInto("users")
      .values({
        id: "admin",
        name: "admin",
        email: "admin@example.test",
        email_verified: 1,
        created_at: "2026-10-12T08:00:00.000Z",
        updated_at: "2026-10-12T08:00:00.000Z",
      })
      .execute();

    await savePlanManagementUrl(settings, "https://billing.example/p", "admin");

    expect((await settings.getWithMeta("plan_management_url"))?.updatedBy).toBe(
      "admin",
    );
  });

  // #284-T11
  it("reads a stored value that is not a valid page as no page (fail closed)", async () => {
    const { settings } = await start();
    // Not through the save: a value put there by hand or damaged since.
    await settings.set("plan_management_url", "http://billing.example/", null);
    expect(await readPlanManagementUrl(settings)).toBeNull();
    await settings.set("plan_management_url", "not a url", null);
    expect(await readPlanManagementUrl(settings)).toBeNull();
  });
});
