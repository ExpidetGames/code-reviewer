// SPDX-License-Identifier: LicenseRef-Proprietary

// The payment reviews of the admin portal, end to end (#603-T18), on the app of the billing journey (an instance of its own):
// two events the webhook could not apply are waiting (a refused payment of the default workspace's top-up, and a refund of a
// payment that is none of ours). The admin sees the count on the overview and on the Billing menu entry, opens the list, is
// refused closing a row without a note, closes the foreign row with a note, credits the default workspace from the refused
// row with a smaller amount than the top-up asked for, finds both rows under Resolved with the note and the journal entry,
// and finds the credit on the Billing page.
//   - Nothing is typed or clicked outside the page: the rows are left by the app's real repositories, every change goes
//     through the real routes.
//   - "Check payment" asks Stripe and is covered at the integration level against the fake Stripe.
import { expect, test, type Page } from "@playwright/test";
import { seedBillingReviews } from "../helpers/billing-reviews";
import { e2eEnv } from "../helpers/e2e-env";

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
  await page.getByLabel("Password").fill(e2eEnv.adminPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/default\/projects$/);
}

test.describe("the payment reviews in the admin portal", () => {
  // #603-T18
  test("the admin sees the open rows, closes one with a note and credits the workspace from the other", async ({
    page,
  }) => {
    await seedBillingReviews(e2eEnv.catalogAdminDatabasePath);
    await signInAsAdmin(page);

    // Seen without opening the list: the overview and the menu.
    await page.goto("/admin");
    await expect(page.getByText("2 payments need a review.")).toBeVisible();
    await expect(
      page.getByRole("link", { name: /^Billing\s*, 2 open payment reviews$/ }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: /^Payment reviews/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/admin\/billing\/reviews$/);
    await expect(
      page.getByRole("heading", { name: "Payment reviews", level: 1 }),
    ).toBeVisible();

    // Newest first, with what is needed to act.
    const refused = page.getByRole("listitem", { name: /evt_e2e_refused/ });
    const foreign = page.getByRole("listitem", { name: /evt_e2e_foreign/ });
    await expect(refused).toBeVisible();
    await expect(foreign).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Open reviews" }).getByRole("listitem"),
    ).toHaveText([/evt_e2e_refused/, /evt_e2e_foreign/]);
    await expect(refused.getByText("Payment pi_e2e_refused")).toBeVisible();
    await expect(refused.getByText(/Default workspace/)).toBeVisible();
    await expect(refused.getByText(/25\.00 USD asked/)).toBeVisible();
    await expect(foreign.getByText("Refund re_e2e_foreign")).toBeVisible();
    await expect(foreign.getByText(/No workspace is known/)).toBeVisible();
    await expect(foreign.getByRole("button", { name: /Credit/ })).toHaveCount(
      0,
    );

    // A note is required.
    await foreign
      .getByRole("button", { name: "Close without a credit" })
      .click();
    await expect(
      foreign.getByText("Write a note that says why: it stays in the journal."),
    ).toBeVisible();
    await foreign
      .getByLabel("Note")
      .fill("Another product on this Stripe account");
    await foreign
      .getByRole("button", { name: "Close without a credit" })
      .click();
    await expect(
      page.getByRole("listitem", { name: /evt_e2e_foreign/ }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open (1)" })).toBeVisible();

    // Credit from the refused row: prefilled with what the top-up asked for, changed to what the buyer paid.
    await expect(refused.getByLabel("Amount (USD)")).toHaveValue("25.00");
    await refused.getByLabel("Amount (USD)").fill("12.5");
    await refused
      .getByLabel("Note")
      .fill("Paid 12.50 after a coupon; credited by hand");
    await refused
      .getByRole("button", { name: "Credit the workspace and close" })
      .click();
    await expect(page.getByText("No payment needs a review.")).toBeVisible();

    // Both rows are under Resolved, with the note and, for the credit, the journal entry.
    await page.getByRole("link", { name: "Resolved" }).click();
    await expect(page).toHaveURL(/state=resolved$/);
    const closedRefused = page.getByRole("listitem", {
      name: /evt_e2e_refused/,
    });
    await expect(
      closedRefused.getByText("Paid 12.50 after a coupon; credited by hand"),
    ).toBeVisible();
    await expect(closedRefused.getByText("Journal entry")).toBeVisible();
    const closedForeign = page.getByRole("listitem", {
      name: /evt_e2e_foreign/,
    });
    await expect(
      closedForeign.getByText("Another product on this Stripe account"),
    ).toBeVisible();
    await expect(closedForeign.getByText("Journal entry")).toHaveCount(0);
    await expect(closedRefused.getByRole("button")).toHaveCount(0);

    // The count is gone from the menu, and the credit is in the journal of the workspace.
    await expect(
      page.getByRole("link", { name: /^Billing\s*, \d+ open/ }),
    ).toHaveCount(0);
    await page.goto("/admin/billing");
    await page.getByLabel("Search workspaces", { exact: true }).fill("default");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: /Default workspace/ }).click();
    await expect(page.getByText("20.50 USD")).toBeVisible();
    await expect(
      page.getByText("Paid 12.50 after a coupon; credited by hand"),
    ).toBeVisible();
  });
});
