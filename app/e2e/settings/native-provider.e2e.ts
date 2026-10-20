// SPDX-License-Identifier: Apache-2.0

// A workspace on its own key uses a provider of the models.dev catalog for Dynamic Review, in a real browser (#555-T10): the
// Owner searches the providers on the LLM access page, saves a key for one that is neither OpenRouter nor Anthropic, picks its
// provider and one of its tool-calling models for Dynamic Review in the project settings, sees what bounds a run without a
// price, saves, and finds the pair after a reload. The catalog is filled by the real fetch with the committed fixture and no
// network (src/test-support/e2e-models-dev-child.ts). The key is in no address, no page and no answer.
// Not in this journey: the review that runs on this model. A claim hands a catalog model to a runner only once the passthrough
// proxy is wired (the follow-up of #555 and #550-T13); the claim itself is proven at its level
// (integration-tests/http/runner-api-native-own.integration.test.ts).
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
import { fetchModelsDevCatalog } from "../helpers/models-dev";

const account: GithubAccount = {
  id: 7300050,
  login: "native-provider-journey",
  name: "Native Provider Journey",
  email: "native-provider-journey@example.test",
};
const REPOSITORY = "native-provider-journey/widgets";
// A key that must never show up anywhere but in the body of the request that sets it.
const KEY = "sk-deepseek-e2e-workspace-key-0123456789abcdefabcd";

test.describe.configure({ mode: "serial" });

async function openProject(page: Page) {
  await page
    .getByRole("link", { name: "Projects", exact: true })
    .first()
    .click();
  await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: REPOSITORY }),
  ).toBeVisible();
}

test.describe("a provider of the catalog for Dynamic Review", () => {
  test.beforeAll(async ({ request }) => {
    await fetchModelsDevCatalog(e2eEnv.databasePath);
    await addGithubAccount(request, account);
    await addGithubInstallation(
      request,
      { id: 9100050, account: GITHUB_APP_OWNER_ACCOUNT },
      [{ id: 9200050, fullName: REPOSITORY }],
    );
    await syncFromGithubAsAdmin(e2eEnv.appUrl);
  });

  // #555-T10
  test("an Owner saves a key for a catalog provider, picks one of its models for Dynamic Review, and finds it after a reload", async ({
    page,
  }) => {
    const requestedUrls: string[] = [];
    page.on("request", (request) => requestedUrls.push(request.url()));
    await signInThroughTheForm(page, account);

    // The providers of the catalog, searchable, next to the two cards of the registry.
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.getByRole("link", { name: "LLM access" }).first().click();
    await expect(
      page.getByRole("heading", { level: 2, name: "Other providers" }),
    ).toBeVisible();
    const providers = page.getByRole("list", { name: "Providers" });
    await page.getByLabel("Search providers").fill("deep");
    await expect(providers.getByRole("listitem")).toHaveCount(1);
    await providers.getByRole("button", { name: /DeepSeek/ }).click();

    // The key form of that provider: write-only, shown as saved with its last four characters.
    const form = page.getByRole("form", { name: "DeepSeek LLM key" });
    await expect(form).toBeVisible();
    await form.getByLabel("API key").fill(KEY);
    await form.getByRole("button", { name: "Save key" }).click();
    await expect(
      form.getByText(`A key is saved (ends in ${KEY.slice(-4)})`),
    ).toBeVisible();
    await expect(providers.getByText("Key saved")).toBeVisible();
    await page.screenshot({
      path: "test-results/native-provider-llm-access.png",
    });

    // The project: Dynamic Review, the provider with a key, one of its models.
    await openProject(page);
    await page.getByRole("radio", { name: "Dynamic Review" }).click();
    const provider = page.getByRole("combobox", {
      name: "Dynamic Review provider",
    });
    await provider.click();
    await page.getByRole("option", { name: /^DeepSeek/ }).click();
    await page.getByLabel("Search models").fill("v4-pro");
    const models = page.getByRole("list", { name: "Models" });
    await expect(models.getByRole("listitem")).toHaveCount(1);
    await models.getByRole("button", { name: /DeepSeek V4 Pro/ }).click();
    await expect(page.getByTestId("cost-note")).toContainText("models.dev");
    await page.screenshot({
      path: "test-results/native-provider-project-settings.png",
    });

    await page.getByRole("button", { name: "Save review settings" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Switch to Dynamic Review" })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();

    // After a reload the same pair is there, and the provider's key is nowhere.
    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Dynamic Review provider" }),
    ).toContainText("DeepSeek");
    await expect(page.getByText("Chosen:")).toContainText("deepseek-v4-pro");
    expect(await page.content()).not.toContain(KEY);
    for (const url of requestedUrls) expect(url).not.toContain(KEY);
  });
});
