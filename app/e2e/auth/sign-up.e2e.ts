// SPDX-License-Identifier: Apache-2.0

// Signing up and verifying an address in a real browser against a production build with a mail outbox: a
// visitor creates an account, cannot sign in before the address is confirmed, reads the link from the
// inbox, confirms the address with a click and signs in to the page that says to ask an admin for an
// invitation (single-tenant: nothing joins a new account to the workspace). The instance admin, whose
// address is not verified either, still reaches the admin portal. The rules behind are proven as
// integration tests (src/signup/, src/auth/access-gates.integration.test.ts).
import { expect, test, type Page } from "@playwright/test";
import { signOutThroughTheMenu } from "../helpers/github-fake";
import { e2eEnv } from "../helpers/e2e-env";
import { verificationLinkTo, verificationLinksTo } from "../helpers/mail";

const ADDRESS = "newcomer@e2e.test";
const PASSWORD = "e2e-newcomer-passphrase-ember-quartz-31";

// The page behind a link: the password of the sign-up that made it, and the click.
async function confirmWith(page: Page, password: string): Promise<void> {
  const form = page.getByRole("form", { name: "Confirm email address" });
  await form.getByLabel("Password").fill(password);
  await form.getByRole("button", { name: "Confirm email address" }).click();
}

async function signInThroughTheForm(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

// The form of the page. (Next.js keeps the page the visitor came from in the document, hidden, so labels
// are looked up inside the form.)
async function fillSignUp(
  page: Page,
  address: string,
  password: string = PASSWORD,
): Promise<void> {
  const form = page.getByRole("form", { name: "Sign-up form" });
  await form.getByLabel("Email address").fill(address);
  await form.getByLabel("Password", { exact: true }).fill(password);
  await form.getByLabel("Repeat the password").fill(password);
  await form.getByRole("button", { name: "Create account" }).click();
}

test.describe("signing up", () => {
  // #99-SR-21
  test("@smoke a visitor signs up, confirms the address from the link in the mail and reaches the page that asks for an invitation", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Create one" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Create your account" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/sign-up$/);

    await fillSignUp(page, ADDRESS);
    await expect(page.getByRole("status")).toContainText("Check your inbox");

    // Not before the address is confirmed.
    await signInThroughTheForm(page, ADDRESS, PASSWORD);
    // (Next.js has an alert of its own, the route announcer.)
    await expect(
      page.getByRole("alert").filter({ hasText: "Verify your email address" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login\?error=email_not_verified$/);

    const link = await verificationLinkTo(ADDRESS);
    await page.goto(link);
    // The link only opens the page: the address is confirmed by the click.
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
      "content",
      "no-referrer",
    );
    await confirmWith(page, PASSWORD);
    await expect(page.getByRole("status")).toContainText("confirmed");

    await signInThroughTheForm(page, ADDRESS, PASSWORD);
    await expect(page).toHaveURL(/\/no-access$/);
    await expect(
      page.getByText("Ask an admin for an invitation."),
    ).toBeVisible();

    // The data stays out of reach for an account without a workspace.
    const api = await page.request.get("/api/w/default/runs");
    expect(api.status()).toBe(403);
    expect(await api.json()).toEqual({ error: "no_workspace_access" });

    // Signing out lives in the user menu of the header now that the page is inside the app frame.
    await signOutThroughTheMenu(page, { name: ADDRESS.split("@")[0] ?? "" });
    await expect(page).toHaveURL(/\/login$/);
  });

  // #99-SR-14
  test("a visitor who signs up with the address of an account that waits for verification sees the same answer", async ({
    page,
  }) => {
    const answer =
      "Check your inbox. If this address may sign up, we sent it a link to confirm it.";
    await page.goto("/sign-up");
    await fillSignUp(page, e2eEnv.adminEmail);
    await expect(page.getByRole("status")).toHaveText(answer);
    await page.goto("/sign-up");
    await fillSignUp(page, "brand-new@e2e.test");
    await expect(page.getByRole("status")).toHaveText(answer);
  });

  // #99-SR-12
  test("a person who signed up second completes their own sign-up, and the password the first one chose is not an account", async ({
    page,
  }) => {
    const address = "contested@e2e.test";
    const attackersPassword = "e2e-attacker-passphrase-copper-wave-52";
    await page.goto("/sign-up");
    await fillSignUp(page, address, attackersPassword);
    await expect(page.getByRole("status")).toContainText("Check your inbox");
    await page.goto("/sign-up");
    await fillSignUp(page, address, PASSWORD);
    await expect(page.getByRole("status")).toContainText("Check your inbox");
    const [attackers, owners] = await verificationLinksTo(address, 2);

    // The link of the first sign-up cannot be completed with the owner's password.
    await page.goto(attackers ?? "");
    await confirmWith(page, PASSWORD);
    await expect(
      page.getByRole("alert").filter({ hasText: "link or the password" }),
    ).toBeVisible();

    await page.goto(owners ?? "");
    await confirmWith(page, PASSWORD);
    await expect(page.getByRole("status")).toContainText("confirmed");

    await signInThroughTheForm(page, address, attackersPassword);
    await expect(page).toHaveURL(/\/login\?error=invalid_credentials$/);
    await signInThroughTheForm(page, address, PASSWORD);
    await expect(page).toHaveURL(/\/no-access$/);
  });

  // #99-SR-24
  test("the instance admin, whose address is not verified, still reaches the admin portal and nothing else", async ({
    page,
  }) => {
    await signInThroughTheForm(page, e2eEnv.adminEmail, e2eEnv.adminPassword);
    await expect(page).toHaveURL(/\/verify-email$/);

    await page.getByRole("link", { name: "open the admin portal" }).click();

    await expect(page).toHaveURL(/\/admin$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Admin" }),
    ).toBeVisible();
    await page.goto("/w/default/projects");
    await expect(page).toHaveURL(/\/verify-email$/);
  });

  // #99-SR-13
  test("a link that was used or made up is refused with words, and the page offers a new one", async ({
    page,
  }) => {
    await page.goto("/verify-email?token=" + "A".repeat(43));

    await confirmWith(page, PASSWORD);

    // (Next.js has an alert of its own, the route announcer.)
    await expect(
      page.getByRole("alert").filter({ hasText: "link or the password" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Ask for a new link" }),
    ).toBeVisible();
  });
});
