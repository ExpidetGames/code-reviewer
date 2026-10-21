// SPDX-License-Identifier: Apache-2.0

// The choice of the key mode on the LLM access page, end to end (#496-T09), on the app of the billing journeys of the admin portal: with
// billing on, an Owner sees "Use our models" (the default) and "Use my own provider key" with one sentence each about what is charged,
// cannot pick the own key before one is saved, saves a key, picks it, and the choice is still there after a reload; with billing off the
// choice is gone and the page is what it always was. (A Member reading the same card without anything to press is pinned by the
// component test src/llm/ui/key-mode-card.test.tsx; this app has no second account.)
import { expect, test, type Page } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";
import {
  switchBillingOff,
  switchBillingOnWithFakeStripe,
} from "../helpers/stripe-fake";

// A key that must never show up anywhere but in the body of the request that saves it.
const KEY = "sk-or-v1-e2e-key-mode-key-0123456789abcdefabcd";

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
  await page.getByLabel("Password").fill(e2eEnv.adminPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/default\/projects$/);
}

test.describe.configure({ mode: "serial" });

test.describe("the key mode of a workspace", () => {
  test.beforeAll(async () => {
    await switchBillingOnWithFakeStripe(e2eEnv.catalogAdminAppUrl);
  });

  // #496-T09
  test("an Owner sees both choices, saves a key, chooses it and finds the choice after a reload", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/w/default/settings/llm");

    const card = page.getByRole("region", { name: "Which key reviews use" });
    await expect(card).toBeVisible();
    const ours = card.getByRole("radio", { name: /Use our models/ });
    const own = card.getByRole("radio", { name: /Use my own provider key/ });
    await expect(
      card.getByText(/charged for AI and infrastructure/),
    ).toBeVisible();
    await expect(
      card.getByText(/charged for infrastructure only/),
    ).toBeVisible();

    // Our models are the default, and the own key cannot be picked before one is saved.
    await expect(ours).toBeChecked();
    await expect(own).toBeDisabled();
    await expect(
      card.getByText(/Save a provider key below first/),
    ).toBeVisible();

    // The key forms stay on the page while our models are chosen, so the key can be saved first.
    const form = page.getByRole("form", { name: "OpenRouter LLM key" });
    await form.getByLabel("API key").fill(KEY);
    await form.getByRole("button", { name: "Save key" }).click();
    await expect(
      form.getByText(`A key is saved (ends in ${KEY.slice(-4)})`),
    ).toBeVisible();

    await expect(own).toBeEnabled();
    await own.click();
    await card.getByRole("button", { name: "Save choice" }).click();
    await expect(card.getByText("The choice is saved.")).toBeVisible();

    await page.reload();
    await expect(own).toBeChecked();
    const answer = await page.request.get("/api/w/default/llm-key-mode");
    expect(answer.status()).toBe(200);
    expect(await answer.json()).toEqual({ keyMode: "own" });
    expect(await page.content()).not.toContain(KEY);

    // And back to our models.
    await ours.click();
    await card.getByRole("button", { name: "Save choice" }).click();
    await expect(card.getByText("The choice is saved.")).toBeVisible();
    await page.reload();
    await expect(ours).toBeChecked();
  });

  // #496-T09
  test("with billing off there is no choice: the page and the route are as they were", async ({
    page,
  }) => {
    await switchBillingOff(e2eEnv.catalogAdminAppUrl);
    await signInAsAdmin(page);

    await page.goto("/w/default/settings/llm");
    await expect(
      page.getByRole("form", { name: "OpenRouter LLM key" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Which key reviews use" }),
    ).toHaveCount(0);
    expect(
      (await page.request.get("/api/w/default/llm-key-mode")).status(),
    ).toBe(404);
  });
});
