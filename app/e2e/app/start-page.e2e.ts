// Pins down that the production build of the app boots with no configuration and serves an
// empty start page without console errors. It is the first proof that build and start work.
import { expect, test } from "@playwright/test";

test.describe("start page", () => {
  // CR-14-T01
  test("@smoke the built app serves an empty start page without console errors", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));

    const response = await page.goto("/");

    expect(response?.status()).toBe(200);
    await expect(page.locator("body")).toHaveText("", { useInnerText: true });
    await page.waitForLoadState("networkidle");
    expect(consoleErrors).toEqual([]);
  });
});
