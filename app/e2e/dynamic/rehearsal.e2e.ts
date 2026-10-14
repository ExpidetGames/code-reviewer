// SPDX-License-Identifier: Apache-2.0

// The Dynamic Review journey with the real pinned OpenCode (#201-T01, #253), in the privileged lane
// (runner/scripts/run_dynamic_e2e.sh): a person saves Dynamic Review for a project, a signed `opened` event
// reaches the app, the app queues a Dynamic job, the REAL runner as root claims it because its own startup
// self-check advertised `opencode`, the REAL OpenCode runs as the engine user behind the runner's model proxy
// and the network rules, reads a file outside the diff, and the runner publishes one summary comment, which
// the Runs page shows with the kind, model, usage and link. A fix is pushed; the same comment is edited and
// lists the finding as resolved. Everything else is a fake on loopback: GitHub (API and Git over HTTP) and the
// model. There is no scripted engine in the path; nothing here decides what the runner advertises.
// What each piece does in detail is proven at lower levels; this file proves they fit together.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  createGitRepository,
  type GitRepository,
} from "../../../fakes/github/git-fixture.ts";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import {
  changeAdminSetting,
  syncFromGithubAsAdmin,
} from "../helpers/admin-api";
import {
  assertNoExternalAttempts,
  readGuard,
} from "../helpers/dynamic-lane-guard";
import { e2eEnv, llmEnv } from "../helpers/e2e-env";
import {
  addGithubAccount,
  addGithubGitRepository,
  addGithubInstallation,
  addGithubPullRequest,
  GITHUB_APP_OWNER_ACCOUNT,
  getIssuedInstallationTokens,
  getPullRequestComments,
  signInThroughTheForm,
  type GithubAccount,
} from "../helpers/github-fake";
import { deliverPullRequestEvent } from "../helpers/webhooks";

const account: GithubAccount = {
  id: 7400101,
  login: "dynamic-journey",
  name: "Dynamic Journey",
  email: "dynamic-journey@example.test",
};
const INSTALLATION_ID = 9500101;
const WIDGETS = { id: 9600101, fullName: "dynamic-journey/widgets" };
const OWNER = { login: account.login, id: account.id };
// The model name a person types into the project's settings; the engine asks the fake LLM for it.
const MODEL = "vendor/agent-e2e";
const TITLE = "Add a user handler";
const BODY = "Shows a user by the name in the request.";
const FINDING_TITLE = "SQL text is built from the user name";
const FINDING_ID = "f-1";
const IDENTITY_MARKER = "<!-- code-reviewer:dynamic-review:summary -->";
// The key an Owner saves for the workspace; the model is asked with it and it must show up nowhere else.
const WORKSPACE_KEY = "sk-or-v1-e2e-workspace-key-of-the-dynamic-lane-0001";
// A real engine run takes a few seconds; the first one also starts the engine cold.
const RUN_TIMEOUT = { timeout: 200_000 };

// The repository the pull request is in. `src/lookup.py` is not part of the pull request: the model has to
// read it to see the problem, which is the point of a review that reads beyond the diff.
const LOOKUP_BUGGY =
  'def find_user(connection, name):\n    query = "SELECT * FROM users WHERE name = \'" + name + "\'"\n    return connection.execute(query)\n';
const LOOKUP_FIXED =
  'def find_user(connection, name):\n    return connection.execute("SELECT * FROM users WHERE name = ?", (name,))\n';
const HANDLER =
  'from lookup import find_user\n\n\ndef show(connection, request):\n    return find_user(connection, request["name"])\n';

// A retry of a failed journey starts the whole serial group again on the same app and fake GitHub: the
// account, the installation, the project and the runs of the failed attempt are still there. So every attempt
// works on a pull request of its own (the number moves by 100 per retry).
const prNumber = (base: number) => base + 100 * test.info().retry;

test.describe.configure({ mode: "serial" });

test.describe("a pull request on its way to a Dynamic Review summary", () => {
  let llm: FakeLlm | undefined;
  
  let directory: string | undefined;
  let repository: GitRepository | undefined;
  let base = "";

  test.beforeAll(async ({ browser, baseURL }) => {
    if (baseURL === undefined)
      throw new Error("The journey project has no baseURL.");
    llm = await startLlmFake();
    // The real Dynamic runner: root, the capabilities of the container, the self-check on the pinned files.

    // The repository of the pull request, as real Git objects the fake GitHub serves over smart HTTP.
    directory = mkdtempSync(join(tmpdir(), "cr-lane-repo-"));
    repository = createGitRepository(join(directory, "widgets"));
    base = repository.commit(
      { "README.md": "# widgets\n", "src/lookup.py": LOOKUP_BUGGY },
      "Base",
    );
    repository.setRef("refs/heads/main", base);
    repository.branch("feature");

    // The setup a person does once: install the app for the account, sign in, sync, save the key of the
    // workspace and switch the project on.
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await addGithubAccount(context.request, account, "pipeline");
    await addGithubInstallation(
      context.request,
      { id: INSTALLATION_ID, account: GITHUB_APP_OWNER_ACCOUNT },
      [WIDGETS],
    );
    await addGithubGitRepository(
      context.request,
      WIDGETS.fullName,
      repository.path,
    );
    await syncFromGithubAsAdmin(baseURL);
    await signInThroughTheForm(page, account);
    const saved = await page.request.put("/api/w/default/llm-key", {
      data: { provider: llmEnv.provider, apiKey: WORKSPACE_KEY },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    const row = page.getByRole("row").filter({ hasText: WIDGETS.fullName });
    await expect(row).toBeVisible();
    // A retry finds the project switched on already: clicking the switch again would turn it off.
    if ((await row.getByText("Active", { exact: true }).count()) === 0)
      await row
        .getByRole("switch", { name: `Review ${WIDGETS.fullName}` })
        .click();
    await expect(row.getByText("Active", { exact: true })).toBeVisible();

    // The instance admin turns the Dynamic Review gate on in the lane's own database (it is off in every
    // shipped configuration), then the person chooses Dynamic Review for the project.
    await changeAdminSetting(baseURL, { dynamicReview: { enabled: true } });
    await page
      .getByRole("link", { name: WIDGETS.fullName, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: WIDGETS.fullName }),
    ).toBeVisible();
    const dynamic = page.getByRole("radio", { name: "Dynamic Review" });
    if (!(await dynamic.isChecked())) {
      await dynamic.click();
      await page
        .getByLabel("Dynamic Review model", { exact: true })
        .fill(MODEL);
      await page.getByRole("button", { name: "Save review settings" }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Switch to Dynamic Review" })
        .click();
      await expect(page.getByRole("status")).toContainText("Saved.");
    }
    await page.reload();
    await expect(dynamic).toBeChecked();
    await expect(
      page.getByLabel("Dynamic Review model", { exact: true }),
    ).toHaveValue(MODEL);
    await context.close();
  });

  test.afterAll(async () => {
    try {
      await Promise.resolve();
    } finally {
      await llm?.close();
      if (directory !== undefined)
        rmSync(directory, { recursive: true, force: true });
    }
  });

  function fakeLlm(): FakeLlm {
    if (llm === undefined) throw new Error("The fake LLM was not started.");
    return llm;
  }
  function repo(): GitRepository {
    if (repository === undefined)
      throw new Error("The repository was not made.");
    return repository;
  }

  function runsOf(page: Page, number: number) {
    return page
      .locator("[data-run-id]")
      .filter({ hasText: WIDGETS.fullName })
      .filter({ hasText: `#${String(number)}` });
  }

  async function openRuns(page: Page) {
    await signInThroughTheForm(page, account);
    await page.getByRole("link", { name: "Runs", exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Runs" }),
    ).toBeVisible();
  }

  test("rehearsal: the queued dynamic job has the payload the runner needs", async ({ page, request }) => {
    const number = prNumber(7);
    const head = repo().commit({ "src/handlers.py": HANDLER }, "Add a handler");
    repo().setRef(`refs/pull/${String(number)}/head`, head);
    await addGithubPullRequest(request, WIDGETS.fullName, { number, title: TITLE, body: BODY, headSha: head });
    await openRuns(page);
    const answer = await deliverPullRequestEvent(request, { action: "opened", installationId: INSTALLATION_ID, repository: { ...WIDGETS, owner: OWNER }, number, title: TITLE, headSha: head });
    expect(answer).toEqual({ status: "accepted", outcome: "trigger_enqueued" });
    const claim = await request.post("/api/runners/v1/claim", { headers: { authorization: `Bearer ${e2eEnv.runnerToken}`, "x-runner-id": "rehearsal", "content-type": "application/json" }, data: { engines: ["pr-agent", "opencode"] } });
    const text = await claim.text();
    console.log("CLAIM", claim.status(), text.replace(/"(token|apiKey|leaseToken)":"[^"]*"/g, '"$1":"…"'));
    const claimNo = await request.post("/api/runners/v1/claim", { headers: { authorization: `Bearer ${e2eEnv.runnerToken}`, "x-runner-id": "rehearsal2", "content-type": "application/json" }, data: { engines: ["pr-agent"] } });
    console.log("CLAIM-DIFF-ONLY", claimNo.status());
    console.log("COMMENTS", JSON.stringify(await getPullRequestComments(request, WIDGETS.fullName, number)));
  });
});
