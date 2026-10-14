// SPDX-License-Identifier: Apache-2.0

// Pins down the "Review kind" card of a project's settings in a real browser (#200): the person
// chooses Dynamic Review, reads that the instance has not enabled it yet, edits the model and the review
// skill, confirms the switch, finds everything after a reload, resets the skill to the shipped default
// and switches back to Diff Review. The details (what is sent, the copy, the errors) are proven as
// component and integration tests.
import { expect, test, type Page } from "@playwright/test";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
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
  id: 7300020,
  login: "kind-journey",
  name: "Kind Journey",
  email: "kind-journey@example.test",
};
const REPOSITORY = "kind-journey/widgets";
const SKILL = "E2E skill: only report security problems.";

test.describe.configure({ mode: "serial" });

async function openProject(page: Page) {
  await signInThroughTheForm(page, account);
  await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: REPOSITORY }),
  ).toBeVisible();
}

test.describe("the review kind of a project", () => {
  let llm: FakeLlm | undefined;

  test.beforeAll(async ({ request }) => {
    // The model is checked for tool support when it is saved (#269); the app asks this fake.
    llm = await startLlmFake({ port: e2eEnv.modelLlmFakePort });
    llm.setModel("vendor/agent-e2e", [
      { supported_parameters: ["tools", "tool_choice"] },
    ]);
    await addGithubAccount(request, account);
    await addGithubInstallation(
      request,
      { id: 9100020, account: GITHUB_APP_OWNER_ACCOUNT },
      [{ id: 9200020, fullName: REPOSITORY }],
    );
    await syncFromGithubAsAdmin(e2eEnv.appUrl);
  });

  test.afterAll(async () => {
    await llm?.close();
  });

  // #200-T07
  test("a person switches a project to Dynamic Review, edits and resets the skill, reads that the instance has not enabled it, and switches back", async ({
    page,
  }) => {
    await openProject(page);
    const diff = page.getByRole("radio", { name: "Diff Review" });
    const dynamic = page.getByRole("radio", { name: "Dynamic Review" });
    await expect(diff).toBeChecked();
    // The instance has not turned Dynamic Review on: the option says so, before anything is chosen.
    await expect(
      page.getByText("Not enabled on this instance yet."),
    ).toBeVisible();

    // An untouched form sends nothing.
    await page.getByRole("button", { name: "Save review settings" }).click();
    await expect(page.getByRole("status")).toContainText("No changes to save.");

    // The keyboard chooses a kind too: the arrow key moves the choice while it is held.
    await diff.focus();
    await page.keyboard.press("ArrowDown", { delay: 200 });
    await expect(dynamic).toBeChecked();
    await expect(
      page.getByText(/Reviews of this project fail until an instance admin/),
    ).toBeVisible();
    // The Diff-only controls are gone, the shipped skill is shown read-only.
    await expect(page.getByLabel("Token budget", { exact: true })).toHaveCount(
      0,
    );
    const skill = page.getByLabel("Review skill", { exact: true });
    await expect(skill).toHaveJSProperty("readOnly", true);
    await expect(skill).toHaveValue(/Dynamic Review skill/);
    await expect(
      page.getByText("Shipped default", { exact: true }),
    ).toBeVisible();

    await page
      .getByLabel("Dynamic Review model", { exact: true })
      .fill("vendor/agent-e2e");
    await page.getByRole("button", { name: "Edit skill" }).click();
    await expect(skill).toBeFocused();
    await skill.fill(SKILL);
    await expect(page.getByText(/\d+ of 16,384 bytes/)).toBeVisible();

    // Cancelling the confirmation keeps the choice in the form and stores nothing.
    await page.getByRole("button", { name: "Save review settings" }).click();
    const dialog = page.getByRole("alertdialog", {
      name: "Switch to Dynamic Review?",
    });
    await expect(dialog).toContainText("waiting");
    await expect(dialog).toContainText("new summary comment");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(dynamic).toBeChecked();
    await page.reload();
    await expect(diff).toBeChecked();

    // Again, and confirm.
    await dynamic.click();
    await page
      .getByLabel("Dynamic Review model", { exact: true })
      .fill("vendor/agent-e2e");
    await page.getByRole("button", { name: "Edit skill" }).click();
    await skill.fill(SKILL);
    await page.getByRole("button", { name: "Save review settings" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Switch to Dynamic Review" })
      .click();
    await expect(page.getByRole("status")).toContainText("Saved.");

    await page.reload();
    await expect(dynamic).toBeChecked();
    await expect(
      page.getByLabel("Dynamic Review model", { exact: true }),
    ).toHaveValue("vendor/agent-e2e");
    await expect(skill).toHaveValue(SKILL);
    await expect(page.getByText("Custom skill", { exact: true })).toBeVisible();

    // Resetting the skill is staged until Save, and Save sends no confirmation: the kind stays.
    await page
      .getByRole("button", { name: "Reset review skill to default" })
      .click();
    await expect(skill).toHaveValue(/Dynamic Review skill/);
    await page.reload();
    await expect(skill).toHaveValue(SKILL);
    await page
      .getByRole("button", { name: "Reset review skill to default" })
      .click();
    await page.getByRole("button", { name: "Save review settings" }).click();
    await expect(page.getByRole("status")).toContainText("Saved.");
    await page.reload();
    await expect(skill).toHaveValue(/Dynamic Review skill/);
    await expect(
      page.getByText("Shipped default", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Dynamic Review model", { exact: true }),
    ).toHaveValue("vendor/agent-e2e");

    // Back to Diff Review: confirmed again, and the Diff cards return.
    await diff.click();
    await page.getByRole("button", { name: "Save review settings" }).click();
    await page
      .getByRole("alertdialog", { name: "Switch to Diff Review?" })
      .getByRole("button", { name: "Switch to Diff Review" })
      .click();
    await expect(page.getByRole("status")).toContainText("Saved.");
    await expect(
      page.getByLabel("Token budget", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(diff).toBeChecked();
  });

  test.describe("on a narrow window", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("the Review kind card with the skill does not scroll sideways", async ({
      page,
    }) => {
      await openProject(page);
      await page.getByRole("radio", { name: "Dynamic Review" }).click();
      await expect(
        page.getByLabel("Review skill", { exact: true }),
      ).toBeVisible();

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});
