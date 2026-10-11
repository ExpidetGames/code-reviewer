// Pins down the Runs pages in a real browser, against a production build next to the fake GitHub: a
// pull request opened at GitHub reaches the app through a signed delivery, the run shows up on the
// open Runs page without a reload as waiting, then running, then succeeded, and its page links the
// review comment. A second journey tells runs of two projects apart with the filter, and reads the
// plain-language reason of a failed run. A runner is stood in for by the job queue itself (claim,
// complete), because the runner is a separate program with its own tests; the details of each piece
// (copy, rules for links and logs, polling) are proven as component and integration tests.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";
import {
  addGithubAccount,
  addGithubInstallation,
  signInThroughTheForm,
  type GithubAccount,
} from "../helpers/github-fake";
import {
  claimNextRun,
  completeRun,
  enqueueManualRun,
} from "../helpers/job-queue";

const account: GithubAccount = {
  id: 7300003,
  login: "runs-journey",
  name: "Runs Journey",
  email: "runs-journey@example.test",
};
const INSTALLATION_ID = 9300001;
const WIDGETS = { id: 9400001, fullName: "runs-journey/widgets" };
const GADGETS = { id: 9400002, fullName: "runs-journey/gadgets" };
const COMMENT_URL = `https://github.com/${WIDGETS.fullName}/pull/7#issuecomment-4242`;
// Waiting runs appear on a page that was opened before them within the idle polling interval.
const POLL_WAIT = { timeout: 20_000 };

// The runs are shared by the journeys after the first one.
test.describe.configure({ mode: "serial" });

test.describe("the runs pages", () => {
  test.beforeAll(async ({ request }) => {
    await addGithubAccount(request, account);
    await addGithubInstallation(
      request,
      {
        id: INSTALLATION_ID,
        account: { login: account.login, id: account.id, type: "User" },
      },
      [WIDGETS, GADGETS],
    );
  });

  /** What GitHub sends when somebody opens pull request 7 of the widgets repository. */
  async function openPullRequest(
    request: import("@playwright/test").APIRequestContext,
  ) {
    const headSha = "7".repeat(40);
    await request.post(`${e2eEnv.githubUrl}/__fake/pull-requests`, {
      data: {
        repository: WIDGETS.fullName,
        pullRequest: {
          number: 7,
          title: "Add widget caching",
          state: "open",
          headSha,
          headRef: "feature/caching",
          baseRef: "main",
          author: { login: "alice", id: 1001 },
        },
      },
    });
    // The payloads of fakes/fixtures are reduced to the fields the app reads; this one is patched to
    // name this journey's installation, repository and pull request.
    const payload = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "../fakes/fixtures/github-webhooks/pull_request.opened.json",
        ),
        "utf8",
      ),
    ) as Record<
      string,
      any // eslint-disable-line @typescript-eslint/no-explicit-any -- a fixture patched in place
    >;
    payload.installation.id = INSTALLATION_ID;
    payload.repository = {
      ...payload.repository,
      id: WIDGETS.id,
      name: "widgets",
      full_name: WIDGETS.fullName,
      html_url: `https://github.com/${WIDGETS.fullName}`,
      owner: { login: account.login, id: account.id, type: "User" },
    };
    payload.pull_request.html_url = `https://github.com/${WIDGETS.fullName}/pull/7`;
    payload.pull_request.head = {
      ...payload.pull_request.head,
      sha: headSha,
      repo: { id: WIDGETS.id, full_name: WIDGETS.fullName },
    };
    payload.pull_request.base = {
      ...payload.pull_request.base,
      repo: { id: WIDGETS.id, full_name: WIDGETS.fullName },
    };
    const body = JSON.stringify(payload);
    const response = await request.post("/api/webhooks/github-app", {
      data: body,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "11111111-2222-4333-8444-555555555555",
        "x-hub-signature-256": `sha256=${createHmac("sha256", e2eEnv.githubAppWebhookSecret).update(body).digest("hex")}`,
      },
    });
    expect(response.status()).toBe(202);
    expect(await response.json()).toEqual({
      status: "accepted",
      outcome: "trigger_enqueued",
    });
  }

  // CR-35-T17
  test("@smoke a person watches a run go from waiting to running to succeeded without reloading, and opens its page", async ({
    page,
    request,
  }) => {
    await signInThroughTheForm(page, account);
    await page.getByRole("button", { name: "Sync from GitHub" }).click();
    const row = page
      .getByRole("listitem")
      .filter({ hasText: WIDGETS.fullName });
    await row
      .getByRole("switch", { name: `Review ${WIDGETS.fullName}` })
      .click();
    await expect(row.getByText("Active", { exact: true })).toBeVisible();
    await expect(row.getByText("No run yet")).toBeVisible();

    await page.getByRole("link", { name: "Runs", exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Runs" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("heading", { level: 2, name: "No runs yet" })
        .filter({ visible: true }),
    ).toBeVisible();

    await openPullRequest(request);

    const run = page
      .getByRole("listitem")
      .filter({ hasText: `${WIDGETS.fullName} #7` });
    await expect(run.locator(".badge-run")).toContainText("Waiting", POLL_WAIT);
    await expect(run).toContainText("Automatic");
    await expect(
      page.getByRole("heading", { name: "No runs yet" }),
    ).toHaveCount(0);

    const claim = await claimNextRun();
    await expect(run.locator(".badge-run")).toContainText("Running", POLL_WAIT);

    await completeRun(claim, {
      ok: true,
      result: {
        ok: true,
        durationMs: 61000,
        commentUrl: COMMENT_URL,
        errorCode: null,
        logTail: "reviewed 3 files\nposted the review",
        logTruncated: false,
      },
    });
    await expect(run.locator(".badge-run")).toContainText(
      "Succeeded",
      POLL_WAIT,
    );

    await run.getByRole("link", { name: `${WIDGETS.fullName} #7` }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: `${WIDGETS.fullName} #7` }),
    ).toBeVisible();
    const comment = page.getByRole("link", {
      name: "Open the comment on GitHub",
    });
    await expect(comment).toHaveAttribute("href", COMMENT_URL);
    await expect(comment).toHaveAttribute("rel", /noopener/);
    await expect(page.getByText("posted the review")).toBeVisible();
    await expect(page.getByText("Automatic", { exact: true })).toBeVisible();

    // The Projects page shows the status of the same run as the last run of the repository.
    await page.getByRole("link", { name: "Projects", exact: true }).click();
    const project = page
      .getByRole("listitem")
      .filter({ hasText: WIDGETS.fullName })
      .filter({ visible: true });
    await expect(project.getByText(/Last run: Succeeded/)).toBeVisible();
    await project.getByRole("link", { name: "All runs" }).click();
    await expect(page).toHaveURL(/\/runs\?repository=/);
    await expect(
      page.getByRole("listitem").filter({ hasText: `${WIDGETS.fullName} #7` }),
    ).toBeVisible();
  });

  // CR-35-T02, CR-35-T04, CR-35-T08
  test("a person narrows the runs by project and status and reads in plain words why a run failed", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);
    // The filter offers the repositories that are projects: switch the second one on too.
    const gadgets = page
      .getByRole("listitem")
      .filter({ hasText: GADGETS.fullName });
    await gadgets
      .getByRole("switch", { name: `Review ${GADGETS.fullName}` })
      .click();
    await expect(gadgets.getByText("Active", { exact: true })).toBeVisible();
    const failedClaimGadgets = async () => {
      await enqueueManualRun({
        repository: GADGETS.fullName,
        prNumber: 21,
        actorLogin: account.login,
      });
      const claim = await claimNextRun();
      await completeRun(claim, {
        ok: false,
        errorCode: "llm_quota",
        result: {
          ok: false,
          durationMs: 5000,
          commentUrl: null,
          errorCode: "llm_quota",
          logTail: "402 from the provider",
          logTruncated: true,
        },
      });
    };
    await failedClaimGadgets();
    await enqueueManualRun({
      repository: GADGETS.fullName,
      prNumber: 22,
      actorLogin: account.login,
    });

    await page.goto("/runs");
    const runs = page
      .getByRole("list", { name: "Runs" })
      .filter({ visible: true });
    await expect(runs.getByRole("listitem")).toHaveCount(3);

    await page.getByLabel("Project").selectOption({ label: GADGETS.fullName });
    await page.getByRole("button", { name: "Apply filter" }).click();
    await expect(page).toHaveURL(/repository=/);
    await expect(runs.getByRole("listitem")).toHaveCount(2);

    await page.getByLabel("Status").selectOption({ label: "Failed" });
    await page.getByRole("button", { name: "Apply filter" }).click();
    await expect(page).toHaveURL(/status=failed/);
    await expect(runs.getByRole("listitem")).toHaveCount(1);
    await expect(runs).toContainText(`${GADGETS.fullName} #21`);

    await page.getByLabel("Status").selectOption({ label: "Running" });
    await page.getByRole("button", { name: "Apply filter" }).click();
    await expect(
      page.getByRole("heading", { name: "No runs for this filter" }),
    ).toBeVisible();
    await page
      .getByRole("main")
      .getByRole("link", { name: "Reset filter" })
      .first()
      .click();
    await expect(runs.getByRole("listitem")).toHaveCount(3);
    // The selects follow the reset, they do not keep the old choice.
    await expect(page.getByLabel("Project")).toHaveValue("");
    await expect(page.getByLabel("Status")).toHaveValue("");

    // Back returns to the page before the reset, selects and list together.
    await page.goBack();
    await expect(page.getByLabel("Status")).toHaveValue("running");
    await expect(
      page.getByRole("heading", { name: "No runs for this filter" }),
    ).toBeVisible();
    await page.goForward();
    await expect(page.getByLabel("Status")).toHaveValue("");
    await expect(runs.getByRole("listitem")).toHaveCount(3);

    await runs.getByRole("link", { name: `${GADGETS.fullName} #21` }).click();
    // Wait for the run page first. Right after the click the URL is already the run's, but the old
    // list is still in the document, and its row carries the same sentence as the page, so a text
    // query made in that moment finds two elements. The sentence of the page sits in its details
    // list, which the rows do not have.
    await expect(
      page.getByRole("heading", { level: 1, name: `${GADGETS.fullName} #21` }),
    ).toBeVisible();
    await expect(
      page
        .locator("dd")
        .getByText("The AI provider says the credit or quota is used up."),
    ).toBeVisible();
    await expect(page.getByText("llm_quota")).toBeVisible();
    await expect(
      page.getByText("Started by runs-journey", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("The log was shortened")).toBeVisible();
    await expect(page.getByText("402 from the provider")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open the comment on GitHub" }),
    ).toHaveCount(0);
  });

  // CR-35-T05, CR-35-T16
  test("an unknown run shows the not-found page, and the data routes turn a visitor without a session away", async ({
    page,
    request,
  }) => {
    await signInThroughTheForm(page, account);

    await page.goto("/runs/00000000-0000-4000-8000-000000000000");
    await expect(
      page.getByText(/could not be found|not found/i).first(),
    ).toBeVisible();
    await expect(page.getByText(WIDGETS.fullName)).toHaveCount(0);

    const list = await request.get("/api/runs", { maxRedirects: 0 });
    const one = await request.get(
      "/api/runs/00000000-0000-4000-8000-000000000000",
      {
        maxRedirects: 0,
      },
    );
    expect(list.status()).toBe(401);
    expect(one.status()).toBe(401);
    expect(await list.text()).not.toContain(WIDGETS.fullName);
  });

  test.describe("on a narrow window", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("the run list and a run page do not scroll sideways", async ({
      page,
    }) => {
      await signInThroughTheForm(page, account);
      await page.goto("/runs");
      await expect(
        page.getByRole("list", { name: "Runs" }).getByRole("listitem").first(),
      ).toBeVisible();
      const overflow = () =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
      expect(await overflow()).toBeLessThanOrEqual(0);

      await page
        .getByRole("list", { name: "Runs" })
        .getByRole("link")
        .first()
        .click();
      await expect(page.getByRole("heading", { name: "Log" })).toBeVisible();

      expect(await overflow()).toBeLessThanOrEqual(0);
    });
  });
});
