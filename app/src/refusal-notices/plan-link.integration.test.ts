// SPDX-License-Identifier: Apache-2.0

// Where the notice of a refused review sends the Owners and Admins (#284 turns the link on): to the plan page of the
// workspace in THIS app when the instance has an operator-configured plan management page, and nowhere otherwise. The
// link never carries the address of the operator's page, a token or anything of the pull request.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { createPlanPageUrlResolver } from "./plan-link.ts";

async function start() {
  const { db } = await createTestDatabase();
  const settings = createInstanceSettingsRepository(db);
  const resolve = createPlanPageUrlResolver({
    settings,
    baseUrl: () => "https://reviews.example.com",
  });
  return { settings, resolve };
}

describe("the link of the refusal notice", () => {
  // #284-T01
  it("is none while the instance has no plan management page", async () => {
    const { resolve } = await start();

    expect(await resolve("acme")).toBeNull();
  });

  // #284-T02
  it("is the plan page of the workspace in this app once the instance has one, and never the operator's page", async () => {
    const { settings, resolve } = await start();
    await settings.set(
      "plan_management_url",
      "https://plans.example/manage",
      null,
    );

    const link = await resolve("acme");

    expect(link).toBe("https://reviews.example.com/w/acme/settings");
    expect(link).not.toContain("plans.example");
    expect(link).not.toContain("handoff");
  });

  it("keeps a slug that is not a plain name from changing the path", async () => {
    const { settings, resolve } = await start();
    await settings.set(
      "plan_management_url",
      "https://plans.example/manage",
      null,
    );

    expect(await resolve("a/../b")).toBe(
      "https://reviews.example.com/w/a%2F..%2Fb/settings",
    );
  });

  // #284-T11
  it("is none when what is stored is not a valid page", async () => {
    const { settings, resolve } = await start();
    await settings.set("plan_management_url", "http://plans.example/", null);

    expect(await resolve("acme")).toBeNull();
  });

  it("follows the setting: removing the page takes the link away", async () => {
    const { settings, resolve } = await start();
    await settings.set(
      "plan_management_url",
      "https://plans.example/manage",
      null,
    );
    expect(await resolve("acme")).not.toBeNull();

    await settings.remove("plan_management_url");

    expect(await resolve("acme")).toBeNull();
  });
});
