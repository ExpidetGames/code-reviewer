// SPDX-License-Identifier: Apache-2.0

// Pins down the "Review verdict" card of a project's settings in a real browser (#405): an Owner chooses a verdict
// mode, saves and finds it after a reload, and a Member of the workspace sees it and changes it like the other project settings. What is
// sent, the copy and the errors are proven as component and integration tests.
import { expect, test, type Page } from "@playwright/test";
import { syncFromGithubAsAdmin } from "../helpers/admin-api";
import { e2eEnv } from "../helpers/e2e-env";
import {
  addGithubAccount,
  addGithubInstallation,
  GITHUB_APP_OWNER_ACCOUNT,
  signInThroughTheForm,
  signOutThroughTheMenu,
  type GithubAccount,
} from "../helpers/github-fake";

const owner: GithubAccount = {
  id: 7300030,
  login: "verdict-owner",
  name: "Verdict Owner",
  email: "verdict-owner@example.test",
};
const member: GithubAccount = {
  id: 7300031,
  login: "verdict-member",
  name: "Verdict Member",
  email: "verdict-member@example.test",
};
const REPOSITORY = "verdict-owner/gadgets";

test.describe.configure({ mode: "serial" });

async function openProject(page: Page, account: GithubAccount) {
  await signInThroughTheForm(page, account);
  await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: REPOSITORY }),
  ).toBeVisible();
}

test.describe("the review verdict of a project", () => {
  test.beforeAll(async ({ request }) => {
    await addGithubAccount(request, owner);
    await addGithubAccount(request, member, "main", "member");
    await addGithubInstallation(
      request,
      { id: 9100030, account: GITHUB_APP_OWNER_ACCOUNT },
      [{ id: 9200030, fullName: REPOSITORY }],
    );
    await syncFromGithubAsAdmin(e2eEnv.appUrl);
  });

  // #405-T29
  test("an Owner chooses a verdict mode and finds it after a reload, and a Member sees and changes it like the other project settings", async ({
    page,
  }) => {
    await openProject(page, owner);
    const blocking = page.getByRole("radio", {
      name: /Blocking findings only/,
    });
    const any = page.getByRole("radio", { name: /Any finding/ });
    const off = page.getByRole("radio", { name: "Off" });
    // Blocking findings is the default.
    await expect(blocking).toBeChecked();
    await expect(page.getByText("Built-in value.")).toBeVisible();

    await any.click();
    await page.getByRole("button", { name: "Save review settings" }).click();
    await expect(page.getByRole("status")).toContainText("Saved.");
    await page.reload();
    await expect(any).toBeChecked();
    await expect(page.getByText("Set for this project.")).toBeVisible();

    await off.click();
    await page.getByRole("button", { name: "Save review settings" }).click();
    await expect(page.getByRole("status")).toContainText("Saved.");
    await page.reload();
    await expect(off).toBeChecked();

    // Like the review kind and the skill, the verdict is a project setting that every Member of the workspace reads and
    // changes (the role matrix, src/workspaces/permissions.ts: change_project_settings).
    await signOutThroughTheMenu(page, owner);
    await openProject(page, member);
    await expect(page.getByRole("radio", { name: "Off" })).toBeChecked();
    await page.getByRole("radio", { name: /Blocking findings only/ }).click();
    await page.getByRole("button", { name: "Save review settings" }).click();
    await expect(page.getByRole("status")).toContainText("Saved.");
    await page.reload();
    await expect(
      page.getByRole("radio", { name: /Blocking findings only/ }),
    ).toBeChecked();
  });
});
