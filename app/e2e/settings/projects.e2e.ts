// SPDX-License-Identifier: Apache-2.0

// Pins down the project list and the settings pages in a real browser, against a production build
// next to the fake GitHub: a person syncs the repositories of an installation, switches one on,
// changes a review setting and finds it after a reload, sees the cost warning of a pricey model, and
// changes the global defaults that a project without its own value then follows. The details of each
// piece (copy, validation, the routes) are proven as component and integration tests.
import { expect, test } from "@playwright/test";
import { syncFromGithubAsAdmin } from "../helpers/admin-api";
import {
  addGithubAccount,
  addGithubInstallation,
  signInThroughTheForm,
  type GithubAccount,
} from "../helpers/github-fake";
import { e2eEnv } from "../helpers/e2e-env";

const account: GithubAccount = {
  id: 7300002,
  login: "projects-journey",
  name: "Projects Journey",
  email: "projects-journey@example.test",
};
const REPOSITORY = "projects-journey/widgets";

// One repository, switched on in the first journey and used by the ones after it.
test.describe.configure({ mode: "serial" });

test.describe("the project list and the settings pages", () => {
  test.beforeAll(async ({ request }) => {
    await addGithubAccount(request, account);
    await addGithubInstallation(
      request,
      {
        id: 9100001,
        account: { login: account.login, id: account.id, type: "User" },
      },
      [{ id: 9200001, fullName: REPOSITORY }],
    );
  });

  // The global defaults are shared by every spec of the run: put them back as they were found.
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ baseURL: e2eEnv.appUrl });
    await signInThroughTheForm(page, account);
    const response = await page.request.put("/api/w/default/review-settings", {
      data: { settings: {} },
    });
    expect(response.status()).toBe(200);
    await page.close();
  });

  // CR-34-T14, CR-24-T12
  test("@smoke a person syncs the repository, switches it on, changes a setting, reloads and finds it, and switches it off again", async ({
    page,
  }) => {
    // The synchronization reads every connection of the instance: it is the instance admin's. The person
    // here owns the workspace and does not run the instance, so the page has no button for them.
    await syncFromGithubAsAdmin(e2eEnv.appUrl);
    await signInThroughTheForm(page, account);
    await expect(
      page.getByRole("heading", { level: 1, name: "Projects" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sync from GitHub" }),
    ).toHaveCount(0);

    const row = page.getByRole("listitem").filter({ hasText: REPOSITORY });
    await expect(row.getByText("Inactive")).toBeVisible();

    await row.getByRole("switch", { name: `Review ${REPOSITORY}` }).click();
    await expect(row.getByText("Active", { exact: true })).toBeVisible();
    await page.reload();
    await expect(
      page
        .getByRole("listitem")
        .filter({ hasText: REPOSITORY })
        .getByRole("switch"),
    ).toHaveAttribute("aria-checked", "true");

    await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: REPOSITORY }),
    ).toBeVisible();
    await page
      .getByLabel("Most findings per review", { exact: true })
      .fill("12");
    await page.getByRole("button", { name: "Save project settings" }).click();
    await expect(page.getByRole("status")).toContainText("Saved.");
    await page.reload();
    await expect(
      page.getByLabel("Most findings per review", { exact: true }),
    ).toHaveValue("12");

    await page.getByRole("link", { name: "All projects" }).click();
    const again = page.getByRole("listitem").filter({ hasText: REPOSITORY });
    await again.getByRole("switch", { name: `Review ${REPOSITORY}` }).click();
    await expect(again.getByText("Inactive")).toBeVisible();
    await page.reload();
    await expect(
      page
        .getByRole("listitem")
        .filter({ hasText: REPOSITORY })
        .getByText("Inactive"),
    ).toBeVisible();
  });

  // #101-WM-08
  test("@smoke the instance admin finds the Sync from GitHub button on the Projects page and runs it", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
    await page.getByLabel("Password").fill(e2eEnv.adminPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/w\/default\/projects$/);

    await page.getByRole("button", { name: "Sync from GitHub" }).click();
    await expect(page.getByRole("status")).toContainText(/repositor/);
  });

  // CR-34-T14
  test("a person who picks a pricey model sees the cost warning, still saves and sees it again after a reload", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);
    await page.getByRole("link", { name: REPOSITORY, exact: true }).click();

    await page
      .getByLabel("Model", { exact: true })
      .fill("anthropic/claude-sonnet-5.5");
    await expect(page.getByText(/is above the limit of \$0\.10/)).toBeVisible();
    await page.getByRole("button", { name: "Save project settings" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();
    await page.reload();

    await expect(page.getByLabel("Model", { exact: true })).toHaveValue(
      "anthropic/claude-sonnet-5.5",
    );
    await expect(page.getByText(/is above the limit of \$0\.10/)).toBeVisible();
  });

  // CR-34-T14
  test("a person changes a global default and the project they opened before, which has no value of its own for it, shows the new one", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);
    // The project page is visited first: Next keeps it mounted (hidden) while the person is
    // elsewhere and shows it again later, which must not bring back the old value.
    await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
    const budget = () =>
      page
        .getByLabel("Token budget", { exact: true })
        .filter({ visible: true });
    await expect(budget()).toHaveValue("100000");
    await expect(
      page.locator(".field", { has: budget() }).getByText("Built-in value"),
    ).toBeVisible();

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeVisible();
    await budget().fill("60000");
    await page.getByRole("button", { name: "Save defaults" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();
    // No reload here: it would drop the pages Next keeps mounted, which is what this step is about.
    await page.getByRole("link", { name: "Projects" }).click();
    await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: REPOSITORY }),
    ).toBeVisible();
    await expect(budget()).toHaveValue("60000");
    await expect(
      page.locator(".field", { has: budget() }).getByText("Global default"),
    ).toBeVisible();
    await page.reload();
    await expect(budget()).toHaveValue("60000");
  });

  // CR-34-T09, #101-WM-08, #104-LK-13
  test("the Settings page tells the Owner that the LLM is not configured and where to add a key, and nothing of the server's variables, in a browser too", async ({
    page,
    browser,
  }) => {
    await signInThroughTheForm(page, account);

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    // The page left behind stays in the document, hidden, with its own copy of the hint.
    await expect(
      page.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeVisible();

    // The workspace has no key: the hint links to the form, which an Owner can fill.
    await expect(
      page.getByText("LLM not configured").filter({ visible: true }),
    ).toBeVisible();
    await expect(page.getByRole("form", { name: "LLM key" })).toBeVisible();
    await expect(page.getByText(/LLM_API_KEY|GITHUB_APP/)).toHaveCount(0);

    // The instance admin no longer reads about a missing server variable: the key is the workspace's.
    const context = await browser.newContext({ baseURL: e2eEnv.appUrl });
    const admin = await context.newPage();
    await admin.goto("/login");
    await admin.getByLabel("Email address").fill(e2eEnv.adminEmail);
    await admin.getByLabel("Password").fill(e2eEnv.adminPassword);
    await admin.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(admin).toHaveURL(/\/w\/default\/projects$/);
    await admin.goto("/w/default/settings");
    await expect(
      admin.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeVisible();
    await expect(admin.getByText("LLM key missing")).toHaveCount(0);
    await context.close();
  });

  test.describe("on a narrow window", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("the project list and a settings form do not scroll sideways", async ({
      page,
    }) => {
      await signInThroughTheForm(page, account);
      await expect(
        page.getByRole("listitem").filter({ hasText: REPOSITORY }),
      ).toBeVisible();
      const overflow = () =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
      expect(await overflow()).toBeLessThanOrEqual(0);

      await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
      await expect(
        page.getByLabel("Token budget", { exact: true }),
      ).toBeVisible();

      expect(await overflow()).toBeLessThanOrEqual(0);
    });
  });
});
