// The admin portal in a real browser against a production build: the instance admin signs in with email
// and password and finds the five sections and the checklist; a person signed in with GitHub who is not
// an admin gets the 404 of a page that does not exist (the same one, nothing says the portal is there),
// also from the data route; a visitor without a session is sent to the login. The admin changes a setting
// and sees who changed it. The rules behind are proven as integration tests (src/admin/).
import { expect, test, type Page } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";
import {
  addGithubAccount,
  signInThroughTheForm,
  type GithubAccount,
} from "../helpers/github-fake";

const member: GithubAccount = {
  id: 7300101,
  login: "portal-journey",
  name: "Portal Journey",
  email: "portal-journey@example.test",
};

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
  await page.getByLabel("Password").fill(e2eEnv.adminPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
}

test.describe("the admin portal", () => {
  test.beforeAll(async ({ request }) => {
    await addGithubAccount(request, member);
  });

  // #98-AD-03
  test("@smoke the instance admin opens the portal and sees the five sections and the checklist", async ({
    page,
  }) => {
    await signInAsAdmin(page);

    await page.getByRole("button", { name: "admin", exact: true }).click();
    await page.getByRole("link", { name: "Admin" }).click();

    await expect(page).toHaveURL(/\/admin$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Admin" }),
    ).toBeVisible();
    const sections = page.getByRole("navigation", { name: "Admin" });
    await expect(sections.getByRole("link")).toHaveText([
      "Overview",
      "Setup",
      "Integrations",
      "Mail",
      "Limits",
    ]);
    await expect(
      sections.getByRole("link", { name: "Overview" }),
    ).toHaveAttribute("aria-current", "page");
    const checklist = page.getByRole("region", { name: "Checklist" });
    await expect(checklist.getByText("Mail server")).toBeVisible();
    await expect(checklist.getByText("GitHub", { exact: true })).toBeVisible();
    await expect(checklist.getByText("Tenancy")).toBeVisible();
    await expect(checklist.getByText("Sign-up rule")).toBeVisible();
  });

  // #98-AD-14
  test("the admin changes the sign-up rule and the limit and sees who changed them", async ({
    page,
  }) => {
    await signInAsAdmin(page);

    await page.goto("/admin/setup");
    await page.getByRole("radio", { name: /Allowed email domains/ }).check();
    await page.getByLabel("Domains", { exact: true }).fill("e2e.test");
    await page.getByRole("button", { name: "Save sign-up rule" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();
    // Nothing can verify addresses yet, so the notice says the rule does not work.
    await expect(page.getByRole("note")).toContainText("does not work yet");
    await expect(
      page
        .getByRole("form", { name: "Who may sign up" })
        .getByText(`Last changed by ${e2eEnv.adminEmail}`),
    ).toBeVisible();

    await page.goto("/admin/limits");
    await page.getByLabel(/Maximum number of workspaces/).fill("4");
    await page.getByRole("button", { name: "Save limit" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByLabel(/Maximum number of workspaces/)).toHaveValue(
      "4",
    );
    await expect(
      page.getByText(`Last changed by ${e2eEnv.adminEmail}`),
    ).toBeVisible();
  });

  // #98-AD-02
  test("@smoke a signed in person who is not an admin gets the 404 of a page that does not exist, everywhere in the portal", async ({
    page,
  }) => {
    await signInThroughTheForm(page, member);
    const nothing = await page.request.get("/there-is-no-such-page");
    const nothingBody = await nothing.text();

    const paths = [
      "/admin",
      "/admin/setup",
      "/admin/mail",
      "/%61dmin",
      "/admin/",
      "/api/admin/settings",
    ];
    for (const path of paths) {
      const response = await page.request.get(path);
      expect(response.status(), path).toBe(404);
      expect(response.headers()["content-type"], path).toBe(
        nothing.headers()["content-type"],
      );
      // The same page as for a path that is no page at all, apart from the address it was asked for.
      expect(
        (await response.text()).length - nothingBody.length,
        path,
      ).toBeLessThan(200);
    }
    const write = await page.request.put("/api/admin/settings", {
      data: { tenancy: "multi" },
    });
    expect(write.status()).toBe(404);

    // And in the browser: the 404 page, no portal, no way to it in the menu.
    const visit = await page.goto("/admin");
    expect(visit?.status()).toBe(404);
    await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(
      0,
    );
    await page.goto("/projects");
    await page.getByRole("button", { name: member.name }).click();
    await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
  });

  // #98-AD-01
  test("a visitor without a session is sent to the login, and the data route says 401", async ({
    page,
  }) => {
    await page.goto("/admin/setup");
    await expect(page).toHaveURL(/\/login$/);

    const data = await page.request.get("/api/admin/settings");
    expect(data.status()).toBe(401);
  });
});
