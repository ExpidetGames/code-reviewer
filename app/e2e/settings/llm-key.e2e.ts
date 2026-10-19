// SPDX-License-Identifier: Apache-2.0

// The LLM key of a workspace in a real browser against a production build (the multi-tenant app, where a
// workspace of its own changes nothing for the other journeys): the Owner of a new workspace is told that
// the LLM is not configured, enters a key, sees it as saved (its last four characters only), tests it against the
// fake LLM (accepted, then rejected, with the key in neither answer), and a Member of the workspace sees only
// whether reviews have a key and is refused by the server when they try to set, test or remove it. The key is
// in no address, no page and no answer. The review that uses the key of the workspace is in
// e2e/jobs/pull-request-to-review.e2e.ts; the rules behind are proven as integration tests (src/llm/).
import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import { e2eEnv } from "../helpers/e2e-env";
import { joinWorkspace } from "../helpers/github-fake";

const PASSWORD = "e2e-llm-journey-passphrase-willow-31";
// A key that must never show up anywhere but in the body of the request that sets or tests it.
const KEY = "sk-or-v1-e2e-workspace-key-0123456789abcdefabcd";
const UNKNOWN_KEY = "sk-or-v1-e2e-key-nobody-accepts-9876543210fedcba";

const address = (prefix: string) =>
  `${prefix}-${randomBytes(4).toString("hex")}@e2e.test`;

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function signUpAndIn(page: Page, email: string) {
  await page.goto("/sign-up");
  const form = page.getByRole("form", { name: "Sign-up form" });
  await form.getByLabel("Email address").fill(email);
  await form.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await form.getByLabel("Repeat the password").fill(PASSWORD);
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("the account is ready");
  await signIn(page, email);
}

test.describe.configure({ mode: "serial" });

test.describe("the LLM key of a workspace", () => {
  let llm: FakeLlm | undefined;
  // Set by the first journey, used by the second.
  let slug = "";
  let ownerEmail = "";

  test.beforeAll(async () => {
    llm = await startLlmFake({ port: e2eEnv.llmFakePort });
  });

  test.afterAll(async () => {
    await llm?.close();
  });

  function fake(): FakeLlm {
    if (llm === undefined) throw new Error("The fake LLM was not started.");
    return llm;
  }

  // #104-LK-13
  test("@smoke an Owner is told that the LLM is not configured, saves a key, tests it, and the key is nowhere on the page", async ({
    page,
  }) => {
    fake().reset();
    const requestedUrls: string[] = [];
    page.on("request", (request) => requestedUrls.push(request.url()));
    ownerEmail = address("llm-owner");
    await signUpAndIn(page, ownerEmail);
    await expect(page).toHaveURL(/\/no-access$/);
    const create = page.getByRole("form", { name: "Create a workspace" });
    await create.getByLabel("Name of the workspace").fill("LLM Team");
    await create.getByRole("button", { name: "Create workspace" }).click();
    await expect(page).toHaveURL(/\/w\/llm-team(-\d+)?\/projects$/);
    slug = new URL(page.url()).pathname.split("/")[2] ?? "";

    // Without a key the pages say so and link to the form.
    await expect(
      page.getByText("LLM not configured").filter({ visible: true }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "Add a key in the settings" })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/settings/llm$`));
    const form = page.getByRole("form", { name: "OpenRouter LLM key" });
    await expect(form).toBeVisible();
    await expect(form.getByRole("button", { name: "Test key" })).toBeDisabled();

    // Save: write-only, shown as set with the last four characters.
    await form.getByLabel("API key").fill(KEY);
    await form.getByRole("button", { name: "Save key" }).click();
    await expect(
      form.getByText(`A key is saved (ends in ${KEY.slice(-4)})`),
    ).toBeVisible();
    await expect(form.getByLabel("API key")).toHaveValue("");
    // (The page left behind stays in the document, hidden, with its own copy of the hint.)
    await expect(
      page.getByText("LLM not configured").filter({ visible: true }),
    ).toHaveCount(0);

    // The provider accepts it (the stored key is tested when the field is empty) ...
    fake().acceptKeys([KEY]);
    await form.getByRole("button", { name: "Test key" }).click();
    await expect(
      page.getByText("The provider accepted the key."),
    ).toBeVisible();
    expect(fake().keyChecks()).toEqual([`Bearer ${KEY}`]);

    // ... and then refuses it, even quoting it: the answer has the class of the failure and not the key.
    fake().acceptKeys([]);
    fake().quoteKeyInErrors(true);
    await form.getByRole("button", { name: "Test key" }).click();
    await expect(
      page.getByText(/provider did not accept this key/),
    ).toBeVisible();

    // A reload shows the same state, and the key is nowhere: not on the page, not in an address.
    await page.reload();
    await expect(
      form.getByText(`A key is saved (ends in ${KEY.slice(-4)})`),
    ).toBeVisible();
    expect(await page.content()).not.toContain(KEY);
    expect(await page.content()).not.toContain(KEY.slice(0, -4));
    for (const url of requestedUrls) expect(url).not.toContain(KEY);
    const read = await page.request.get(`/api/w/${slug}/llm-key`);
    expect(await read.text()).not.toContain(KEY.slice(0, -4));
  });

  // #104-LK-04, #104-LK-13
  test("a Member sees only whether reviews have a key and is refused when they try to change it", async ({
    browser,
    page,
  }) => {
    expect(slug, "the first journey makes the workspace").not.toBe("");
    const context = await browser.newContext({ baseURL: e2eEnv.multiAppUrl });
    const member = await context.newPage();
    const email = address("llm-member");
    await signUpAndIn(member, email);
    await expect(member).toHaveURL(/\/no-access$/);
    await joinWorkspace(member, { email }, "member", slug);

    await member.goto(`/w/${slug}/settings/llm`);
    await expect(
      member.getByRole("heading", { level: 1, name: "LLM access" }),
    ).toBeVisible();
    await expect(
      member.getByText("Reviews of this workspace have an LLM key."),
    ).toBeVisible();
    await expect(member.getByRole("form", { name: "LLM key" })).toHaveCount(0);
    await expect(member.getByLabel("API key")).toHaveCount(0);
    expect(await member.content()).not.toContain(KEY.slice(-4));

    // The server refuses what the page does not offer.
    const url = `/api/w/${slug}/llm-key`;
    for (const response of [
      await member.request.put(url, {
        data: { provider: "openrouter", apiKey: UNKNOWN_KEY },
      }),
      await member.request.delete(url),
      await member.request.post(`${url}/test`, { data: { apiKey: KEY } }),
    ]) {
      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
    const state = await member.request.get(url);
    expect(await state.json()).toEqual({
      canManage: false,
      key: { state: "configured" },
    });
    expect(fake().keyChecks()).not.toContain(`Bearer ${UNKNOWN_KEY}`);

    // The Owner removes the key: the Member's pages say so, with the link.
    await signIn(page, ownerEmail);
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/projects$`));
    const removed = await page.request.delete(url);
    expect(removed.status()).toBe(200);
    await member.goto(`/w/${slug}/projects`);
    await expect(
      member.getByText("LLM not configured").filter({ visible: true }),
    ).toBeVisible();
    await expect(member.getByText(/Ask an Admin or an Owner/)).toBeVisible();
    await context.close();
  });
});
