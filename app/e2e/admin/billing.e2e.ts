// SPDX-License-Identifier: LicenseRef-Proprietary

// The billing page of the admin portal, end to end (#504-T16), on the app of the catalog admin journey (an instance of its
// own): the admin opens the page and finds billing off with the statement of what switching it on does, saves a Stripe API key
// and webhook secret (which come back as a status and never as a value), is refused switching billing on while the rates and the
// connection check are missing, chooses the manual adapter, sets A, both rates and the reserve, switches billing on, credits a
// workspace by hand and corrects its balance, and switches billing off again.
//   - Nothing is typed or clicked outside the page: every change goes through the real routes.
//   - The app talks to Stripe's own address only (there is no setting for it, because the API key goes there), so this journey
//     presses no button that calls Stripe. The connection check, the creation of the webhook endpoint and the switch with Stripe
//     run against the fake Stripe at the integration level (src/billing/admin-billing.integration.test.ts).
import { expect, test, type Page } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";

/** A dummy that must never show up on the page again after it was saved. */
const API_KEY = "sk_test_E2eDummyStripeKey0123456789";
const WEBHOOK_SECRET = "whsec_E2eWebhookSecret0123456789abcdef";

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
  await page.getByLabel("Password").fill(e2eEnv.adminPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/default\/projects$/);
}

test.describe("the billing page in the admin portal", () => {
  // #504-T16
  test("the admin configures billing, switches it on, credits a workspace and switches it off", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/admin");
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Billing" })
      .first()
      .click();
    await expect(page).toHaveURL(/\/admin\/billing$/);

    // Off, with the statement.
    await expect(
      page.getByRole("heading", { name: "Billing is off" }),
    ).toBeVisible();
    await expect(
      page.getByText(/charged from a prepaid balance/),
    ).toBeVisible();
    await expect(
      page.getByText(/Each workspace chooses its key mode/),
    ).toBeVisible();
    await expect(
      page.getByText(/This instance has 1 workspace\./),
    ).toBeVisible();

    // Stripe, with the credentials: they are write-only.
    await page.getByRole("radio", { name: /^Stripe:/ }).click();
    await page.getByLabel("Stripe API key", { exact: true }).fill(API_KEY);
    await page
      .getByLabel("Webhook secret", { exact: true })
      .fill(WEBHOOK_SECRET);
    await page.getByRole("button", { name: "Save credentials" }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    await expect(
      page.getByLabel("Stripe API key", { exact: true }),
    ).toHaveValue("");
    await expect(
      page.getByText(/An API key is saved, ending in 6789\./),
    ).toBeVisible();
    await expect(page.getByText(/test mode/).first()).toBeVisible();
    // This app's address is http on the loopback, which Stripe could not reach.
    await expect(page.getByText(/not a public https address/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create webhook endpoint" }),
    ).toBeDisabled();

    // Switching on is refused while the rates and the connection check are missing, with the items named.
    await page.getByRole("switch", { name: "Switch billing on" }).click();
    const refusal = page.getByRole("note").filter({
      hasText: "Billing cannot be switched on yet",
    });
    await expect(refusal).toBeVisible();
    await expect(refusal.getByText("The factor A")).toBeVisible();
    await expect(refusal.getByText("A passing connection check")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Billing is off" }),
    ).toBeVisible();

    // The manual adapter needs no provider, and the rates as decimals.
    await page.getByRole("radio", { name: /^Manual:/ }).click();
    await page.getByLabel("Factor A", { exact: true }).fill("5");
    await page
      .getByLabel("Rate per started minute, Diff reviews (USD)", {
        exact: true,
      })
      .fill("0.013");
    await page
      .getByLabel("Rate per started minute, Dynamic reviews (USD)", {
        exact: true,
      })
      .fill("0.016");
    await page
      .getByLabel("AI reserve per Diff review (USD)", { exact: true })
      .fill("0.15");
    await page.getByRole("button", { name: "Save rates and numbers" }).click();
    await expect(
      page.getByText("Saved.", { exact: true }).last(),
    ).toBeVisible();

    // On.
    await page.getByRole("switch", { name: "Switch billing on" }).click();
    await expect(
      page.getByRole("heading", { name: "Billing is on" }),
    ).toBeVisible();

    // The manual credit and correction for the one workspace.
    await page.getByLabel("Search workspaces", { exact: true }).fill("default");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: /Default workspace/ }).click();
    await expect(page.getByText(/has a balance of/)).toBeVisible();
    await page.getByLabel("Amount (USD)", { exact: true }).fill("10");
    await page.getByLabel("Note", { exact: true }).fill("Pilot customer");
    await page.getByRole("button", { name: "Write credit" }).click();
    await expect(
      page.getByText("The credit is written to the journal."),
    ).toBeVisible();
    await expect(page.getByText("10.00 USD")).toBeVisible();

    await page.getByRole("radio", { name: /A correction/ }).click();
    await page.getByLabel("Amount (USD)", { exact: true }).fill("-2");
    await page
      .getByLabel("Note", { exact: true })
      .fill("Refunded outside Stripe");
    await page.getByRole("button", { name: "Write correction" }).click();
    await expect(
      page.getByText("The correction is written to the journal."),
    ).toBeVisible();
    await expect(page.getByText("8.00 USD")).toBeVisible();
    await expect(page.getByText("Pilot customer")).toBeVisible();

    // Nothing of the credentials is on the page after a reload, only their status.
    await page.reload();
    const text =
      (await page.locator("body").innerText()) + (await page.content());
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(WEBHOOK_SECRET);
    await expect(
      page.getByRole("heading", { name: "Billing is on" }),
    ).toBeVisible();

    // Off again, with the rates and the balance as they were.
    await page.getByRole("switch", { name: "Billing is switched on" }).click();
    await expect(
      page.getByRole("heading", { name: "Billing is off" }),
    ).toBeVisible();
    await expect(page.getByLabel("Factor A", { exact: true })).toHaveValue("5");
    await page.getByLabel("Search workspaces", { exact: true }).fill("default");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: /Default workspace/ }).click();
    await expect(page.getByText("8.00 USD")).toBeVisible();
  });
});
