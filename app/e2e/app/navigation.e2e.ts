// SPDX-License-Identifier: Apache-2.0

// Pins down the frame around the signed in app in a real browser: the three places load one after
// the other inside the same frame and signing out lands on the login page, on a desktop window and
// on a phone-sized one (where the navigation sits behind the Menu button and the page must not
// scroll sideways). The details of the navigation and the menus are proven as component tests.
import { expect, test } from "@playwright/test";
import {
  addGithubAccount,
  signInThroughTheForm,
  signOutThroughTheMenu,
  type GithubAccount,
} from "../helpers/github-fake";

const account: GithubAccount = {
  id: 7300001,
  login: "nav-journey",
  name: "Nav Journey",
  email: "nav-journey@example.test",
};

test.describe("the app frame", () => {
  test.beforeAll(async ({ request }) => {
    await addGithubAccount(request, account);
  });

  // CR-36-T09
  test("@smoke a signed in person opens Projects, Runs, Settings and Members of the workspace in the same frame and signs out", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);
    const nav = page.getByRole("navigation", { name: "Main" });

    for (const place of ["Projects", "Runs", "Settings", "Members"]) {
      await nav.getByRole("link", { name: place }).click();

      await expect(
        page.getByRole("heading", { level: 1, name: place }),
      ).toBeVisible();
      await expect(nav.getByRole("link", { name: place })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(page).toHaveTitle(`${place} · Code Reviewer`);
      await expect(page.getByRole("banner")).toBeVisible();
    }

    await signOutThroughTheMenu(page, account);

    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByRole("button", { name: "Sign in with GitHub" }),
    ).toBeVisible();
  });

  test.describe("on a narrow window", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    // CR-36-T10
    test("a person on a phone opens the menu, switches from Projects to Runs and the page does not scroll sideways", async ({
      page,
    }) => {
      await signInThroughTheForm(page, account);
      await expect(
        page.getByRole("heading", { level: 1, name: "Projects" }),
      ).toBeVisible();
      const menuButton = page.getByRole("button", { name: "Menu" });
      const runs = page.getByRole("link", { name: "Runs" });
      await expect(runs).toBeHidden();

      await menuButton.click();
      await expect(menuButton).toHaveAttribute("aria-expanded", "true");
      await runs.click();

      await expect(
        page.getByRole("heading", { level: 1, name: "Runs" }),
      ).toBeVisible();
      await expect(menuButton).toHaveAttribute("aria-expanded", "false");
      await expect(runs).toBeHidden();
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});
