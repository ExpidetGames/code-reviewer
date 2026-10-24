// SPDX-License-Identifier: LicenseRef-Proprietary

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

  // #650-T03
  test("the login page head links the code-review.com icon, and the icon files are served without a session", async ({
    page,
    request,
  }) => {
    await page.goto("/login");

    const icon = page.locator('head link[rel="icon"][href^="/icon.svg"]');
    await expect(icon).toHaveCount(1);
    await expect(
      page.locator(
        'head link[rel="apple-touch-icon"][href^="/apple-icon.png"]',
      ),
    ).toHaveCount(1);
    for (const [path, type] of [
      [(await icon.getAttribute("href")) ?? "", "image/svg+xml"],
      ["/favicon.ico", "image/x-icon"],
      ["/apple-icon.png", "image/png"],
    ] as const) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(200);
      expect(response.headers()["content-type"], path).toContain(type);
    }
  });
});
