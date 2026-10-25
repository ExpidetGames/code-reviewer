// SPDX-License-Identifier: LicenseRef-Proprietary

// The operator's maximum cost per review (#689) in the admin portal of the first app. The project settings journey
// expects the default maximum ($1.00) on the same app, so this journey runs in a project of its own after the others
// and puts the default back, also when it fails.
import { expect, test, type Page } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
  await page.getByLabel("Password").fill(e2eEnv.adminPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/default\/projects$/);
}

test.describe("the operator cost limit", () => {
  // #689-T13
  test("the admin sets the maximum cost per review in dollars and finds it again after a reload", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/setup/instance");
    const maximum = page.getByLabel(/Maximum cost per review \(USD\)/);
    const saved = page
      .locator('[data-slot="card"]', { has: maximum })
      .getByText("Saved.");
    // 1.00 USD until somebody sets another amount.
    await expect(maximum).toHaveValue("1.00");

    try {
      await maximum.fill("1.005");
      await page.getByRole("button", { name: "Save settings" }).click();
      await expect(
        page.getByText(
          "Enter an amount from $0.01 to $100.00, with at most two decimals.",
        ),
      ).toBeVisible();

      await maximum.fill("2.50");
      await page.getByRole("button", { name: "Save settings" }).click();
      await expect(saved).toBeVisible();
      await page.reload();
      await expect(maximum).toHaveValue("2.50");
    } finally {
      // Put back, so the journeys that follow find the default.
      await page.goto("/admin/setup/instance");
      await maximum.fill("1.00");
      await page.getByRole("button", { name: "Save settings" }).click();
      await expect(saved).toBeVisible();
    }
  });
});
