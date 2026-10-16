// SPDX-License-Identifier: Apache-2.0

// The whole chain an operator relies on, on the real app (#285, the last issue of #268): a workspace with limits on an
// instance whose operator API is on runs, is refused, is told so on its pull request, is reset from outside, can be
// read in the usage feed, and never sees which model backs its quality level, while a workspace on its own key on the
// same instance is untouched. Nothing in the path is replaced but the outside world: the fake GitHub, the fake LLM,
// and a script (`helpers/operator-api.ts`) that plays the external service over the operator API. The real runner
// (the job loop and the real PR-Agent) claims the jobs, so the claim, the key mode, the tier model, the usage records
// and the refusals all run as in production.
//
// The instance is the seventh app of the run (playwright.config.ts): multi-tenant, `OPERATOR_API_TOKEN` set, the
// model metadata at the journey's fake LLM. It has two workspaces, each with its own GitHub installation:
//   A  the limited workspace: it takes the default entitlements (the operator's key, two Diff runs per period);
//   B  a workspace on its own key, with an entitlement row of its own that states no limit.
// The plain counterpart (an instance that never switched any of this on) is e2e/operator/plain-instance.e2e.ts.
//
// The case ids are those of #285. The Quality choice (T10) and the plan page's states (T11) are cases of the
// follow-ups the earlier pull requests of the epic named; they are proven here and nowhere else at this level.
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import { changeAdminSetting } from "../helpers/admin-api";
import { e2eEnv, llmEnv } from "../helpers/e2e-env";
import {
  addGithubAccount,
  addGithubInstallation,
  addGithubOrgMember,
  addGithubPullRequest,
  getPullRequestComments,
  joinWorkspace,
  setGithubAppSetupUrl,
  type GithubAccount,
  type GithubComment,
} from "../helpers/github-fake";
import {
  connectGithub,
  founder,
  signUpAndIn,
  switchRepositoryOn,
} from "../helpers/multi-tenant";
import {
  operatorClient,
  type OperatorClient,
  type UsageItem,
} from "../helpers/operator-api";
import { startRunner, type RunnerProcess } from "../helpers/runner-process";
import { deliverPullRequestEvent } from "../helpers/webhooks";

// Workspace A, the limited one, and workspace B, on its own key. Each owns its account, organization, installation
// and repository (ids no other journey uses).
const ownerA: GithubAccount = {
  id: 7700001,
  login: "limits-owner-a",
  name: "Limits Owner A",
  email: "limits-owner-a@example.test",
};
const ownerB: GithubAccount = {
  id: 7700002,
  login: "limits-owner-b",
  name: "Limits Owner B",
  email: "limits-owner-b@example.test",
};
const ORG_A = {
  login: "limits-org-a",
  id: 7800001,
  type: "Organization",
} as const;
const ORG_B = {
  login: "limits-org-b",
  id: 7800002,
  type: "Organization",
} as const;
const INSTALLATION_A = 9800001;
const INSTALLATION_B = 9800002;
const REPO_A = { id: 9810001, fullName: "limits-org-a/widgets" };
const REPO_B = { id: 9810002, fullName: "limits-org-b/gadgets" };
const OWNER_A_EMAIL = "limits-a@e2e.test";
const OWNER_B_EMAIL = "limits-b@e2e.test";
const MEMBER_EMAIL = "limits-member@e2e.test";

// The operator's key (saved in the admin portal, by the instance admin) and the own key of workspace B. Dummies
// that must show up in no page, comment or answer.
const OPERATOR_KEY = "sk-or-v1-e2e-operator-key-0123456789abcdef-opr1";
const OWN_KEY_B = "sk-or-v1-e2e-own-key-of-workspace-b-0123456789-own2";

// Which model backs each tier: operator data, made up, and distinctive so that a search for them cannot match
// anything else. They are in the operator API, the fake LLM and nowhere a workspace can read.
const TIER_MODELS = {
  low: { diff: "tierproof/low-diff-q7x2", dynamic: "tierproof/low-dyn-q7x2" },
  medium: {
    diff: "tierproof/medium-diff-m4k9",
    dynamic: "tierproof/medium-dyn-m4k9",
  },
  high: {
    diff: "tierproof/high-diff-h8w3",
    dynamic: "tierproof/high-dyn-h8w3",
  },
} as const;
// What the provider's metadata says the tier models cost, per token (as the provider writes it): distinctive
// figures, so that a page that shows a price, per token or per million tokens, is found.
const PROMPT_PRICE_PER_TOKEN = "0.000000731";
const COMPLETION_PRICE_PER_TOKEN = "0.000002917";
const PRICE_FIGURES = ["0.731", "2.917", "0.000000731", "0.000002917"];
// The fake LLM reports this cost with every answer (usage.cost, in US dollars): 100 micro-USD.
const REPORTED_COST_MICRO_USD = 100;
const REVIEW_MARKER = "<!-- pr-agent:review:full -->";
const NOTICE_MARKER = "<!-- code-reviewer:refusal-notice";
const SUSPENSION_CODE = "e2e_operator_hold";
const PLAN_LABEL = "e2e-managed-plan";
// The operator's page that "Manage plan" hands people over to. The browser is not allowed to reach it: the journey
// answers it itself (a route of the page), so the network guard is never asked for anything.
const PLAN_PAGE = "https://plans.example.test/manage";

// A review through the real PR-Agent takes a few seconds; the first one also loads PR-Agent.
const RUN_TIMEOUT = { timeout: 120_000 };

/** A head commit that is different for every pull request and every push (`variant`). */
const headSha = (variant: string, number: number) =>
  variant + String(number).padStart(39, "0");

test.describe.configure({ mode: "serial" });

test.describe("a limited workspace on an instance with the operator API on", () => {
  let llm: FakeLlm | undefined;
  let runner: RunnerProcess | undefined;
  let operator: OperatorClient | undefined;
  const contexts: BrowserContext[] = [];
  let pageA: Page | undefined;
  let pageB: Page | undefined;
  let slugA = "";
  let slugB = "";
  let workspaceIdA = "";
  let workspaceIdB = "";
  // The start of the current period of workspace A, as the operator last set it.
  let periodStartA = "";

  test.beforeAll(async ({ browser, request }) => {
    test.setTimeout(240_000);
    llm = await startLlmFake({ port: e2eEnv.operatorLlmFakePort });
    registerTierModels(llm);
    runner = await startRunner({
      appUrl: e2eEnv.operatorAppUrl,
      llmBaseUrl: llm.baseUrl,
    });
    operator = await operatorClient();

    // The GitHub side: two organizations, each with an installation and a repository, and an owner who can
    // authorize the connection.
    await addGithubAccount(request, ownerA, null);
    await addGithubAccount(request, ownerB, null);
    await addGithubInstallation(
      request,
      { id: INSTALLATION_A, account: ORG_A },
      [REPO_A],
    );
    await addGithubInstallation(
      request,
      { id: INSTALLATION_B, account: ORG_B },
      [REPO_B],
    );
    await addGithubOrgMember(request, {
      org: ORG_A.login,
      login: ownerA.login,
      role: "admin",
    });
    await addGithubOrgMember(request, {
      org: ORG_B.login,
      login: ownerB.login,
      role: "admin",
    });
    await setGithubAppSetupUrl(
      request,
      `${e2eEnv.operatorAppUrl}/github/connected`,
    );

    // Two people found two workspaces, connect their installation and switch their repository on, as in the
    // product. Neither has any entitlement yet: the operator has not said anything.
    const a = await founder(
      browser,
      e2eEnv.operatorAppUrl,
      OWNER_A_EMAIL,
      "Limits A",
    );
    const b = await founder(
      browser,
      e2eEnv.operatorAppUrl,
      OWNER_B_EMAIL,
      "Limits B",
    );
    pageA = a.page;
    pageB = b.page;
    contexts.push(a.page.context(), b.page.context());
    slugA = a.slug;
    slugB = b.slug;
    await connectGithub(a.page, slugA, {
      installOn: ORG_A.login,
      authorizeAs: ownerA,
    });
    await connectGithub(b.page, slugB, {
      installOn: ORG_B.login,
      authorizeAs: ownerB,
    });
    await switchRepositoryOn(a.page, slugA, REPO_A.fullName);
    await switchRepositoryOn(b.page, slugB, REPO_B.fullName);

    // Workspace B brings its own key, saved in its settings as an Owner does it.
    const saved = await b.page.request.put(`/api/w/${slugB}/llm-key`, {
      data: { provider: llmEnv.provider, apiKey: OWN_KEY_B },
    });
    expect(saved.status(), await saved.text()).toBe(200);

    workspaceIdA = await operator.workspaceId(slugA);
    workspaceIdB = await operator.workspaceId(slugB);
  });

  test.beforeEach(() => {
    fakeLlm().reset();
    registerTierModels(fakeLlm());
  });

  test.afterAll(async () => {
    for (const context of contexts) await context.close();
    await operator?.dispose();
    await runner?.stop();
    await llm?.close();
  });

  function fakeLlm(): FakeLlm {
    if (llm === undefined) throw new Error("The fake LLM was not started.");
    return llm;
  }
  function script(): OperatorClient {
    if (operator === undefined) throw new Error("The script has no client.");
    return operator;
  }
  function ownerPage(): Page {
    if (pageA === undefined) throw new Error("Owner A has no page.");
    return pageA;
  }
  function ownKeyPage(): Page {
    if (pageB === undefined) throw new Error("Owner B has no page.");
    return pageB;
  }
  function runnerOutput(): string {
    if (runner === undefined) throw new Error("The runner was not started.");
    return runner.output();
  }

  /** The rows of the Runs page that belong to a pull request. */
  function runsOf(page: Page, repository: string, number: number) {
    return page
      .locator("[data-run-id]")
      .filter({ hasText: repository })
      .filter({ hasText: `#${String(number)}` });
  }

  async function openRuns(page: Page, slug: string) {
    await page.goto(`/w/${slug}/runs`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Runs" }),
    ).toBeVisible();
  }

  /** A pull request of workspace A (or B) is opened or pushed to: the webhook GitHub would send. */
  async function deliver(
    request: APIRequestContext,
    which: "A" | "B",
    options: {
      action: "opened" | "synchronize";
      number: number;
      variant: string;
    },
  ): Promise<void> {
    const repository = which === "A" ? REPO_A : REPO_B;
    const org = which === "A" ? ORG_A : ORG_B;
    const installationId = which === "A" ? INSTALLATION_A : INSTALLATION_B;
    const title = `Change number ${String(options.number)}`;
    const head = headSha(options.variant, options.number);
    await addGithubPullRequest(request, repository.fullName, {
      number: options.number,
      title,
      headSha: head,
    });
    const answer = await deliverPullRequestEvent(request, {
      action: options.action,
      installationId,
      repository: { ...repository, owner: { login: org.login, id: org.id } },
      number: options.number,
      title,
      headSha: head,
    });
    expect(answer).toEqual({ status: "accepted", outcome: "trigger_enqueued" });
  }

  async function commentsOf(
    request: APIRequestContext,
    repository: { fullName: string },
    number: number,
  ): Promise<GithubComment[]> {
    return getPullRequestComments(request, repository.fullName, number);
  }
  const noticesOf = (comments: GithubComment[]) =>
    comments.filter((comment) => comment.body.includes(NOTICE_MARKER));
  const reviewsOf = (comments: GithubComment[]) =>
    comments.filter((comment) => comment.body.includes(REVIEW_MARKER));

  // #285-T02
  test("the script sets default entitlements and a tier configuration, and two pull requests are reviewed with the operator's key and the tier model", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const page = ownerPage();
    // The instance admin saves the operator's key in the admin portal; the API has no call for it.
    await changeAdminSetting(e2eEnv.operatorAppUrl, {
      operatorLlmKey: { apiKey: OPERATOR_KEY },
    });
    // The operator's script: which model backs each tier, the page "Manage plan" leads to, the entitlements of
    // workspace B (its own key, no limit) and the default for everybody else.
    await script().putModelTiers(TIER_MODELS);
    await script().putPlanManagement(PLAN_PAGE);
    await script().putEntitlements(workspaceIdB, {
      planLabel: "e2e-own-key-plan",
      keyMode: "own",
      limits: {
        diffRunsPerPeriod: null,
        dynamicRunsPerPeriod: null,
        managedCostLimitMicroUsd: null,
        ownKeyCostLimitMicroUsd: null,
      },
      suspended: false,
      suspensionCode: null,
    });
    const defaults = await script().putDefaultEntitlements({
      planLabel: PLAN_LABEL,
      keyMode: "managed",
      limits: {
        diffRunsPerPeriod: 2,
        dynamicRunsPerPeriod: null,
        // Far above what this journey spends: the plan page shows a bar for it, which is the page to search.
        managedCostLimitMicroUsd: 1_000_000,
        ownKeyCostLimitMicroUsd: null,
      },
      suspended: false,
      suspensionCode: null,
    });
    periodStartA = (defaults as { default: { periodStart: string } }).default
      .periodStart;

    await openRuns(page, slugA);
    await deliver(request, "A", { action: "opened", number: 1, variant: "1" });
    await expect(
      runsOf(page, REPO_A.fullName, 1).locator("[data-status]"),
    ).toContainText("Succeeded", RUN_TIMEOUT);
    await deliver(request, "A", { action: "opened", number: 2, variant: "1" });
    await expect(
      runsOf(page, REPO_A.fullName, 2).locator("[data-status]"),
    ).toContainText("Succeeded", RUN_TIMEOUT);

    // Each pull request got one review comment. The model was asked twice, with the operator's key (not a key of
    // the workspace, which has none), for the model of the medium tier, and with the provider's parameter
    // requirement of #270.
    for (const number of [1, 2])
      expect(reviewsOf(await commentsOf(request, REPO_A, number))).toHaveLength(
        1,
      );
    const asked = fakeLlm().requests();
    expect(asked).toHaveLength(2);
    for (const item of asked) {
      expect(item.authorization).toBe(`Bearer ${OPERATOR_KEY}`);
      expect(item.model).toContain(TIER_MODELS.medium.diff);
      expect(item.provider).toMatchObject({ require_parameters: true });
    }
    // The operator's key stays in the runner's hands: it is in no output of the runner.
    expect(runnerOutput()).not.toContain(OPERATOR_KEY.slice(0, -4));
  });

  // #285-T03
  test("a third review is refused: the run says quota_exhausted, the pull request gets one notice, no model is called and no usage is recorded", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const page = ownerPage();
    await openRuns(page, slugA);
    await deliver(request, "A", { action: "opened", number: 3, variant: "1" });

    const rows = runsOf(page, REPO_A.fullName, 3);
    await expect(rows.locator("[data-status]")).toContainText(
      "Failed",
      RUN_TIMEOUT,
    );
    // The run says what happened, in words, and that no model was used.
    await rows.getByRole("link", { name: `${REPO_A.fullName} #3` }).click();
    const detail = page
      .locator('[data-slot="run-detail"]')
      .filter({ visible: true });
    await expect(detail.getByText("quota_exhausted")).toBeVisible();
    await expect(
      detail.getByText(/used up what its plan allows.*no AI model was used/),
    ).toBeVisible();

    // One notice on the pull request, from the app, and no review.
    await expect
      .poll(
        async () => noticesOf(await commentsOf(request, REPO_A, 3)).length,
        RUN_TIMEOUT,
      )
      .toBe(1);
    const comments = await commentsOf(request, REPO_A, 3);
    const [notice] = noticesOf(comments);
    expect(notice?.login).toBe(e2eEnv.githubBotLogin);
    expect(notice?.body).toContain("No review ran for this change.");
    expect(notice?.body).toContain(
      "This workspace has used the reviews included for the current period.",
    );
    // The operator has a plan page, so the notice leads to the plan page of the workspace (never to the
    // operator's page).
    expect(notice?.body).toContain(
      `${e2eEnv.operatorAppUrl}/w/${slugA}/settings/plan`,
    );
    expect(notice?.body).not.toContain(PLAN_PAGE);
    expect(reviewsOf(comments)).toEqual([]);

    // A push in the same period is refused again and, as the notice says it once per pull request and period, adds
    // no second one (checked at the end of the journey, when nothing is in flight any more).
    await deliver(request, "A", {
      action: "synchronize",
      number: 3,
      variant: "2",
    });
    await openRuns(page, slugA);
    await expect(
      runsOf(page, REPO_A.fullName, 3).locator("[data-status]"),
    ).toHaveText([/Failed/, /Failed/], RUN_TIMEOUT);

    // The model was not asked, and the records are still the two of T02 (checked by the feed in T04).
    expect(fakeLlm().requests()).toHaveLength(0);
  });

  // #285-T04
  test("the usage feed holds the two settled records with the measured cost and the tier, in order, and no model, repository or person", async () => {
    test.setTimeout(240_000);
    // A record is served once it was settled more than the safety lag ago (60 seconds): the script polls like a
    // reader that is caught up would.
    const records = await pollUsage(script(), workspaceIdA, 2);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.settledAt)).toEqual(
      [...records.map((record) => record.settledAt)].sort(),
    );
    expect(new Set(records.map((record) => record.id)).size).toBe(2);
    for (const record of records)
      expect(record).toEqual({
        id: expect.any(String),
        workspaceId: workspaceIdA,
        jobId: expect.any(String),
        reviewKind: "diff",
        keyMode: "managed",
        modelTier: "medium",
        costMicroUsd: REPORTED_COST_MICRO_USD,
        promptTokens: 100,
        completionTokens: 50,
        settledAt: expect.any(String),
        reason: null,
      });

    // The answer is the fields of the contract and nothing a repository, a pull request, a person, a key or a model
    // could be read from.
    const text = JSON.stringify(records);
    await expectNothingSecret([["the usage feed", text]], "the feed", {
      costIsTheOperators: true,
    });
    for (const forbidden of [
      REPO_A.fullName,
      ORG_A.login,
      ownerA.login,
      OWNER_A_EMAIL,
      "Change number",
    ])
      expect(text, `the feed names ${forbidden}`).not.toContain(forbidden);

    // The summary of the period, which has no safety lag: two runs, both measured, none unknown. The refused third
    // review is not in it (it reserved no record).
    const summary = await script().call(
      "GET",
      `/workspaces/${workspaceIdA}/usage/summary?${period(periodStartA)}`,
    );
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      groups: [
        {
          reviewKind: "diff",
          keyMode: "managed",
          recordCount: 2,
          settledCount: 2,
          knownCostMicroUsd: 2 * REPORTED_COST_MICRO_USD,
          unknownCostCount: 0,
        },
      ],
    });
    const unknown = await script().call(
      "GET",
      `/usage/unknown-cost?${period(periodStartA)}`,
    );
    expect(unknown.status).toBe(200);
    expect(unknown.body).toMatchObject({ counts: [] });
  });

  // #285-T10
  test("an Owner chooses the High quality level in the review defaults, without a model field or a model name anywhere on the page", async () => {
    const page = ownerPage();
    await page.goto(`/w/${slugA}/settings/review-defaults`);
    const quality = page.locator('[data-field="modelTier"]');
    await expect(quality).toBeVisible();
    // Three levels, all available (the operator configured a model for every tier and kind), none of them says
    // which model it is.
    for (const level of ["low", "medium", "high"])
      await expect(quality.locator(`[data-level="${level}"]`)).toBeVisible();
    await expect(page.getByText("Not available")).toHaveCount(0);
    // A workspace on the operator's key has no model field to fill in.
    await expect(page.getByLabel("Model", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Fallback model")).toHaveCount(0);
    await expect(page.getByLabel("Dynamic Review model")).toHaveCount(0);
    await expectNothingSecret(
      [["the review defaults", await page.content()]],
      "the review defaults",
    );

    await quality.getByRole("radio", { name: /High/ }).click();
    await page.getByRole("button", { name: "Save review defaults" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();
    // The choice is stored: a reload shows it. Its effect is the model of the review in T05.
    await page.reload();
    await expect(
      page
        .locator('[data-field="modelTier"]')
        .getByRole("radio", { name: /High/ }),
    ).toBeChecked();
  });

  // #285-T05, #285-T11
  test("the script moves the start of the period forward and the next push is reviewed, on the model of the chosen level; the plan page follows", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const page = ownerPage();
    // Before the reset the plan page says that the limit is reached, as the refusals did.
    await page.goto(`/w/${slugA}/settings/plan`);
    await expect(page.getByText("2 of 2, limit reached")).toBeVisible();

    periodStartA = new Date().toISOString();
    await script().putDefaultEntitlements({
      ...DEFAULT_ENTITLEMENTS,
      periodStart: periodStartA,
    });
    await page.reload();
    await expect(
      page.getByText("0 of 2", { exact: false }).first(),
    ).toBeVisible();
    await expect(page.getByText("2 of 2, limit reached")).toHaveCount(0);

    await deliver(request, "A", {
      action: "synchronize",
      number: 3,
      variant: "3",
    });
    await openRuns(page, slugA);
    await expect(
      runsOf(page, REPO_A.fullName, 3).locator("[data-status]"),
    ).toHaveText([/Succeeded/, /Failed/, /Failed/], RUN_TIMEOUT);

    // The review ran for the High level the Owner chose in T10.
    const asked = fakeLlm().requests();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.authorization).toBe(`Bearer ${OPERATOR_KEY}`);
    expect(asked[0]?.model).toContain(TIER_MODELS.high.diff);
    expect(reviewsOf(await commentsOf(request, REPO_A, 3))).toHaveLength(1);
    await page.goto(`/w/${slugA}/settings/plan`);
    await expect(page.getByText("1 of 2")).toBeVisible();
  });

  // #285-T06
  test("the script suspends the workspace: the next review is refused with the neutral notice, and unsuspending restores it", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const page = ownerPage();
    await script().putDefaultEntitlements({
      ...DEFAULT_ENTITLEMENTS,
      suspended: true,
      suspensionCode: SUSPENSION_CODE,
    });
    await page.goto(`/w/${slugA}/settings/plan`);
    await expect(
      page.getByText("Reviews are paused", { exact: true }),
    ).toBeVisible();

    await deliver(request, "A", {
      action: "synchronize",
      number: 3,
      variant: "4",
    });
    await openRuns(page, slugA);
    await expect(
      runsOf(page, REPO_A.fullName, 3).locator("[data-status]"),
    ).toHaveText([/Failed/, /Succeeded/, /Failed/, /Failed/], RUN_TIMEOUT);
    expect(fakeLlm().requests()).toHaveLength(0);
    const refused = runsOf(page, REPO_A.fullName, 3).first();
    await refused.getByRole("link", { name: `${REPO_A.fullName} #3` }).click();
    const detail = page
      .locator('[data-slot="run-detail"]')
      .filter({ visible: true });
    await expect(detail.getByText("workspace_suspended")).toBeVisible();

    // The notice of the new period says that reviews are paused, with no reason and no code.
    await expect
      .poll(
        async () => noticesOf(await commentsOf(request, REPO_A, 3)).length,
        RUN_TIMEOUT,
      )
      .toBe(2);
    const notices = noticesOf(await commentsOf(request, REPO_A, 3));
    expect(notices[1]?.body).toContain(
      "Reviews are paused for this workspace.",
    );
    expect(notices[1]?.body).not.toContain(SUSPENSION_CODE);
    expect(notices[1]?.body).toContain(`/w/${slugA}/settings/plan`);

    // Unsuspended, the next push is reviewed again (the second of two in this period).
    await script().putDefaultEntitlements({
      ...DEFAULT_ENTITLEMENTS,
      suspended: false,
      suspensionCode: null,
    });
    await deliver(request, "A", {
      action: "synchronize",
      number: 3,
      variant: "5",
    });
    await openRuns(page, slugA);
    await expect(
      runsOf(page, REPO_A.fullName, 3).locator("[data-status]"),
    ).toHaveText(
      [/Succeeded/, /Failed/, /Succeeded/, /Failed/, /Failed/],
      RUN_TIMEOUT,
    );
    expect(fakeLlm().requests()).toHaveLength(1);

    // One notice per period and pull request, not one per refusal: the two refusals of the first period (T03) left
    // one, the refusal of the second period left one.
    const comments = await commentsOf(request, REPO_A, 3);
    expect(noticesOf(comments)).toHaveLength(2);
    expect(reviewsOf(comments)).toHaveLength(1);
  });

  // #285-T08
  test("an Owner clicks Manage plan and the script redeems the token: the identity is returned once and the second redeem is refused", async () => {
    const page = ownerPage();
    // The operator's page is not reachable from the test: the browser is answered by the journey.
    await page.route("https://plans.example.test/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Operator page</title><p>Operator page</p>",
      }),
    );
    await page.goto(`/w/${slugA}/settings/plan`);
    await page.getByRole("button", { name: "Manage plan" }).click();
    await page.waitForURL(/^https:\/\/plans\.example\.test\/manage\?handoff=/);
    const token = new URL(page.url()).searchParams.get("handoff") ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await page.unroute("https://plans.example.test/**");

    const first = await script().redeemHandoff(token);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      version: 1,
      workspaceId: workspaceIdA,
      workspaceSlug: slugA,
      userId: expect.any(String),
      role: "owner",
    });
    // No email, name or repository: ids, the slug and the role.
    expect(first.text).not.toContain(OWNER_A_EMAIL);
    expect(first.text).not.toContain(REPO_A.fullName);

    const second = await script().redeemHandoff(token);
    expect(second.status).toBe(422);
    expect(second.body).toEqual({ version: 1, error: "invalid_token" });
  });

  // #285-T07
  test("a member's views and the comments on the pull requests contain no tier model id, key, price, amount or cost", async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    // A member of workspace A: signs up, and is added to the workspace the way the journeys of the invitations do
    // not need to repeat.
    const context = await browser.newContext({
      baseURL: e2eEnv.operatorAppUrl,
    });
    contexts.push(context);
    const member = await context.newPage();
    await signUpAndIn(member, MEMBER_EMAIL);
    await joinWorkspace(member, { email: MEMBER_EMAIL }, "member", slugA);
    await member.goto(`/w/${slugA}/settings/plan`);

    // What a member of a managed workspace reads on the plan page: the label, the counts and a percentage bar, and
    // that the instance provides the models. No "Manage plan" for a member.
    await expect(member.getByText(PLAN_LABEL)).toBeVisible();
    await expect(member.getByText("2 of 2, limit reached")).toBeVisible();
    await expect(
      member.getByText(
        "The models for your reviews are provided by this instance.",
      ),
    ).toBeVisible();
    await expect(member.getByRole("progressbar")).toHaveAccessibleName(
      /^\d+ % of the usage limit used$/,
    );
    await expect(
      member.getByRole("button", { name: "Manage plan" }),
    ).toHaveCount(0);

    // Every page and answer a member can read, and the same for the Owner.
    const memberTexts = await collectViews(member, slugA, REPO_A.fullName);
    const ownerTexts = await collectViews(ownerPage(), slugA, REPO_A.fullName);
    const commentTexts: Array<[string, string]> = [];
    for (const number of [1, 2, 3])
      for (const comment of await commentsOf(request, REPO_A, number))
        commentTexts.push([
          `a comment on pull request ${String(number)}`,
          comment.body,
        ]);
    expect(commentTexts.length).toBeGreaterThanOrEqual(5);
    // The search finds what it looks for: a text that holds a tier model id, a key, a price or an amount fails it.
    for (const leak of [
      `reviewed by ${TIER_MODELS.low.diff}`,
      `key ${OPERATOR_KEY}`,
      `price ${PRICE_FIGURES[0]} per million`,
      "costs $12.50",
    ])
      await expect(
        expectNothingSecret([["a control", leak]], "control"),
      ).rejects.toThrow();
    expect(memberTexts.length).toBeGreaterThan(10);
    // A run on a quality level shows no cost (the data of the run says so): that is why none is found below.
    expect(
      memberTexts.some(
        ([name, text]) =>
          /^\/api\/w\/[^/]+\/runs\/[^/]+$/.test(name) &&
          text.includes('"costHidden":true'),
      ),
    ).toBe(true);
    await expectNothingSecret(
      [
        ...memberTexts,
        ...ownerTexts.map(
          ([name, text]) => [`Owner: ${name}`, text] as [string, string],
        ),
        ...commentTexts,
      ],
      "a view of workspace A",
    );
    // The member may not start the hand-over.
    const handoff = await member.request.post(`/api/w/${slugA}/plan-handoff`, {
      maxRedirects: 0,
    });
    expect(handoff.status()).toBe(403);
  });

  // #285-T09
  test("a workspace on its own key on the same instance is unaffected by the limits, the suspension and the tiers of the other", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const page = ownKeyPage();
    // Workspace A has used what it may in this period, so a review of A would be refused now.
    await openRuns(ownerPage(), slugA);
    await expect(ownerPage().locator("[data-run-id]").first()).toBeVisible();

    await openRuns(page, slugB);
    await deliver(request, "B", { action: "opened", number: 1, variant: "6" });
    await expect(
      runsOf(page, REPO_B.fullName, 1).locator("[data-status]"),
    ).toContainText("Succeeded", RUN_TIMEOUT);

    // It was reviewed with its own key and its own model: not the operator's key, not a tier model.
    const asked = fakeLlm().requests();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.authorization).toBe(`Bearer ${OWN_KEY_B}`);
    expect(asked[0]?.model).toContain(llmEnv.model);
    for (const tier of Object.values(TIER_MODELS))
      for (const id of Object.values(tier))
        expect(asked[0]?.model).not.toContain(id);
    expect(reviewsOf(await commentsOf(request, REPO_B, 1))).toHaveLength(1);

    // The usage of the two workspaces is kept apart: B's run is its own key, no tier, a measured cost; A's records
    // did not change (the summary has no safety lag).
    const summaryB = await script().call(
      "GET",
      `/workspaces/${workspaceIdB}/usage/summary?${period(periodStartA)}`,
    );
    expect(summaryB.body).toMatchObject({
      groups: [
        {
          reviewKind: "diff",
          keyMode: "own",
          recordCount: 1,
          settledCount: 1,
          knownCostMicroUsd: REPORTED_COST_MICRO_USD,
          unknownCostCount: 0,
        },
      ],
    });
    const summaryA = await script().call(
      "GET",
      `/workspaces/${workspaceIdA}/usage/summary?${period(periodStartA)}`,
    );
    expect(summaryA.body).toMatchObject({
      groups: [{ keyMode: "managed", recordCount: 2, settledCount: 2 }],
    });

    // Its pages are those of a workspace on its own key: it chooses a model, not a quality level, and nothing says
    // the instance provides its models.
    await page.goto(`/w/${slugB}/settings/review-defaults`);
    await expect(page.locator('[data-field="modelTier"]')).toHaveCount(0);
    await expect(page.getByLabel("Model", { exact: true })).toBeVisible();
    await page.goto(`/w/${slugB}/settings/plan`);
    await expect(
      page.getByText(
        "The models for your reviews are provided by this instance.",
      ),
    ).toHaveCount(0);
    await expect(page.getByText("1 used, no limit")).toBeVisible();
  });

  // #285-T04 (continued): the feed after everything.
  test("the usage feed, read again at the end, holds every settled record of the workspace in order, with the level each ran on", async () => {
    test.setTimeout(240_000);
    const records = await pollUsage(script(), workspaceIdA, 4);
    expect(records.map((record) => record.modelTier)).toEqual([
      "medium",
      "medium",
      "high",
      "high",
    ]);
    expect(
      records.every(
        (record) => record.costMicroUsd === REPORTED_COST_MICRO_USD,
      ),
    ).toBe(true);
    expect(records.map((record) => record.settledAt)).toEqual(
      [...records.map((record) => record.settledAt)].sort(),
    );
    // The other workspace's record is not in this workspace's feed, and the refused runs left none.
    expect(records.every((record) => record.workspaceId === workspaceIdA)).toBe(
      true,
    );
    const own = await pollUsage(script(), workspaceIdB, 1);
    expect(own[0]).toMatchObject({
      keyMode: "own",
      modelTier: null,
      costMicroUsd: REPORTED_COST_MICRO_USD,
    });
    await expectNothingSecret(
      [["the usage feed", JSON.stringify([...records, ...own])]],
      "the feed",
      { costIsTheOperators: true },
    );
  });
});

const DEFAULT_ENTITLEMENTS = {
  planLabel: PLAN_LABEL,
  keyMode: "managed",
  limits: {
    diffRunsPerPeriod: 2,
    dynamicRunsPerPeriod: null,
    managedCostLimitMicroUsd: 1_000_000,
    ownKeyCostLimitMicroUsd: null,
  },
  suspended: false,
  suspensionCode: null,
} as const;

/** The fake LLM's model metadata for the tier models: what the provider says the models support and cost. */
function registerTierModels(llm: FakeLlm): void {
  for (const tier of Object.values(TIER_MODELS))
    for (const id of Object.values(tier))
      llm.setModel(id, [
        {
          supported_parameters: [
            "tools",
            "tool_choice",
            "response_format",
            "structured_outputs",
            "max_tokens",
          ],
          max_completion_tokens: 16_384,
          context_length: 200_000,
          pricing: {
            prompt: PROMPT_PRICE_PER_TOKEN,
            completion: COMPLETION_PRICE_PER_TOKEN,
          },
          supports_tool_choice: { required: true },
        },
      ]);
}

/** `from` and `to` of a period that starts at `start` and holds everything the journey does. */
function period(start: string): string {
  const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return `from=${encodeURIComponent(start)}&to=${encodeURIComponent(to)}`;
}

/**
 * Reads the usage feed of a workspace until it holds `count` records: a record is served once it was settled more than
 * the safety lag ago, so a reader waits for it (no sleep: the wait is for the condition).
 */
async function pollUsage(
  client: OperatorClient,
  workspaceId: string,
  count: number,
): Promise<UsageItem[]> {
  let records: UsageItem[] = [];
  await expect
    .poll(
      async () => {
        records = await client.usageOf(workspaceId);
        return records.length;
      },
      { timeout: 150_000, intervals: [2_000, 5_000] },
    )
    .toBe(count);
  return records;
}

/**
 * Everything a person of workspace `slug` can read about it: the pages as the server renders them and the answers of
 * the data routes the pages use, for the settings, the plan, the projects and every run. Named, so that a failure says
 * where the secret was.
 */
async function collectViews(
  page: Page,
  slug: string,
  repository: string,
): Promise<Array<[string, string]>> {
  const texts: Array<[string, string]> = [];
  const read = async (path: string) => {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(200);
    texts.push([path, await response.text()]);
    return texts.at(-1)?.[1] ?? "";
  };
  for (const path of [
    `/w/${slug}`,
    `/w/${slug}/settings`,
    `/w/${slug}/settings/review-defaults`,
    `/w/${slug}/settings/llm`,
    `/w/${slug}/settings/plan`,
    `/w/${slug}/settings/advanced`,
    `/w/${slug}/projects`,
    `/w/${slug}/connections`,
    `/w/${slug}/members`,
    `/w/${slug}/runs`,
    `/api/w/${slug}/plan`,
    `/api/w/${slug}/runs`,
    `/api/w/${slug}/review-settings`,
  ])
    await read(path);
  // The project of the repository (its page and its settings), found by the link on the Projects page.
  const projects =
    texts.find(([name]) => name.endsWith("/projects"))?.[1] ?? "";
  const href = new RegExp(`/w/${slug}/projects/([^"/?#]+)`).exec(projects);
  if (href?.[1] !== undefined) {
    await read(`/w/${slug}/projects/${href[1]}`);
    await read(`/api/w/${slug}/repositories/${href[1]}/project/settings`);
  }
  expect(projects, "the Projects page lists the repository").toContain(
    repository,
  );
  // Every run: its page and its data.
  const runs = JSON.parse(
    texts.find(([name]) => name === `/api/w/${slug}/runs`)?.[1] ?? "{}",
  ) as { runs?: Array<{ id: string }> };
  for (const run of runs.runs ?? []) {
    await read(`/w/${slug}/runs/${run.id}`);
    await read(`/api/w/${slug}/runs/${run.id}`);
  }
  expect(
    runs.runs?.length ?? 0,
    "the runs of the workspace",
  ).toBeGreaterThanOrEqual(5);
  return texts;
}

/**
 * Nothing in these texts is a model id of a tier, a price of a model, a key, an amount of money or a measured cost.
 * `where` names the kind of text for the failure message.
 */
async function expectNothingSecret(
  texts: Array<[string, string]>,
  where: string,
  /** The operator reads the measured cost of the runs (the feed); a workspace never does. */
  options: { costIsTheOperators?: boolean } = {},
): Promise<void> {
  const ids = Object.values(TIER_MODELS).flatMap((tier) => Object.values(tier));
  const secrets = [
    ...ids,
    ...ids.map((id) => id.split("/")[1] ?? id),
    "tierproof",
    OPERATOR_KEY,
    OPERATOR_KEY.slice(0, -4),
    SUSPENSION_CODE,
    e2eEnv.operatorApiToken,
  ];
  for (const [name, text] of texts) {
    for (const secret of secrets)
      expect(text, `${where}: ${name} holds ${secret}`).not.toContain(secret);
    for (const figure of PRICE_FIGURES)
      expect(text, `${where}: ${name} holds the price ${figure}`).not.toContain(
        figure,
      );
    if (options.costIsTheOperators === true) continue;
    // A measured cost (the fake reports 0.0001 US dollars with every answer) and an amount of money: a currency sign
    // or a currency code next to a number.
    // The name of a cost field with no figure (`"costUsd":null`, `"costHidden":true`) is no leak; a figure is.
    const cost =
      /0\.0001\b|1e-4|(?:costUsd|costMicroUsd|cost_micro_usd)[\\"\s:]*\d/.exec(
        text,
      );
    expect(
      cost === null
        ? ""
        : text.slice(Math.max(0, cost.index - 120), cost.index + 120),
      `${where}: ${name} holds a measured cost`,
    ).toBe("");
    expect(
      readableText(text),
      `${where}: ${name} holds an amount of money`,
    ).not.toMatch(/[$€£]\s?\d|\d\s?[$€£]|\b(?:USD|EUR|GBP)\b|micro-?usd/i);
  }
}

/**
 * What a person reads in a page: the markup without its scripts and styles (the framework's own scripts hold `$1`
 * and the like, which are no amounts). An answer that is not a page is returned as it is.
 */
function readableText(text: string): string {
  if (!/^\s*<!DOCTYPE html/i.test(text)) return text;
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ");
}
