// SPDX-License-Identifier: Apache-2.0

// #505: where the notice of a refused review sends the Owners and Admins once billing exists. A refusal for the balance or the
// monthly limit points to the billing page of the workspace while billing is on, and to the workspace settings (the old target)
// when it is off; the "Manage plan" link of a quota or a suspension points to the billing page too while billing is on, where the
// plan page is replaced, and is as before otherwise (none without an operator page). The base address is the configured one.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { isBillingOn } from "../billing/enabled.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { createBillingAwareLinks } from "./billing-link.ts";
import { createPlanPageUrlResolver } from "./plan-link.ts";

const BASE = "https://reviews.example.com";

async function start() {
  const { db } = await createTestDatabase();
  const settings = createInstanceSettingsRepository(db);
  const links = createBillingAwareLinks({
    isBillingOn: () => isBillingOn(db),
    baseUrl: () => BASE,
    plan: createPlanPageUrlResolver({ settings, baseUrl: () => BASE }),
  });
  return { db, settings, links };
}

describe("the link of the refusal notice with billing", () => {
  // #505-T12
  it("points a balance or limit refusal to the billing page while billing is on", async () => {
    const { db, links } = await start();
    await setBillingSwitch(db, true);

    expect(await links.settingsUrl("acme")).toBe(`${BASE}/w/acme/settings/billing`);
  });

  // #505-T12
  it("keeps the old target, the workspace settings, while billing is off", async () => {
    const { db, links } = await start();
    await setBillingSwitch(db, false);

    expect(await links.settingsUrl("acme")).toBe(`${BASE}/w/acme/settings`);
  });

  // #505-T12
  it("points the plan link to the billing page while billing is on and the instance has a plan page", async () => {
    const { db, settings, links } = await start();
    await settings.set("plan_management_url", "https://plans.example/manage", null);
    await setBillingSwitch(db, true);

    const link = await links.planPageUrl("acme");

    expect(link).toBe(`${BASE}/w/acme/settings/billing`);
    expect(link).not.toContain("plans.example");
  });

  // #505-T12
  it("leaves the plan link exactly as it was while billing is off", async () => {
    const { db, settings, links } = await start();
    await setBillingSwitch(db, false);
    expect(await links.planPageUrl("acme")).toBeNull();

    await settings.set("plan_management_url", "https://plans.example/manage", null);

    expect(await links.planPageUrl("acme")).toBe(`${BASE}/w/acme/settings/plan`);
  });

  // #505-T12
  it("adds no link where the plan link was none, whatever billing is", async () => {
    const { db, links } = await start();
    await setBillingSwitch(db, true);

    expect(await links.planPageUrl("acme")).toBeNull();
  });
});
