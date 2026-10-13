// SPDX-License-Identifier: Apache-2.0

// Pins down, in a real browser, that the settings of a repository can be opened and saved before the
// repository is activated: the project list links an inactive repository to its settings, the page
// says that no reviews run until it is activated, a saved value survives a reload and an
// activation, and saving does not switch the repository on.
import { expect, test } from "@playwright/test";
import { syncFromGithubAsAdmin } from "../helpers/admin-api";
import { e2eEnv } from "../helpers/e2e-env";
import {
  addGithubAccount,
  addGithubInstallation,
  GITHUB_APP_OWNER_ACCOUNT,
  signInThroughTheForm,
  type GithubAccount,
} from "../helpers/github-fake";

const account: GithubAccount = {
  id: 7300010,
  login: "inactive-journey",
  name: "Inactive Journey",
  email: "inactive-journey@example.test",
};
const REPOSITORY = "inactive-journey/gadgets";

test.describe("the settings of an inactive project", () => {
  test.beforeAll(async ({ request }) => {
    await addGithubAccount(request, account);
    await addGithubInstallation(
      request,
      {
        id: 9100010,
        account: GITHUB_APP_OWNER_ACCOUNT,
      },
      [{ id: 9200010, fullName: REPOSITORY }],
    );
  });

  // #80
  test("a person opens the settings of a repository that was never activated, saves a value, finds it after a reload and after switching the repository on", async ({
    page,
  }) => {
    await syncFromGithubAsAdmin(e2eEnv.appUrl);
    await signInThroughTheForm(page, account);
    const row = page.getByRole("row").filter({ hasText: REPOSITORY });
    await expect(row.getByText("Inactive", { exact: true })).toBeVisible();

    await row.getByRole("link", { name: REPOSITORY, exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: REPOSITORY }),
    ).toBeVisible();
    await expect(
      page.getByText(/no reviews run until the project is activated/),
    ).toBeVisible();
    await page
      .getByLabel("Most findings per review", { exact: true })
      .fill("7");
    await page.getByRole("button", { name: "Save review settings" }).click();
    await expect(page.getByRole("status")).toContainText("Saved.");
    await page.reload();
    await expect(
      page.getByLabel("Most findings per review", { exact: true }),
    ).toHaveValue("7");

    // Saving did not switch the repository on.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Projects" })
      .click();
    const again = page.getByRole("row").filter({ hasText: REPOSITORY });
    await expect(again.getByText("Inactive", { exact: true })).toBeVisible();
    await expect(
      again.getByRole("switch", { name: `Review ${REPOSITORY}` }),
    ).toHaveAttribute("aria-checked", "false");

    await again.getByRole("switch", { name: `Review ${REPOSITORY}` }).click();
    await expect(again.getByText("Active", { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
    await expect(
      page.getByLabel("Most findings per review", { exact: true }),
    ).toHaveValue("7");
  });
});
