// SPDX-License-Identifier: Apache-2.0

// The balance banner of the workspace pages, end to end (#506-T10), on the app of the billing journeys of the admin portal: with billing
// on, the Owner of the default workspace sees a warning above the pages of the workspace while the balance is below the threshold, an
// alert when no credit is left, nothing while the balance is above it, and nothing at all with billing off. The balance is set the way an
// operator does it, with the manual credit and correction of the admin portal. (A Member sees no banner: this app has no second
// account, so that half is pinned by the integration test src/billing/balance-banner.integration.test.ts, which asks as a Member.)
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";
import {
  switchBillingOff,
  switchBillingOnWithFakeStripe,
} from "../helpers/stripe-fake";

const APP = e2eEnv.catalogAdminAppUrl;

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
  await page.getByLabel("Password").fill(e2eEnv.adminPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/default\/projects$/);
}

let corrections = 0;

/** Brings the balance of the default workspace to `cents` with one correction of the admin portal. */
async function setBalanceCents(
  admin: APIRequestContext,
  cents: number,
): Promise<void> {
  const found = await admin.get("/api/admin/billing/workspaces?q=default");
  expect(found.status(), await found.text()).toBe(200);
  const workspaces = (await found.json()) as {
    workspaces: Array<{ id: string; slug: string }>;
  };
  const workspace = workspaces.workspaces.find((w) => w.slug === "default");
  expect(workspace).toBeDefined();
  const current = await admin.get(
    `/api/admin/billing/workspaces/${workspace!.id}`,
  );
  expect(current.status(), await current.text()).toBe(200);
  const { balanceMicroUsd } = (await current.json()) as {
    balanceMicroUsd: number;
  };
  const delta = cents * 10_000 - balanceMicroUsd;
  if (delta === 0) return;
  corrections += 1;
  const written = await admin.post(
    `/api/admin/billing/workspaces/${workspace!.id}/credit`,
    {
      data: {
        type: "correction",
        amountMicroUsd: delta,
        note: "Balance banner journey",
        requestId: `banner-${String(Date.now())}-${String(corrections)}`,
      },
    },
  );
  expect(written.status(), await written.text()).toBe(200);
}

test.describe.configure({ mode: "serial" });

test.describe("the balance banner", () => {
  test.beforeAll(async () => {
    await switchBillingOnWithFakeStripe(APP);
  });

  // #506-T10
  test("an Owner sees a warning while the balance is low, an alert at zero, and nothing above the threshold or with billing off", async ({
    page,
  }) => {
    await signInAsAdmin(page);

    // Low: below the default threshold of $5.
    await setBalanceCents(page.request, 320);
    await page.goto("/w/default/projects");
    const low = page.locator("[data-slot=balance-banner]");
    await expect(low).toBeVisible();
    await expect(low).toContainText("Your balance is low");
    await expect(low).toContainText("$3.20");
    await expect(low).not.toContainText(/rate|factor|model|provider/i);
    await low.getByRole("link", { name: "Go to billing" }).click();
    await expect(page).toHaveURL(/\/w\/default\/settings\/billing$/);
    await expect(
      page.getByRole("heading", { name: "Billing", level: 1 }),
    ).toBeVisible();

    // Zero: nothing starts any more.
    await setBalanceCents(page.request, 0);
    await page.goto("/w/default/runs");
    const empty = page.locator("[data-slot=balance-banner]");
    await expect(empty).toContainText("No credit left");
    await expect(empty).toContainText("New reviews are not started");

    // Above the threshold: no banner.
    await setBalanceCents(page.request, 2500);
    await page.goto("/w/default/projects");
    await expect(
      page.getByRole("heading", { name: "Projects", level: 1 }),
    ).toBeVisible();
    await expect(page.locator("[data-slot=balance-banner]")).toHaveCount(0);

    // Billing off: nothing, even at a balance that is low.
    await setBalanceCents(page.request, 100);
    await switchBillingOff(APP);
    await page.goto("/w/default/projects");
    await expect(
      page.getByRole("heading", { name: "Projects", level: 1 }),
    ).toBeVisible();
    await expect(page.locator("[data-slot=balance-banner]")).toHaveCount(0);
  });
});
