// SPDX-License-Identifier: LicenseRef-Proprietary

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
import { chooseOption, openSection } from "../helpers/settings-form";
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
const DIFF_MODEL = "openai/gpt-5.4-mini";
// Both models are in the lists of the dropdowns; the fake LLM of the review kind journey vouches for the agent's, should it be up at the moment: the same answer either way.
const AGENT_MODEL = "deepseek/deepseek-v4-pro";

test.describe.configure({ mode: "serial" });

async function openProject(page: Page) {
  await signInThroughTheForm(page, account);
  await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: REPOSITORY }),
  ).toBeVisible();
}

test.describe("the provider and model of a project on its own key", () => {
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

    // The Diff pair: the provider dropdown, then the model dropdown of that provider.
    await openSection(page, "LLM");
    const provider = page.getByRole("combobox", {
      name: "Provider",
      exact: true,
    });
    await expect(provider).toContainText("OpenRouter");
    await provider.click();
    await expect(page.getByRole("option")).toHaveCount(2);
    await expect(
      page.getByRole("option", { name: /^Anthropic/ }),
    ).toBeVisible();
    await page.getByRole("option", { name: /^OpenRouter/ }).click();
    await chooseOption(page, "Model", DIFF_MODEL);

    // The Dynamic pair, in the same save.
    await openSection(page, "Review");
    await page.getByRole("radio", { name: "Dynamic Review" }).click();
    await openSection(page, "LLM");
    await expect(
      page.getByRole("combobox", { name: "Provider", exact: true }),
    ).toContainText("OpenRouter");
    await chooseOption(page, "Model", AGENT_MODEL);
    await page.getByRole("button", { name: "Save review settings" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Switch to Dynamic Review" })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();

    await page.reload();
    await openSection(page, "LLM");
    await expect(page.getByRole("combobox", { name: "Model" })).toHaveText(
      AGENT_MODEL,
    );
    await expect(
      page.getByRole("combobox", { name: "Provider", exact: true }),
    ).toContainText("OpenRouter");
    await openSection(page, "Review");
    await page.getByRole("radio", { name: "Diff Review" }).click();
    await openSection(page, "LLM");
    await expect(page.getByRole("combobox", { name: "Model" })).toHaveText(
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
