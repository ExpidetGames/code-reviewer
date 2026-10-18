// SPDX-License-Identifier: Apache-2.0

// The provider and model pickers of a workspace on its own key, in a real browser (#433): a person picks the
// provider and the model of Diff Review, switches the project to Dynamic Review, picks the provider and the model of
// the agent, saves, and finds both pairs after a reload. The model of the agent is checked for tool support when it is
// saved (#269); nothing answers the metadata request in this journey, so the save goes through with the note that the
// model could not be checked (the journey of the review kind has the fake LLM that answers it, and owns its port). The
// managed counterpart (the catalog chooser) is in e2e/operator/limited-workspace.e2e.ts. The details (what is sent,
// the copy, the warning) are component tests.
import { expect, test, type Page } from "@playwright/test";
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
  id: 7300040,
  login: "model-choice-journey",
  name: "Model Choice Journey",
  email: "model-choice-journey@example.test",
};
const REPOSITORY = "model-choice-journey/widgets";
const DIFF_MODEL = "vendor/diff-e2e";
// The model the fake LLM of the review kind journey vouches for, should it be up at the moment: the same answer either way.
const AGENT_MODEL = "vendor/agent-e2e";

test.describe.configure({ mode: "serial" });

async function openProject(page: Page) {
  await signInThroughTheForm(page, account);
  await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: REPOSITORY }),
  ).toBeVisible();
}

test.describe("@smoke the provider and model of a project on its own key", () => {
  test.beforeAll(async ({ request }) => {
    await addGithubAccount(request, account);
    await addGithubInstallation(
      request,
      { id: 9100040, account: GITHUB_APP_OWNER_ACCOUNT },
      [{ id: 9200040, fullName: REPOSITORY }],
    );
    await syncFromGithubAsAdmin(e2eEnv.appUrl);
  });

  // #433-T09
  test("a person picks the provider and the model for Diff Review and for Dynamic Review, and finds them after a reload", async ({
    page,
  }) => {
    await openProject(page);

    // The Diff pair: the provider select next to the model, with the registered provider to pick.
    const provider = page.getByRole("combobox", {
      name: "Provider",
      exact: true,
    });
    await expect(provider).toContainText("OpenRouter");
    await provider.click();
    await expect(page.getByRole("option")).toHaveCount(1);
    await page.getByRole("option", { name: /^OpenRouter/ }).click();
    await page.getByLabel("Model", { exact: true }).fill(DIFF_MODEL);

    // The Dynamic pair, in the same save.
    await page.getByRole("radio", { name: "Dynamic Review" }).click();
    const agentProvider = page.getByRole("combobox", {
      name: "Dynamic Review provider",
    });
    await expect(agentProvider).toContainText("OpenRouter");
    await page
      .getByLabel("Dynamic Review model", { exact: true })
      .fill(AGENT_MODEL);
    await page.getByRole("button", { name: "Save review settings" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Switch to Dynamic Review" })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();

    await page.reload();
    await expect(
      page.getByLabel("Dynamic Review model", { exact: true }),
    ).toHaveValue(AGENT_MODEL);
    await expect(
      page.getByRole("combobox", { name: "Dynamic Review provider" }),
    ).toContainText("OpenRouter");
    await page.getByRole("radio", { name: "Diff Review" }).click();
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue(
      DIFF_MODEL,
    );
    await expect(
      page.getByRole("combobox", { name: "Provider", exact: true }),
    ).toContainText("OpenRouter");

    // Back to Diff Review, so the project is as it was found.
    await page.getByRole("button", { name: "Save review settings" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Switch to Diff Review" })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();
  });
});
