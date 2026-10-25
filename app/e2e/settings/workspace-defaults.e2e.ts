// SPDX-License-Identifier: LicenseRef-Proprietary

// The workspace Review defaults in a real browser (#676), against a production build next to the fake GitHub and the fake
// LLM. An Owner of a workspace of their own (the multi-tenant app, so the defaults change nothing for the other journeys) finds
// the sections of a project on the Review defaults page, chooses Dynamic Review with a model and a verdict as the default of
// every project, and finds a project that sets nothing following it, says so, and winning over it where it sets a value of its
// own; "Reset to default" returns to the workspace's model. What the claim, the queue and the new-project rule do with the
// defaults is proven as integration tests (src/review-settings/, src/jobs/, src/projects/).
import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import { e2eEnv } from "../helpers/e2e-env";
import {
  addGithubAccount,
  addGithubInstallation,
  addGithubOrgMember,
  setGithubAppSetupUrl,
  type GithubAccount,
} from "../helpers/github-fake";
import {
  connectGithub,
  founder,
  switchRepositoryOn,
} from "../helpers/multi-tenant";
import { chooseOption, openSection } from "../helpers/settings-form";

const account: GithubAccount = {
  id: 7850001,
  login: "defaults-owner",
  name: "Defaults Owner",
  email: "defaults-owner@example.test",
};
const ORG = {
  login: "defaults-org",
  id: 7860001,
  type: "Organization",
} as const;
const REPOSITORY = "defaults-org/widgets";
const WORKSPACE_MODEL = "deepseek/deepseek-v4-pro";
const SHIPPED_MODEL = "deepseek/deepseek-v4.1-flash";
const KEY = "sk-or-v1-e2e-defaults-key-0123456789abcdefabcd";

test.describe.configure({ mode: "serial" });

test.describe("the review defaults of a workspace", () => {
  let llm: FakeLlm | undefined;
  let page: Page;
  let slug = "";

  test.beforeAll(async ({ browser, request }) => {
    // The Dynamic model of a save is checked for tool support (#269); the fifth app asks this fake.
    llm = await startLlmFake({ port: e2eEnv.llmFakePort });
    for (const model of [WORKSPACE_MODEL, SHIPPED_MODEL])
      llm.setModel(model, [{ supported_parameters: ["tools", "tool_choice"] }]);
    await addGithubAccount(request, account, null);
    await addGithubInstallation(request, { id: 9850001, account: ORG }, [
      { id: 9860001, fullName: REPOSITORY },
    ]);
    await addGithubOrgMember(request, {
      org: ORG.login,
      login: account.login,
      role: "admin",
    });
    await setGithubAppSetupUrl(
      request,
      `${e2eEnv.multiAppUrl}/github/connected`,
    );
    const owner = await founder(
      browser,
      e2eEnv.multiAppUrl,
      `defaults-${randomBytes(4).toString("hex")}@e2e.test`,
      `Defaults ${randomBytes(3).toString("hex")}`,
    );
    page = owner.page;
    slug = owner.slug;
    await connectGithub(page, slug, {
      installOn: ORG.login,
      authorizeAs: account,
    });
    await switchRepositoryOn(page, slug, REPOSITORY);
  });

  test.afterAll(async () => {
    await page.context().close();
    await llm?.close();
  });

  const dynamic = () => page.getByRole("radio", { name: "Dynamic Review" });
  const diff = () => page.getByRole("radio", { name: "Diff Review" });

  async function openProject() {
    await page.goto(`/w/${slug}/projects`);
    await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: REPOSITORY }),
    ).toBeVisible();
  }

  async function openDefaults() {
    await page.goto(`/w/${slug}/settings/review-defaults`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Review defaults" }),
    ).toBeVisible();
  }

  // #676-T08
  test("the Review defaults page has the sections of a project, with the kind and verdict as defaults and no skill", async () => {
    await openProject();
    await expect(diff()).toBeChecked();
    await expect(page.getByText("Global default", { exact: true })).toHaveCount(
      0,
    );

    await openDefaults();
    await expect(page.getByRole("tab").filter({ visible: true })).toHaveText([
      "Review",
      "LLM",
      "Trigger",
      "Limits",
    ]);
    await expect(diff()).toBeChecked();
    await expect(
      page.getByRole("radiogroup", { name: "Review verdict" }),
    ).toBeVisible();
    await expect(page.getByLabel("Review skill", { exact: true })).toHaveCount(
      0,
    );
    await openSection(page, "LLM");
    await expect(
      page.getByRole("combobox", { name: "Provider" }),
    ).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Model" })).toBeVisible();
  });

  // #676-T08
  test("an Owner chooses Dynamic Review, a model and a verdict as the default of every project, and finds them after a reload", async () => {
    await openDefaults();
    await dynamic().click();
    await page.getByRole("radio", { name: "Any finding" }).click();
    await openSection(page, "LLM");
    await chooseOption(page, "Model", WORKSPACE_MODEL);

    // Dynamic Review as the default of every project needs a key to run on: without one the save is refused (#679 review).
    await page.getByRole("button", { name: "Save review defaults" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Switch to Dynamic Review" })
      .click();
    await expect(
      page.getByText(/Dynamic Review cannot run for this workspace yet/),
    ).toBeVisible();
    const stored = await page.request.put(`/api/w/${slug}/llm-key`, {
      data: { provider: "openrouter", apiKey: KEY },
    });
    expect(stored.ok()).toBe(true);

    await page.getByRole("button", { name: "Save review defaults" }).click();
    const dialog = page.getByRole("alertdialog", {
      name: "Switch to Dynamic Review?",
    });
    // The server counts the projects that follow the default; the confirmation names that number.
    await expect(dialog).toContainText(
      /(project follows|projects follow) this default and switch|No existing project follows this default/,
    );
    await dialog
      .getByRole("button", { name: "Switch to Dynamic Review" })
      .click();
    await expect(page.getByRole("status")).toContainText("Saved.");

    await page.reload();
    await expect(dynamic()).toBeChecked();
    await expect(
      page.getByRole("radio", { name: /Any finding/ }),
    ).toBeChecked();
    await openSection(page, "LLM");
    await expect(page.getByRole("combobox", { name: "Model" })).toHaveText(
      WORKSPACE_MODEL,
    );
  });

  // #676-T02, #676-T08
  test("a project that sets nothing follows them and says so; its own model wins, and Reset to default returns to the workspace's", async () => {
    await openProject();
    await expect(dynamic()).toBeChecked();
    await expect(
      page.getByText("Global default", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("radio", { name: /Any finding/ }),
    ).toBeChecked();
    await openSection(page, "LLM");
    await expect(page.getByRole("combobox", { name: "Model" })).toHaveText(
      WORKSPACE_MODEL,
    );

    await chooseOption(page, "Model", SHIPPED_MODEL);
    await expect(
      page.getByText("Set for this project", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Save review settings" }).click();
    await expect(page.getByRole("status")).toContainText("Saved.");
    await page.reload();
    await openSection(page, "LLM");
    await expect(page.getByRole("combobox", { name: "Model" })).toHaveText(
      SHIPPED_MODEL,
    );

    // Back to the default of the workspace, not to the shipped model.
    await page
      .getByRole("button", {
        name: "Reset to default for Dynamic Review provider and model",
      })
      .click();
    await expect(page.getByRole("combobox", { name: "Model" })).toHaveText(
      WORKSPACE_MODEL,
    );
    await page.getByRole("button", { name: "Save review settings" }).click();
    await expect(page.getByRole("status")).toContainText("Saved.");
    await page.reload();
    await openSection(page, "LLM");
    await expect(page.getByRole("combobox", { name: "Model" })).toHaveText(
      WORKSPACE_MODEL,
    );
    await expect(
      page.getByText("Set for this project", { exact: true }),
    ).toHaveCount(0);
  });

  // #676-T02, #676-T08
  test("a project that chooses Diff Review keeps it whatever the default is", async () => {
    await openProject();
    await diff().click();
    await page.getByRole("button", { name: "Save review settings" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Switch to Diff Review" })
      .click();
    await expect(page.getByRole("status")).toContainText("Saved.");

    await page.reload();
    await expect(diff()).toBeChecked();
    await expect(page.getByText("Global default", { exact: true })).toHaveCount(
      1,
    );
  });
});
