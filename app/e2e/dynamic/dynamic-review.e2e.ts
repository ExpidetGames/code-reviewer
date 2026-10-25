// SPDX-License-Identifier: LicenseRef-Proprietary

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
  advertisementOf,
  startDynamicRunner,
  type DynamicRunner,
} from "../helpers/dynamic-runner";
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
import { chooseOption, openSection } from "../helpers/settings-form";
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
// A model of the list the project settings offer (#656); the engine asks the fake LLM for it.
const MODEL = "deepseek/deepseek-v4-pro";
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
  let runner: DynamicRunner | undefined;
  let directory: string | undefined;
  let repository: GitRepository | undefined;
  let base = "";

  test.beforeAll(async ({ browser, baseURL }) => {
    if (baseURL === undefined)
      throw new Error("The journey project has no baseURL.");
    // At the address the app asks for the metadata of the Dynamic model it saves (#269).
    llm = await startLlmFake({ port: e2eEnv.modelLlmFakePort });
    // The claim reads the same metadata (#279): the window and the prices reach the real runner as
    // the job's capabilities, next to the operator's descriptor it is narrowed by.
    llm.setModel(MODEL, [
      {
        supported_parameters: ["tools", "tool_choice"],
        context_length: 200_000,
        pricing: { prompt: "0.0000005", completion: "0.000002" },
      },
    ]);
    // The real Dynamic runner: root, the capabilities of the container, the self-check on the pinned files.
    runner = await startDynamicRunner({
      appUrl: baseURL,
      llmBaseUrl: llm.baseUrl,
    });
    await runner.waitForAdvertisement();

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
      await openSection(page, "LLM");
      await chooseOption(page, "Model", MODEL);
      await page.getByRole("button", { name: "Save review settings" }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Switch to Dynamic Review" })
        .click();
      await expect(page.getByRole("status")).toContainText("Saved.");
    }
    await page.reload();
    await expect(dynamic).toBeChecked();
    await openSection(page, "LLM");
    await expect(page.getByRole("combobox", { name: "Model" })).toHaveText(
      MODEL,
    );
    await context.close();
  });

  test.afterAll(async () => {
    try {
      await runner?.stop();
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
  function runnerOutput(): string {
    if (runner === undefined) throw new Error("The runner was not started.");
    return runner.output();
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

  // #253-L01
  test("the runner passed its startup self-check on its own merits and advertises opencode", () => {
    const output = runnerOutput();

    expect(advertisementOf(output)).toEqual({ state: "advertised" });
    expect(output).not.toContain("is not advertised");
    expect(output).not.toContain("cannot start");
  });

  // #201-T01
  test("@smoke a person opens a pull request and the real OpenCode reads beyond the diff; one summary, the Runs page shows kind, model, usage and link; a pushed fix edits the same comment and resolves the finding", async ({
    page,
    request,
  }) => {
    const number = prNumber(7);
    const head = repo().commit({ "src/handlers.py": HANDLER }, "Add a handler");
    repo().setRef(`refs/pull/${String(number)}/head`, head);

    // The model: reads the file the pull request does not touch, then reports the finding in it.
    fakeLlm().scriptAgent({
      steps: [[{ name: "read", arguments: { filePath: "src/lookup.py" } }]],
      final: {
        schemaVersion: 1,
        reviewedSha: head,
        resolvedIds: [],
        findings: [
          {
            id: FINDING_ID,
            priority: "P2",
            confidence: 0.8,
            title: FINDING_TITLE,
            body: "The SQL text is built by joining the name into it.",
            path: "src/lookup.py",
            lineStart: 2,
            lineEnd: 2,
            evidence: ["src/lookup.py:2"],
            reviewedSha: head,
          },
        ],
      },
    });
    await addGithubPullRequest(request, WIDGETS.fullName, {
      number,
      title: TITLE,
      body: BODY,
      headSha: head,
    });
    await openRuns(page);

    const answer = await deliverPullRequestEvent(request, {
      action: "opened",
      installationId: INSTALLATION_ID,
      repository: { ...WIDGETS, owner: OWNER },
      number,
      title: TITLE,
      headSha: head,
    });
    expect(answer).toEqual({ status: "accepted", outcome: "trigger_enqueued" });

    // The run is claimed by the Dynamic runner and ends as succeeded.
    const run = runsOf(page, number);
    await expect(run.locator("[data-status]")).toContainText(
      "Succeeded",
      RUN_TIMEOUT,
    );

    // One summary comment, written by the bot of the app, with the finding that is outside the diff.
    const [summary, ...others] = await getPullRequestComments(
      request,
      WIDGETS.fullName,
      number,
    );
    expect(others).toEqual([]);
    expect(summary?.login).toBe(e2eEnv.githubBotLogin);
    expect(summary?.revision).toBe(1);
    expect(summary?.body).toContain(IDENTITY_MARKER);
    expect(summary?.body).toContain("**1 active finding(s)**");
    expect(summary?.body).toContain(FINDING_TITLE);
    expect(summary?.body).toContain("src/lookup.py:2-2");

    // The real engine read the file outside the diff through its read tool, and the model saw its text.
    const first = fakeLlm().requests();
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(first.every((item) => item.model.includes(MODEL))).toBe(true);
    expect(
      first.every((item) => item.authorization === `Bearer ${WORKSPACE_KEY}`),
    ).toBe(true);
    expect(first[0]?.tools).toContain("read");
    expect(first[0]?.tools).toContain("StructuredOutput");
    expect(
      first.flatMap((item) => Object.values(item.toolResults)).join("\n"),
    ).toContain("def find_user(connection, name):");
    // The title and the description of the pull request reached the prompt (through the escaped, fenced
    // untrusted block), and the pull request's diff names the file it changes and not the one it reads.
    expect(first[0]?.prompt).toContain(TITLE);
    expect(first[0]?.prompt).toContain(BODY);
    expect(first[0]?.prompt).toContain("src/handlers.py");

    // The Runs page: the kind, the model the person chose, what the engine used, and the comment.
    await run
      .getByRole("link", { name: `${WIDGETS.fullName} #${String(number)}` })
      .click();
    const detail = page
      .locator('[data-slot="run-detail"]')
      .filter({ visible: true });
    await expect(
      detail.getByText("Dynamic Review", { exact: true }),
    ).toBeVisible();
    await expect(detail.locator('[data-slot="run-model"]')).toHaveText(MODEL);
    // The tokens and calls are no longer on the page (#657): the data route of the run still carries what the proxy summed.
    const runId = new URL(page.url()).pathname.split("/").pop() ?? "";
    const stored = (await (
      await page.request.get(`/api/w/default/runs/${runId}`)
    ).json()) as { run: { usage: { totalTokens: number; aiCalls: number } } };
    const { totalTokens: tokens, aiCalls: calls } = stored.run.usage;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(first.length);
    // The fake LLM reports 100 + 20 tokens for every answer; the data shows what the proxy summed.
    expect(tokens).toBe(120 * calls);
    // The Findings show what the review posted: the finding of the comment. The app reads the comment right after the run
    // ended and the page asks again until the text is there.
    await expect(
      detail.getByRole("region", { name: "Findings" }),
    ).toContainText(FINDING_TITLE, { timeout: 60_000 });
    await expect(
      detail.getByRole("link", { name: "Open the review on GitHub" }),
    ).toHaveAttribute("href", summary?.htmlUrl ?? "missing");
    expect(summary?.htmlUrl).toMatch(
      /^https:\/\/github\.com\/dynamic-journey\/widgets\/pull\/\d+#issuecomment-\d+$/,
    );
    await expect(
      detail.getByRole("link", { name: `#${String(number)} on GitHub` }),
    ).toHaveAttribute(
      "href",
      `https://github.com/${WIDGETS.fullName}/pull/${String(number)}`,
    );

    // The fix is pushed: the same comment is edited and shows the finding as resolved.
    const fixed = repo().commit(
      { "src/lookup.py": LOOKUP_FIXED },
      "Use a parameter",
    );
    repo().setRef(`refs/pull/${String(number)}/head`, fixed);
    fakeLlm().scriptAgent({
      steps: [[{ name: "read", arguments: { filePath: "src/lookup.py" } }]],
      final: {
        schemaVersion: 1,
        reviewedSha: fixed,
        resolvedIds: [FINDING_ID],
        findings: [],
      },
    });
    await addGithubPullRequest(request, WIDGETS.fullName, {
      number,
      title: TITLE,
      body: BODY,
      headSha: fixed,
    });
    await page.goto("/w/default/runs");
    const requestsBefore = fakeLlm().requests().length;

    const pushed = await deliverPullRequestEvent(request, {
      action: "synchronize",
      installationId: INSTALLATION_ID,
      repository: { ...WIDGETS, owner: OWNER },
      number,
      title: TITLE,
      headSha: fixed,
    });
    expect(pushed).toEqual({ status: "accepted", outcome: "trigger_enqueued" });

    const runs = runsOf(page, number);
    await expect(runs).toHaveCount(2, RUN_TIMEOUT);
    await expect(runs.nth(0).locator("[data-status]")).toContainText(
      "Succeeded",
      RUN_TIMEOUT,
    );
    await expect(runs.nth(1).locator("[data-status]")).toContainText(
      "Succeeded",
      RUN_TIMEOUT,
    );

    const [edited, ...rest] = await getPullRequestComments(
      request,
      WIDGETS.fullName,
      number,
    );
    expect(rest).toEqual([]);
    expect(edited?.id).toBe(summary?.id);
    expect(edited?.revision).toBe(2);
    expect(edited?.body).toContain(IDENTITY_MARKER);
    expect(edited?.body).toContain("**0 active finding(s)**");
    expect(edited?.body).toContain("No active findings.");
    expect(edited?.body).toContain("### Resolved findings (1)");
    expect(edited?.body).toContain(`~~${FINDING_TITLE}~~`);

    // The second review saw the first one's state: the finding it had to reassess is in its prompt.
    const second = fakeLlm().requests().slice(requestsBefore);
    expect(second[0]?.prompt).toContain(FINDING_TITLE);

    // Not a key or a token anywhere a person, a log or the model could read it.
    await expectNoCredentials(page, request, runnerOutput(), fakeLlm());
    // Nothing of the lane (OpenCode, Git, the runner, a helper) reached for anything but the fakes.
    assertNoExternalAttempts(readGuard());
  });

  // #299-T09
  test("a pull request whose checkout fails gets one short failure note in the summary comment, and the run keeps its failure", async ({
    page,
    request,
  }) => {
    const number = prNumber(8);
    // The pull request ref is never advertised for this head, so the real preparation refuses it
    // (`checkout_incomplete`, reason `ref_moved`) before any engine starts.
    const head = repo().commit(
      { "src/other.py": HANDLER },
      "A head without a ref",
    );
    await addGithubPullRequest(request, WIDGETS.fullName, {
      number,
      title: TITLE,
      body: BODY,
      headSha: head,
    });
    await openRuns(page);

    const answer = await deliverPullRequestEvent(request, {
      action: "opened",
      installationId: INSTALLATION_ID,
      repository: { ...WIDGETS, owner: OWNER },
      number,
      title: TITLE,
      headSha: head,
    });
    expect(answer).toEqual({ status: "accepted", outcome: "trigger_enqueued" });

    // The note is the only visible sign on the pull request, and the Runs view still says failed.
    await expect(runsOf(page, number).locator("[data-status]")).toContainText(
      "Failed",
      RUN_TIMEOUT,
    );
    const [note, ...others] = await getPullRequestComments(
      request,
      WIDGETS.fullName,
      number,
    );
    expect(others).toEqual([]);
    expect(note?.login).toBe(e2eEnv.githubBotLogin);
    expect(note?.body).toContain(IDENTITY_MARKER);
    expect(note?.body).toContain("Dynamic Review did not complete");
    expect(note?.body).toContain("`checkout_incomplete`");
    expect(note?.body).toContain("`ref_moved`");
    expect(note?.body).toContain(head);
    // Nothing of the repository, the pull request text or a credential is in the note.
    for (const text of [
      TITLE,
      BODY,
      "src/other.py",
      WORKSPACE_KEY,
      e2eEnv.runnerToken,
    ])
      expect(note?.body).not.toContain(text);
    assertNoExternalAttempts(readGuard());
  });
});

/** The keys and every installation token are nowhere in the page, the runner's output, the run data or the prompts. */
async function expectNoCredentials(
  page: Page,
  request: APIRequestContext,
  runnerOutput: string,
  llm: FakeLlm,
): Promise<void> {
  const tokens = await getIssuedInstallationTokens(request);
  expect(tokens.length).toBeGreaterThan(0);
  const secrets = [WORKSPACE_KEY, e2eEnv.runnerToken, ...tokens];
  const runs = await page.request.get("/api/w/default/runs");
  expect(runs.status()).toBe(200);
  const texts = {
    "the page": await page.content(),
    "the runs API": await runs.text(),
    "the runner output": runnerOutput,
    // What the model was shown. (It is asked with the key, in the header; the key is not in what it reads.)
    "what the model read": llm
      .requests()
      .map(
        (item) =>
          `${item.prompt}\n${Object.values(item.toolResults).join("\n")}`,
      )
      .join("\n"),
  };
  for (const [name, text] of Object.entries(texts))
    for (const secret of secrets)
      expect(text, `a credential is in ${name}`).not.toContain(secret);
}
