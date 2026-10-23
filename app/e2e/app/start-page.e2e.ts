// SPDX-License-Identifier: Apache-2.0

// Pins down that the production build of the app boots (migrating a fresh database) and serves a
// page without console errors. Without a session the start page is the login page, so this is also
// the first proof that the access guard works in the built server and not only in the tests.
import { expect, test } from "@playwright/test";

test.describe("start page", () => {
  // CR-14-T01
  test("@smoke the built app sends a visitor without a session to the login page without console errors", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));

    const response = await page.goto("/");

    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByRole("button", { name: "Sign in with GitHub" }),
    ).toBeVisible();
    await page.waitForLoadState("load");
    await expect(page).toHaveTitle("code-review.com");
    expect(consoleErrors).toEqual([]);
  });
});
