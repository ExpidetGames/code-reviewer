// SPDX-License-Identifier: Apache-2.0

// The billing journeys that need a review to run (#508), end to end on the fakes: a real browser, the app, the fake Stripe (`fakes/stripe`), the
// fake GitHub (webhooks in, pull request notices out) and a script that plays the runner over the runner API. The app is the one of the billing
// journeys of the admin portal (a single-tenant instance of its own), after them; its default workspace is the customer.
//   - The operator side is set up the way an operator does it: the operator's key and a model in the admin portal's data, billing on with
//     the Stripe adapter against the fake, rates, the webhook endpoint. The pages and the routes of billing themselves are proven by the
//     journeys that come before this one (#504-T16, #603-T18, #505-T03, T04, T09, T11, #496-T09); this one adds what only a review proves.
//   - The rates are made up (A = 5.0, Diff 0.013 and Dynamic 0.016 USD a started minute), the cost a run reports is chosen by the script,
//     so every price in these journeys is arithmetic on numbers written in this file.
//   - A run's minutes: the script has no VM, so a run is measured by its time on a runner and is one started minute.
//   - The journal invariant (#508-T10) is checked after every journey: the journal's own `verify()` finds no difference.
// Not in this journey: the Dynamic engine itself (it needs root, the privileged lane runs it), a real VM (the hosted lane), and the cases of the
// settlement that are proven at their own level with the whole matrix of outcomes (src/billing/settle-jobs.integration.test.ts and
// src/billing/journeys.integration.test.ts).
import { expect, test, type Page } from "@playwright/test";
import { changeAdminSetting } from "../helpers/admin-api";
import { verifyJournal, type JournalVerdict } from "../helpers/billing-journal";
import { seedCatalog, setCatalogDefaults } from "../helpers/catalog";
import { e2eEnv } from "../helpers/e2e-env";
import {
  addGithubInstallation,
  addGithubPullRequest,
  GITHUB_APP_OWNER_ACCOUNT,
  getPullRequestComments,
} from "../helpers/github-fake";
import {
  reviewRunnerScript,
  type HandedOutJob,
  type ReviewKind,
  type ReviewRunnerScript,
} from "../helpers/review-runner";
import { enterGithubApp } from "../helpers/setup";
import { syncFromGithubAsAdmin } from "../helpers/admin-api";
import {
  adminClient,
  deliverEvents,
  payFakeSession,
  refundFakePayment,
  switchBillingOff,
  switchBillingOnWithFakeStripe,
  switchBillingOnWithManualAdapter,
  type FakePayment,
} from "../helpers/stripe-fake";
import { deliverPullRequestEvent } from "../helpers/webhooks";

const REPOSITORY = { id: 9_300_508, fullName: "fake-owner/billing-journey" };
const INSTALLATION_ID = 9_400_508;
const OPERATOR_KEY = "sk-or-v1-e2e-billing-operator-key-0123456789abcdef-b508";
const OWN_KEY = "sk-or-v1-e2e-billing-own-key-0123456789abcdefabcd-o508";
const BILLING_PAGE = "/w/default/settings/billing";
// The first line every refusal notice starts with (src/copy/refusal-notice.ts).
const NOTICE_LEAD = "No review ran for this change.";

// The made-up rates of switchBillingOnWithFakeStripe, as micro-USD, and the prices the journeys expect from them.
const MICRO = 1_000_000;
const DIFF_MINUTE = 13_000;
const DYNAMIC_MINUTE = 16_000;
// A cost of USD 0.02 on our key is an AI price of 0.02 x 5.0 = USD 0.10, and one started minute of Diff is USD 0.013.
const DIFF_COST_USD = 0.02;
const DIFF_AI = 100_000;
const DIFF_PRICE = DIFF_AI + DIFF_MINUTE;
// A cost of USD 0.01 is an AI price of USD 0.05.
const DYNAMIC_COST_USD = 0.01;
const DYNAMIC_AI = 50_000;
const DYNAMIC_PRICE = DYNAMIC_AI + DYNAMIC_MINUTE;

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
  await page.getByLabel("Password").fill(e2eEnv.adminPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/default\/projects$/);
}

/** The balance on the page in micro-USD (`$1.887` is 1,887,000; `-$0.113` is -113,000). */
async function balanceMicro(page: Page): Promise<number> {
  const text = (
    await page.locator("[data-slot=balance-amount]").innerText()
  ).trim();
  const match = /^(-?)\$([\d,]+)\.(\d+)/.exec(text);
  if (match === null) throw new Error(`The balance reads ${text}.`);
  const micro =
    Number(match[2]?.replace(/,/g, "")) * MICRO +
    Number((match[3] ?? "").padEnd(6, "0"));
  return match[1] === "-" ? -micro : micro;
}

/** `1,887,000` as the page writes it: at least two decimals, at most four, no trailing zeros beyond two. */
function money(micro: number): string {
  const sign = micro < 0 ? "-" : "";
  const fourths = Math.round(Math.abs(micro) / 100);
  const whole = Math.floor(fourths / 10_000);
  const fraction = String(fourths % 10_000)
    .padStart(4, "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");
  return `${sign}$${whole.toLocaleString("en-US")}.${fraction}`;
}

/** A notice names no amount and no number: what is read is its words (the link's address and the hidden marker are not words). */
function expectNoNumber(notice: string): void {
  const words = notice
    .replace(/\(https?:\/\/[^)]*\)/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  expect(words).not.toMatch(/\d/);
  expect(words).not.toContain("$");
}

/** A top-up through the fake checkout: details and the business confirmation if the page asks, the buyer pays, the webhook credits. */
async function topUp(page: Page, dollars: 10 | 25): Promise<FakePayment> {
  await page.goto(BILLING_PAGE);
  const before = await balanceMicro(page);
  const pay = page.getByRole("button", { name: "Continue to payment" });
  if (await pay.isDisabled()) {
    await page.getByLabel("Legal name").fill("Acme Reviews GmbH");
    await page.getByLabel("Address", { exact: true }).fill("Hauptstrasse 1");
    await page.getByLabel("Postal code").fill("10115");
    await page.getByLabel("City").fill("Berlin");
    await page.getByLabel(/^Country/).fill("DE");
    await page.getByRole("button", { name: "Save billing details" }).click();
    await expect(page.getByText("Billing details saved.")).toBeVisible();
  }
  await page
    .getByRole("radio", { name: `$${String(dollars)}`, exact: true })
    .click();
  const confirmation = page.getByRole("checkbox", {
    name: /buying for a business/,
  });
  if ((await confirmation.count()) > 0) await confirmation.click();
  // The person never leaves the app's pages: the payment page is a stub, the buyer "pays" over the control API of the fake.
  await page.route(`${e2eEnv.stripeFakeUrl}/c/pay/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Fake checkout</title><h1>Fake checkout</h1>",
    }),
  );
  await pay.click();
  await page.waitForURL(/\/c\/pay\/cs_/);
  const session = /\/c\/pay\/(cs_[A-Za-z0-9_]+)/.exec(page.url())?.[1];
  if (session === undefined) throw new Error(`No session in ${page.url()}.`);
  const payment = await payFakeSession(session);
  await page.goto(`${BILLING_PAGE}?topup=success`);
  expect(await balanceMicro(page)).toBe(before);
  const delivered = await deliverEvents();
  expect(delivered.length).toBeGreaterThan(0);
  expect(delivered.every((status) => status === 200)).toBe(true);
  await expect(page.locator("[data-slot=balance-amount]")).toHaveText(
    money(before + dollars * MICRO),
    { timeout: 30_000 },
  );
  return payment;
}

test.describe.configure({ mode: "serial" });

test.describe("the billing journeys of a review", () => {
  let runner: ReviewRunnerScript | undefined;
  let headCounter = 0;
  // The Stripe payments the journeys made, by what they were for.
  const payments: Record<string, FakePayment> = {};

  function script(): ReviewRunnerScript {
    if (runner === undefined) throw new Error("The runner script is not up.");
    return runner;
  }

  /** The default workspace's id, as the admin portal lists it. */
  async function workspaceId(): Promise<string> {
    const admin = await adminClient(e2eEnv.catalogAdminAppUrl);
    try {
      const found = await admin.get("/api/admin/billing/workspaces?q=default");
      const body = (await found.json()) as {
        workspaces: Array<{ id: string; slug: string }>;
      };
      const workspace = body.workspaces.find((one) => one.slug === "default");
      if (workspace === undefined) throw new Error("No default workspace.");
      return workspace.id;
    } finally {
      await admin.dispose();
    }
  }

  /** Writes the operator's correction that brings the workspace's balance to `targetMicro` (what an operator does to settle an account). */
  async function setBalance(targetMicro: number): Promise<void> {
    const id = await workspaceId();
    const admin = await adminClient(e2eEnv.catalogAdminAppUrl);
    try {
      const read = await admin.get(`/api/admin/billing/workspaces/${id}`);
      const { balanceMicroUsd } = (await read.json()) as {
        balanceMicroUsd: number;
      };
      const difference = targetMicro - balanceMicroUsd;
      if (difference === 0) return;
      const written = await admin.post(
        `/api/admin/billing/workspaces/${id}/credit`,
        {
          data: {
            type: "correction",
            amountMicroUsd: difference,
            note: "E2E journey: a known starting balance",
            requestId: crypto.randomUUID(),
          },
        },
      );
      expect(written.status(), await written.text()).toBe(200);
    } finally {
      await admin.dispose();
    }
  }

  /** Opens or updates the pull request with a new head, the way a push does, and returns what the app made of the delivery. */
  async function push(
    request: Parameters<typeof deliverPullRequestEvent>[0],
  ): Promise<void> {
    headCounter += 1;
    const headSha = String(headCounter).padStart(40, "d");
    await addGithubPullRequest(request, REPOSITORY.fullName, {
      number: 1,
      title: "Billing journey change",
      headSha,
    });
    const answer = await deliverPullRequestEvent(request, {
      action: headCounter === 1 ? "opened" : "synchronize",
      installationId: INSTALLATION_ID,
      repository: {
        id: REPOSITORY.id,
        fullName: REPOSITORY.fullName,
        owner: {
          login: GITHUB_APP_OWNER_ACCOUNT.login,
          id: GITHUB_APP_OWNER_ACCOUNT.id,
        },
      },
      number: 1,
      title: "Billing journey change",
      headSha,
    });
    expect(answer).toEqual({ status: "accepted", outcome: "trigger_enqueued" });
  }

  /** A push, and the runner takes the job and reports a finished review with this cost. */
  async function review(
    request: Parameters<typeof deliverPullRequestEvent>[0],
    kind: ReviewKind,
    costUsd: number,
  ): Promise<HandedOutJob> {
    await push(request);
    const job = await script().claimOnce(kind);
    if (job === null) throw new Error("The claim handed out no job.");
    await script().succeed(job, costUsd);
    return job;
  }

  /** A push the claim refuses: the runner is handed nothing and the pull request gets one notice, whose text is returned. */
  async function refusedReview(
    request: Parameters<typeof deliverPullRequestEvent>[0],
    kind: ReviewKind,
  ): Promise<string> {
    const before = await notices(request);
    await push(request);
    expect(await script().claimOnce(kind)).toBeNull();
    await expect
      .poll(async () => (await notices(request)).length, { timeout: 30_000 })
      .toBe(before.length + 1);
    return (await notices(request)).at(-1) ?? "";
  }

  async function notices(
    request: Parameters<typeof deliverPullRequestEvent>[0],
  ): Promise<string[]> {
    return (await getPullRequestComments(request, REPOSITORY.fullName, 1))
      .map((comment) => comment.body)
      .filter((body) => body.includes(NOTICE_LEAD));
  }

  /** The Runs page row of a job. */
  async function runRow(page: Page, jobId: string) {
    await page.goto("/w/default/runs");
    const row = page.locator(`[data-run-id="${jobId}"]`);
    await expect(row).toBeVisible();
    return row;
  }

  /** The journal invariant (#508-T10): after a journey the journal's own check finds no difference and no stranded hold. */
  async function expectJournalConsistent(): Promise<JournalVerdict> {
    const verdict = await verifyJournal(e2eEnv.catalogAdminDatabasePath);
    expect(verdict.verification).toMatchObject({
      differenceMicroUsd: 0,
      reservedDifferenceMicroUsd: 0,
      strandedHoldCount: 0,
      consistent: true,
    });
    return verdict;
  }

  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    runner = await reviewRunnerScript(e2eEnv.catalogAdminAppUrl);
    // The App is entered in this app's admin portal like an operator does, so the webhooks, the installation token (the notices) and
    // the synchronization work against the fake GitHub.
    await enterGithubApp(e2eEnv.catalogAdminAppUrl);
    await changeAdminSetting(e2eEnv.catalogAdminAppUrl, {
      dynamicReview: { enabled: true },
    });
    // The installation is on the account of the App, so a single-tenant instance attaches it to its one workspace (the customer).
    await addGithubInstallation(
      request,
      { id: INSTALLATION_ID, account: GITHUB_APP_OWNER_ACCOUNT },
      [REPOSITORY],
    );
  });

  test.afterEach(async () => {
    // #508-T10
    await expectJournalConsistent();
  });

  test.afterAll(async () => {
    await runner?.dispose();
  });

  // #508-T01
  test("a new workspace with an installation gets the start credit and reviews on our key, Diff then Dynamic, and sees two prices each and a lower balance", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    // The operator: the key and a model of the catalog, which our models run on, in the admin portal; billing on against the fake Stripe.
    await signInAsAdmin(page);
    await page.goto("/admin/llm");
    const keyForm = page.getByRole("form", { name: "OpenRouter LLM key" });
    await keyForm.getByLabel("API key").fill(OPERATOR_KEY);
    await keyForm.getByRole("button", { name: "Save key" }).click();
    await expect(
      keyForm.getByText(`A key is saved, ending in ${OPERATOR_KEY.slice(-4)}.`),
    ).toBeVisible();
    const entries = await seedCatalog(e2eEnv.catalogAdminDatabasePath, [
      {
        name: "Journey model",
        modelId: "e2eproof/billing-journey-q7w8",
        kinds: ["diff", "dynamic"],
      },
    ]);
    const entryId = entries["Journey model"] ?? "";
    expect(entryId).not.toBe("");
    await setCatalogDefaults(e2eEnv.catalogAdminDatabasePath, {
      diff: entryId,
      dynamic: entryId,
    });
    await switchBillingOnWithFakeStripe(e2eEnv.catalogAdminAppUrl);
    await page.goto("/admin/billing");
    await expect(
      page.getByRole("heading", { name: "Billing is on" }),
    ).toBeVisible();

    // The customer starts from nothing, then the installation is known to the app: the workspace has a bound installation.
    await setBalance(0);
    await syncFromGithubAsAdmin(e2eEnv.catalogAdminAppUrl);
    await page.goto("/w/default/projects");
    const row = page.getByRole("row").filter({ hasText: REPOSITORY.fullName });
    await row
      .getByRole("switch", { name: `Review ${REPOSITORY.fullName}` })
      .click();
    await expect(row.getByText("Active", { exact: true })).toBeVisible();

    // The first contact grants the start credit once, and the journal says so.
    await page.goto(BILLING_PAGE);
    await expect(page.locator("[data-slot=balance-amount]")).toHaveText(
      "$2.00",
    );
    const journal = page.getByRole("region", { name: "Journal" });
    await expect(journal.getByText("Start credit")).toBeVisible();
    await expect(journal.getByText("+$2.00")).toBeVisible();
    const credit = await balanceMicro(page);
    expect(credit).toBe(2 * MICRO);

    // The balance is below the low threshold: the Owner is warned on the pages of the workspace, with the balance and the way to billing.
    await page.goto("/w/default/projects");
    const banner = page.locator("[data-slot=balance-banner]");
    await expect(banner).toContainText("Your balance is low");
    await expect(banner).toContainText("$2.00");
    await expect(
      banner.getByRole("link", { name: "Go to billing" }),
    ).toHaveAttribute("href", BILLING_PAGE);

    // A Diff review on our key: two prices on the run and in the journal, and the balance is the credit minus them.
    const diffJob = await review(request, "diff", DIFF_COST_USD);
    expect(diffJob.llm.apiKey).toBe(OPERATOR_KEY);
    const diffRow = await runRow(page, diffJob.id);
    await expect(diffRow.locator("[data-status]")).toContainText("Succeeded");
    const diffPrice = diffRow.locator("[data-slot=run-price]");
    await expect(diffPrice).toContainText(`AI ${money(DIFF_AI)}`);
    await expect(diffPrice).toContainText(
      `Infrastructure ${money(DIFF_MINUTE)}`,
    );
    await page.goto(BILLING_PAGE);
    expect(await balanceMicro(page)).toBe(credit - DIFF_PRICE);
    const charge = journal.locator("tr[data-entry-id]").filter({
      hasText: "Review",
    });
    await expect(charge).toHaveCount(1);
    await expect(charge.locator("[data-slot=run-price]")).toContainText(
      `AI ${money(DIFF_AI)}`,
    );
    await expect(charge).toContainText(`-${money(DIFF_PRICE)}`);

    // The project switches to Dynamic Review; the review that follows is priced with the Dynamic minute rate.
    await page.goto("/w/default/projects");
    await page
      .getByRole("link", { name: REPOSITORY.fullName, exact: true })
      .click();
    await page.getByRole("radio", { name: "Dynamic Review" }).click();
    await page.getByRole("button", { name: "Save review settings" }).click();
    await page
      .getByRole("alertdialog", { name: "Switch to Dynamic Review?" })
      .getByRole("button", { name: "Switch to Dynamic Review" })
      .click();
    await expect(page.getByRole("status")).toContainText("Saved.");

    const dynamicJob = await review(request, "dynamic", DYNAMIC_COST_USD);
    expect(dynamicJob.llm.apiKey).toBe(OPERATOR_KEY);
    const dynamicRow = await runRow(page, dynamicJob.id);
    const dynamicPrice = dynamicRow.locator("[data-slot=run-price]");
    await expect(dynamicPrice).toContainText(`AI ${money(DYNAMIC_AI)}`);
    await expect(dynamicPrice).toContainText(
      `Infrastructure ${money(DYNAMIC_MINUTE)}`,
    );
    await page.goto(BILLING_PAGE);
    expect(await balanceMicro(page)).toBe(credit - DIFF_PRICE - DYNAMIC_PRICE);
    await expect(
      journal.locator("tr[data-entry-id]").filter({ hasText: "Review" }),
    ).toHaveCount(2);

    // The customer never reads a factor, a minute count, the real cost of our key or the model of the catalog (a rate per minute is the
    // price of the one minute here, so it cannot be told from a price).
    const text = (await page.locator("body").innerText()).toLowerCase();
    for (const secret of ["factor", "e2eproof"])
      expect(text).not.toContain(secret);

    // Back to Diff Review for the journeys that follow.
    await page.goto("/w/default/projects");
    await page
      .getByRole("link", { name: REPOSITORY.fullName, exact: true })
      .click();
    await page.getByRole("radio", { name: "Diff Review" }).click();
    await page.getByRole("button", { name: "Save review settings" }).click();
    await page
      .getByRole("alertdialog", { name: "Switch to Diff Review?" })
      .getByRole("button", { name: "Switch to Diff Review" })
      .click();
    await expect(page.getByRole("status")).toContainText("Saved.");
  });

  // #508-T02
  test("a workspace without balance is refused with a pull request notice, tops up at the fake checkout, the webhook credits it and the next push is reviewed", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    await signInAsAdmin(page);
    await setBalance(0);

    // The push is refused at the claim: nobody is handed a job, the pull request gets one notice that names no amount.
    const notice = await refusedReview(request, "diff");
    expect(notice).toContain("no credit left");
    expect(notice).toContain("Add credit to continue");
    expect(notice).toContain(`${BILLING_PAGE}`);
    expectNoNumber(notice);

    // The Owner pays at the (fake) checkout and Stripe's signed event credits the workspace.
    // The Owner sees it at once: an alert on the pages of the workspace that leads to the billing page.
    await page.goto("/w/default/projects");
    const banner = page.locator("[data-slot=balance-banner]");
    await expect(banner).toContainText("No credit left");
    await banner.getByRole("link", { name: "Go to billing" }).click();
    await expect(page).toHaveURL(new RegExp(`${BILLING_PAGE}$`));
    payments["first"] = await topUp(page, 10);
    expect(await balanceMicro(page)).toBe(10 * MICRO);
    await page.goto("/w/default/projects");
    await expect(banner).toHaveCount(0);

    // The next push is reviewed and charged.
    const job = await review(request, "diff", DIFF_COST_USD);
    await page.goto(BILLING_PAGE);
    expect(await balanceMicro(page)).toBe(10 * MICRO - DIFF_PRICE);
    const row = await runRow(page, job.id);
    await expect(row.locator("[data-status]")).toContainText("Succeeded");
  });

  // #508-T05
  test("Stripe refunds consumed credit: the balance goes negative, reviews are refused, a top-up unblocks", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    await signInAsAdmin(page);
    const before = 10 * MICRO - DIFF_PRICE;
    const firstPayment = payments["first"] as FakePayment;
    expect(firstPayment).toBeDefined();

    // The whole payment is refunded although a review of it was used: the balance is below zero.
    await refundFakePayment(firstPayment);
    const delivered = await deliverEvents();
    expect(delivered.every((status) => status === 200)).toBe(true);
    await page.goto(BILLING_PAGE);
    await expect
      .poll(async () => balanceMicro(page).catch(() => 0), { timeout: 30_000 })
      .toBe(before - 10 * MICRO);
    await page.goto("/w/default/projects");
    const banner = page.locator("[data-slot=balance-banner]");
    await expect(banner).toContainText("The balance is below zero");
    await expect(banner).toContainText(money(before - 10 * MICRO));
    await page.goto(BILLING_PAGE);
    const journal = page.getByRole("region", { name: "Journal" });
    await expect(journal.getByText("Refund").first()).toBeVisible();

    // Reviews are refused, with a notice that says the balance is below zero and no amount.
    const notice = await refusedReview(request, "diff");
    expect(notice).toContain("below zero");
    expect(notice).toContain("Add credit to continue");
    expectNoNumber(notice);

    // A top-up unblocks: the balance is positive again and the next push is reviewed.
    payments["second"] = await topUp(page, 10);
    expect(await balanceMicro(page)).toBe(before);
    await page.goto("/w/default/projects");
    await expect(banner).toHaveCount(0);
    const job = await review(request, "diff", DIFF_COST_USD);
    await page.goto(BILLING_PAGE);
    expect(await balanceMicro(page)).toBe(before - DIFF_PRICE);
    const row = await runRow(page, job.id);
    await expect(row.locator("[data-status]")).toContainText("Succeeded");
  });

  // #508-T06
  test("the monthly total limit refuses a push once it is reached and stops refusing when it is removed, and the notice names no amount", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    await signInAsAdmin(page);
    await page.goto(BILLING_PAGE);
    const limit = page.getByRole("region", { name: "Monthly spending limit" });
    await limit.getByLabel(/^Monthly limit/).fill("1");
    await limit.getByRole("button", { name: "Save limit" }).click();
    await expect(limit.getByText("Limit saved.")).toBeVisible();

    // A review that costs more than the limit is allowed to start (a limit is only looked at at the claim) and runs to its end.
    const expensive = await review(request, "diff", 0.2);
    expect(expensive.id).not.toBe("");
    await page.goto(BILLING_PAGE);
    await expect(limit.getByText(/Charged this month so far/)).toBeVisible();

    // The next push is refused for the limit; the notice names neither the limit nor the amounts.
    const notice = await refusedReview(request, "diff");
    expect(notice).toContain("monthly spending limit");
    expectNoNumber(notice);

    // The limit is removed and the next push is reviewed.
    await page.goto(BILLING_PAGE);
    await limit.getByLabel(/^Monthly limit/).fill("");
    await limit.getByRole("button", { name: "Save limit" }).click();
    await expect(limit.getByText("Limit removed.")).toBeVisible();
    const job = await review(request, "diff", DIFF_COST_USD);
    const row = await runRow(page, job.id);
    await expect(row.locator("[data-status]")).toContainText("Succeeded");
  });

  // #508-T03
  test("a workspace on its own key pays infrastructure only", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    await signInAsAdmin(page);
    // The Owner saves a key and chooses it, as the key mode journey does.
    await page.goto("/w/default/settings/llm");
    const form = page.getByRole("form", { name: "OpenRouter LLM key" });
    await form.getByLabel("API key").fill(OWN_KEY);
    await form.getByRole("button", { name: "Save key" }).click();
    await expect(
      form.getByText(`A key is saved (ends in ${OWN_KEY.slice(-4)})`),
    ).toBeVisible();
    const card = page.getByRole("region", { name: "Which key reviews use" });
    await card.getByRole("radio", { name: /Use my own provider key/ }).click();
    await card.getByRole("button", { name: "Save choice" }).click();
    await expect(card.getByText("The choice is saved.")).toBeVisible();

    await page.goto(BILLING_PAGE);
    const before = await balanceMicro(page);
    const job = await review(request, "diff", DIFF_COST_USD);
    expect(job.llm.apiKey).toBe(OWN_KEY);

    // One price on the run: the infrastructure. The balance falls by the minute only.
    const row = await runRow(page, job.id);
    await expect(row.locator("[data-slot=run-price]")).toContainText(
      `Infrastructure ${money(DIFF_MINUTE)}`,
    );
    await expect(row.locator("[data-slot=run-price]")).not.toContainText("AI");
    await page.goto(BILLING_PAGE);
    expect(await balanceMicro(page)).toBe(before - DIFF_MINUTE);
    expect(await page.content()).not.toContain(OWN_KEY);

    // Back to our models.
    await page.goto("/w/default/settings/llm");
    await card.getByRole("radio", { name: /Use our models/ }).click();
    await card.getByRole("button", { name: "Save choice" }).click();
    await expect(card.getByText("The choice is saved.")).toBeVisible();
  });

  // #508-T07
  test("with billing off a review is unchanged, nothing is charged and no billing route answers; switching on again keeps the balance and the journal (#508-T09)", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    await signInAsAdmin(page);
    await page.goto(BILLING_PAGE);
    const balance = await balanceMicro(page);
    const rowsBefore = await page
      .getByRole("region", { name: "Journal" })
      .locator("tr[data-entry-id]")
      .count();
    const verdictBefore = await expectJournalConsistent();

    await switchBillingOff(e2eEnv.catalogAdminAppUrl);

    // The review runs on the workspace's own key as before billing existed and has no price.
    const job = await review(request, "diff", DIFF_COST_USD);
    expect(job.llm.apiKey).toBe(OWN_KEY);
    const row = await runRow(page, job.id);
    await expect(row.locator("[data-status]")).toContainText("Succeeded");
    await expect(row.locator("[data-slot=run-price]")).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Price" })).toHaveCount(
      0,
    );
    // The page and the routes of billing are paths that do not exist.
    await page.goto(BILLING_PAGE);
    await expect(page.getByText("This page could not be found.")).toBeVisible();
    for (const path of ["journal", "profile", "monthly-limit"])
      expect(
        (await page.request.get(`/api/w/default/billing/${path}`)).status(),
        path,
      ).toBe(404);
    // Nothing was written to the journal.
    const verdictOff = await expectJournalConsistent();
    expect(verdictOff.entries).toEqual(verdictBefore.entries);
    expect(verdictOff.verification.balanceMicroUsd).toBe(balance);

    // #508-T09: switched on again, the balance and the journal are what they were, and the run made while it was off was not charged.
    await switchBillingOnWithFakeStripe(e2eEnv.catalogAdminAppUrl);
    await page.goto(BILLING_PAGE);
    expect(await balanceMicro(page)).toBe(balance);
    await expect(
      page
        .getByRole("region", { name: "Journal" })
        .locator("tr[data-entry-id]"),
    ).toHaveCount(rowsBefore);
  });

  // #508-T08
  test("on the manual adapter the operator grants credit in the admin portal, the workspace reviews and the balance falls", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    await signInAsAdmin(page);
    await switchBillingOnWithManualAdapter(e2eEnv.catalogAdminAppUrl);
    await setBalance(0);
    const refusal = await refusedReview(request, "diff");
    expect(refusal).toContain("no credit left");

    // The workspace has no way to pay on this adapter: it is told to ask the operator.
    await page.goto(BILLING_PAGE);
    await expect(
      page.getByText(/Ask your operator to add credit/),
    ).toBeVisible();

    // The operator grants credit on the admin page.
    await page.goto("/admin/billing");
    await page.getByLabel("Search workspaces", { exact: true }).fill("default");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: /Default workspace/ }).click();
    await page.getByLabel("Amount (USD)", { exact: true }).fill("5");
    await page.getByLabel("Note", { exact: true }).fill("Pilot customer");
    await page.getByRole("button", { name: "Write credit" }).click();
    await expect(
      page.getByText("The credit is written to the journal."),
    ).toBeVisible();

    // The workspace sees the credit, reviews, and the balance falls by the price.
    await page.goto(BILLING_PAGE);
    expect(await balanceMicro(page)).toBe(5 * MICRO);
    const job = await review(request, "diff", DIFF_COST_USD);
    await page.goto(BILLING_PAGE);
    expect(await balanceMicro(page)).toBe(5 * MICRO - DIFF_PRICE);
    const row = await runRow(page, job.id);
    await expect(row.locator("[data-slot=run-price]")).toContainText(
      `AI ${money(DIFF_AI)}`,
    );
  });
});
