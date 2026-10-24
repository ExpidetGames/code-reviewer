// SPDX-License-Identifier: LicenseRef-Proprietary

// The billing page of a workspace, end to end (#505-T03, T04, T11), on the app of the billing journeys of the admin portal against
// the fake Stripe (`fakes/stripe`): billing is switched on with the Stripe adapter the way the operator does it, then an Owner of the
// default workspace saves the billing details, ticks the business confirmation, pays $25 at the (fake) checkout and sees the payment
// on its way until the webhook credits it; a second payment whose webhook is lost is credited once by "Check payment", and the
// webhook that arrives afterwards changes nothing; each payment leaves an invoice in the Invoices card (#659); with billing off the page is gone and the plan page is the old one.
//   - A person never leaves the app's pages: the payment page is a stub the journey serves for the checkout address, and the buyer
//     "pays" over the control API of the fake, which then delivers its signed events to the app's real webhook route.
import { expect, test, type Page } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";
import {
  deliverEvents,
  payFakeSession,
  switchBillingOff,
  switchBillingOnWithFakeStripe,
} from "../helpers/stripe-fake";

// The address of a Checkout session at the fake Stripe: the buyer would pay there; the journey serves a stub page instead.
const CHECKOUT = `${e2eEnv.stripeFakeUrl}/c/pay/**`;

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
  await page.getByLabel("Password").fill(e2eEnv.adminPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/default\/projects$/);
}

/** The balance on the page in whole cents (`$1,234.50` is 123450). */
async function balanceCents(page: Page): Promise<number> {
  const text = (
    await page.locator("[data-slot=balance-amount]").innerText()
  ).trim();
  const match = /^(-?)\$([\d,]+)\.(\d{2})/.exec(text);
  if (match === null) throw new Error(`The balance reads ${text}.`);
  const cents = Number(match[2]?.replace(/,/g, "")) * 100 + Number(match[3]);
  return match[1] === "-" ? -cents : cents;
}

function dollars(cents: number): string {
  const whole = Math.trunc(cents / 100);
  return `$${whole.toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;
}

/** Presses "Continue to payment" and returns the id of the Checkout session the browser was sent to. */
async function payAt(page: Page): Promise<string> {
  await page.route(CHECKOUT, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Fake checkout</title><h1>Fake checkout</h1>",
    }),
  );
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await page.waitForURL(/\/c\/pay\/cs_/);
  const match = /\/c\/pay\/(cs_[A-Za-z0-9_]+)/.exec(page.url());
  if (match?.[1] === undefined) throw new Error(`No session in ${page.url()}.`);
  return match[1];
}

test.describe("the billing page of a workspace", () => {
  test.beforeAll(async () => {
    await switchBillingOnWithFakeStripe(e2eEnv.catalogAdminAppUrl);
  });

  // #505-T03
  test("an Owner saves the billing details, confirms the business, pays at the checkout and sees the credit arrive", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/w/default/settings/billing");

    // Billing replaces the plan page in the settings navigation.
    const sections = page.getByRole("navigation", {
      name: "Settings sections",
    });
    await expect(sections.getByRole("link", { name: "Billing" })).toBeVisible();
    await expect(sections.getByRole("link", { name: "Plan" })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Billing", level: 1 }),
    ).toBeVisible();
    const before = await balanceCents(page);

    // A payment cannot start without the billing details.
    await expect(
      page.getByRole("button", { name: "Continue to payment" }),
    ).toBeDisabled();
    await page.getByLabel("Legal name").fill("Acme Reviews GmbH");
    await page.getByLabel("Address", { exact: true }).fill("Hauptstrasse 1");
    await page.getByLabel("Postal code").fill("10115");
    await page.getByLabel("City").fill("Berlin");
    await page.getByLabel(/^Country/).fill("DE");
    await page.getByRole("button", { name: "Save billing details" }).click();
    await expect(page.getByText("Billing details saved.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue to payment" }),
    ).toBeEnabled();

    // The first payment needs the business confirmation.
    await page.getByRole("radio", { name: "$25" }).click();
    await page.getByRole("button", { name: "Continue to payment" }).click();
    await expect(
      page.getByText("Confirm that you are buying for a business to continue."),
    ).toBeVisible();
    // The confirmation links to the operator's terms and privacy statement (#626; the helper sets them with the admin routes).
    await expect(
      page.getByRole("link", { name: "Terms", exact: true }),
    ).toHaveAttribute("href", "https://example.com/terms");
    await expect(
      page.getByRole("link", { name: "Privacy", exact: true }),
    ).toHaveAttribute("href", "https://example.com/privacy");
    await page.getByRole("checkbox", { name: /buying for a business/ }).click();
    const session = await payAt(page);

    // Back from the payment page: it is on its way, and the page says so until the credit arrives.
    await page.goto("/w/default/settings/billing?topup=success");
    await expect(page.getByText(/Your payment is on its way/)).toBeVisible();
    // (An earlier journey of this app left a payment without a payment page in the list; it has no Check payment.)
    const waiting = page.getByRole("region", { name: "Payments on their way" });
    await expect(waiting.getByText("$25.00").first()).toBeVisible();
    await expect(
      waiting.getByRole("button", { name: "Check payment" }),
    ).toHaveCount(1);
    expect(await balanceCents(page)).toBe(before);

    // The buyer pays at Stripe; Stripe delivers its signed events to the app's webhook route; the page notices without a reload.
    await payFakeSession(session);
    const delivered = await deliverEvents();
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.every((status) => status === 200)).toBe(true);
    await expect(page.locator("[data-slot=balance-amount]")).toHaveText(
      dollars(before + 2_500),
      { timeout: 30_000 },
    );
    await expect(
      waiting.getByRole("button", { name: "Check payment" }),
    ).toHaveCount(0);
    const journal = page.getByRole("region", { name: "Journal" });
    await expect(journal.getByText("Credit added").first()).toBeVisible();
    await expect(journal.getByText("+$25.00")).toBeVisible();

    // #659-T01, T02: the payment left an invoice, and the card lists it with its amount, status and the two links (it asked again
    // when the balance changed, so no reload is needed).
    const invoices = page.getByRole("region", { name: "Invoices" });
    const invoiceRow = invoices.getByRole("row").nth(1);
    await expect(invoiceRow).toContainText("$25.00");
    await expect(invoiceRow).toContainText("Paid");
    await expect(
      invoiceRow.getByRole("link", { name: /^View / }),
    ).toHaveAttribute("href", /\/i\/pi_/);
    await expect(
      invoiceRow.getByRole("link", { name: /^Download PDF / }),
    ).toHaveAttribute("href", /\/i\/pi_[A-Za-z0-9_]+\/pdf$/);

    // The business confirmation is given once: the next payment does not ask again.
    await page.goto("/w/default/settings/billing");
    await expect(
      page.getByRole("checkbox", { name: /buying for a business/ }),
    ).toHaveCount(0);
  });

  // #505-T04
  test("a payment whose webhook is lost is credited once by Check payment, and the late webhook changes nothing", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/w/default/settings/billing");
    const before = await balanceCents(page);
    const journal = page.getByRole("region", { name: "Journal" });
    await expect(journal.getByRole("row").nth(1)).toBeVisible();
    const rowsBefore = await journal.getByRole("row").count();

    await page.getByRole("radio", { name: "$10", exact: true }).click();
    const session = await payAt(page);
    await payFakeSession(session);
    // The events wait at the fake: the webhook is "lost" for now.
    await page.goto("/w/default/settings/billing?topup=success");
    const waiting = page.getByRole("region", { name: "Payments on their way" });
    await expect(waiting.getByText("$10.00")).toBeVisible();
    expect(await balanceCents(page)).toBe(before);

    await waiting.getByRole("button", { name: "Check payment" }).click();
    await expect(
      page.getByText("The payment arrived and the credit is added."),
    ).toBeVisible();
    await expect(page.locator("[data-slot=balance-amount]")).toHaveText(
      dollars(before + 1_000),
    );

    // The webhook arrives after all: the credit is already there, so nothing is added a second time.
    const delivered = await deliverEvents();
    expect(delivered.length).toBeGreaterThan(0);
    await page.reload();
    expect(await balanceCents(page)).toBe(before + 1_000);
    // One row more than before the payment: the late webhook did not credit it a second time.
    await expect(journal.getByRole("row")).toHaveCount(rowsBefore + 1);
    await expect(journal.getByRole("row").nth(1)).toContainText("+$10.00");
    // #659-T02: the newest invoice is the one of this payment.
    await expect(
      page.getByRole("region", { name: "Invoices" }).getByRole("row").nth(1),
    ).toContainText("$10.00");
  });

  // #505-T09
  test("an Owner sets the monthly limit and removes it again", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/w/default/settings/billing");

    const limit = page.getByRole("region", { name: "Monthly spending limit" });
    await limit.getByLabel(/^Monthly limit/).fill("250");
    await limit.getByRole("button", { name: "Save limit" }).click();
    await expect(limit.getByText("Limit saved.")).toBeVisible();
    await page.reload();
    await expect(limit.getByLabel(/^Monthly limit/)).toHaveValue("250");

    await limit.getByLabel(/^Monthly limit/).fill("");
    await limit.getByRole("button", { name: "Save limit" }).click();
    await expect(limit.getByText("Limit removed.")).toBeVisible();
    await page.reload();
    await expect(limit.getByLabel(/^Monthly limit/)).toHaveValue("");
  });

  // #505-T11
  test("the plan page leads on to the billing page while billing is on and is the old page again once it is off", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/w/default/settings/plan");
    await expect(page).toHaveURL(/\/w\/default\/settings\/billing$/);

    await switchBillingOff(e2eEnv.catalogAdminAppUrl);

    const sections = page.getByRole("navigation", {
      name: "Settings sections",
    });
    await page.goto("/w/default/settings/plan");
    await expect(page).toHaveURL(/\/w\/default\/settings\/plan$/);
    await expect(
      page.getByText("No limits apply to this workspace."),
    ).toBeVisible();
    await expect(sections.getByRole("link", { name: "Billing" })).toHaveCount(
      0,
    );
    // Nothing of billing answers: the page and the routes are paths that do not exist.
    await page.goto("/w/default/settings/billing");
    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
    for (const path of ["journal", "profile", "monthly-limit"]) {
      const answer = await page.request.get(`/api/w/default/billing/${path}`);
      expect(answer.status(), path).toBe(404);
    }
  });
});
