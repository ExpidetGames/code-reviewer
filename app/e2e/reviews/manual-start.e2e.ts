// SPDX-License-Identifier: Apache-2.0

// Pins down starting a review by hand in a real browser, against a production build next to the
// fake GitHub: a person opens the project, picks an open pull request and the command and presses
// "Review now"; the run shows up on the Runs page as started by them and, once a runner (stood in
// for by the job queue itself, because the runner is a separate program with its own tests) is done,
// as succeeded. A second journey covers what goes wrong on the way: an `ask` without a question, a
// pull request that was closed after the list was shown, and the same review started twice. The
// details of each piece (copy, rules, refusals) are proven as component and integration tests.
import { expect, test } from "@playwright/test";
import {
  addGithubAccount,
  addGithubInstallation,
  addGithubPullRequest,
  signInThroughTheForm,
  type GithubAccount,
} from "../helpers/github-fake";
import { claimRun, completeRun } from "../helpers/job-queue";

const account: GithubAccount = {
  id: 7400001,
  login: "manual-journey",
  name: "Manual Journey",
  email: "manual-journey@example.test",
};
const INSTALLATION_ID = 9500001;
const WIDGETS = { id: 9600001, fullName: "manual-journey/widgets" };
// The Runs page learns about runs within its polling interval.
const POLL_WAIT = { timeout: 20_000 };

test.describe.configure({ mode: "serial" });

test.describe("starting a review by hand", () => {
  test.beforeAll(async ({ request }) => {
    await addGithubAccount(request, account);
    await addGithubInstallation(
      request,
      {
        id: INSTALLATION_ID,
        account: { login: account.login, id: account.id, type: "User" },
      },
      [WIDGETS],
    );
    await addGithubPullRequest(request, WIDGETS.fullName, {
      number: 12,
      title: "Add widget caching",
    });
    await addGithubPullRequest(request, WIDGETS.fullName, {
      number: 13,
      title: "Work in progress",
      draft: true,
    });
    await addGithubPullRequest(request, WIDGETS.fullName, {
      number: 14,
      title: "Old experiment",
      state: "closed",
    });
  });

  /** Signs in, syncs, switches the repository on and opens its project page. */
  async function openProject(page: import("@playwright/test").Page) {
    await signInThroughTheForm(page, account);
    await page.getByRole("button", { name: "Sync from GitHub" }).click();
    const row = page
      .getByRole("listitem")
      .filter({ hasText: WIDGETS.fullName });
    await row
      .getByRole("switch", { name: `Review ${WIDGETS.fullName}` })
      .click();
    await expect(row.getByText("Active", { exact: true })).toBeVisible();
    await page
      .getByRole("link", { name: WIDGETS.fullName, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: WIDGETS.fullName }),
    ).toBeVisible();
  }

  // CR-33-T16
  test("@smoke a person picks an open pull request and the review command, starts it, and finds the run as started by them until it succeeds", async ({
    page,
  }) => {
    await openProject(page);

    // Exactly the open pull requests are offered, drafts included.
    await expect(
      page.getByRole("radio", { name: /#12 Add widget caching/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("radio", { name: /#13 Work in progress/ }),
    ).toBeVisible();
    await expect(page.getByRole("radio", { name: /#14/ })).toHaveCount(0);
    const start = page.getByRole("button", { name: "Review now" });
    await expect(start).toBeDisabled();

    await page.getByRole("radio", { name: /#12 Add widget caching/ }).check();
    await expect(page.getByLabel("Command to run")).toHaveValue("review");
    await start.click();

    const notice = page.getByRole("status");
    await expect(notice).toContainText("Started: review for pull request #12");
    await notice.getByRole("link", { name: "View the run" }).click();
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: `${WIDGETS.fullName} #12`,
      }),
    ).toBeVisible();
    const runId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
    await expect(page.getByText("Started by manual-journey")).toBeVisible();

    await page.getByRole("link", { name: "Runs", exact: true }).click();
    const run = page
      .getByRole("listitem")
      .filter({ hasText: `${WIDGETS.fullName} #12` });
    await expect(run.locator(".badge-run")).toContainText("Waiting", POLL_WAIT);
    await expect(run).toContainText("Started by manual-journey");

    const claim = await claimRun(runId);
    await completeRun(claim, {
      ok: true,
      result: {
        ok: true,
        durationMs: 61000,
        commentUrl: `https://github.com/${WIDGETS.fullName}/pull/12#issuecomment-1`,
        errorCode: null,
        logTail: "posted the review",
        logTruncated: false,
      },
    });
    await expect(run.locator(".badge-run")).toContainText(
      "Succeeded",
      POLL_WAIT,
    );
  });

  // CR-33-T06, CR-33-T09, CR-33-T10
  test("a person is told when the question is missing, when the pull request was closed meanwhile and when the same review is already there", async ({
    page,
    request,
  }) => {
    await signInThroughTheForm(page, account);
    await page.getByRole("link", { name: "Projects", exact: true }).click();
    await page
      .getByRole("link", { name: WIDGETS.fullName, exact: true })
      .click();
    await page.getByRole("radio", { name: /#13 Work in progress/ }).check();

    // An ask needs a question.
    await page.getByLabel("Command to run").selectOption("ask");
    await page.getByRole("button", { name: "Review now" }).click();
    await expect(
      page.getByText("Write the question you want answered"),
    ).toBeVisible();
    await page.getByLabel("Question").fill("What does the cache key contain?");
    await page.getByRole("button", { name: "Review now" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Started: ask for pull request #13",
    );

    // The same command for the same pull request again is the run that is already there.
    await page.getByRole("button", { name: "Review now" }).click();
    await expect(page.getByRole("status")).toContainText(
      "already waiting or running",
    );

    // Closed at GitHub after the list was shown: refused, and the list loses it.
    await page.getByLabel("Command to run").selectOption("describe");
    await addGithubPullRequest(request, WIDGETS.fullName, {
      number: 13,
      title: "Work in progress",
      state: "closed",
    });
    await page.getByRole("button", { name: "Review now" }).click();
    await expect(page.getByText(/closed or merged/)).toBeVisible();
    await expect(
      page.getByRole("radio", { name: /#13 Work in progress/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Review now" }),
    ).toBeDisabled();
  });
});
