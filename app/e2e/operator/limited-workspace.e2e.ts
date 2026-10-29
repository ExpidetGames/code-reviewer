// SPDX-License-Identifier: LicenseRef-Proprietary

// The whole chain an operator relies on, on the real app (#285, the last issue of #268): a workspace with limits on an
// instance whose operator API is on runs, is refused, is told so on its pull request, is reset from outside, can be
// read in the usage feed, and never sees which model backs its catalog entry, while a workspace on its own key on the
// same instance is untouched. Nothing in the path is replaced but the outside world: the fake GitHub, the fake LLM,
// and a script (`helpers/operator-api.ts`) that plays the external service over the operator API. The real runner
// (the job loop and the real PR-Agent) claims the jobs, so the claim, the key mode, the catalog entry's model, the usage records
// and the refusals all run as in production.
//
// The instance is the seventh app of the run (playwright.config.ts): multi-tenant, `OPERATOR_API_TOKEN` set, the
// model metadata at the journey's fake LLM. It has two workspaces, each with its own GitHub installation:
//   A  the limited workspace: it takes the default entitlements (the operator's key, two Diff runs per period);
//   B  a workspace on its own key, with an entitlement row of its own that states no limit.
// The plain counterpart (an instance that never switched any of this on) is e2e/operator/plain-instance.e2e.ts.
//
// The case ids are those of #285. The review defaults without a model (T10) and the plan page's states (T11) are cases
// of the follow-ups the earlier pull requests of the epic named; they are proven here and nowhere else at this level.
// The catalog chooser of the project settings is the journey of #433 (T10 of that issue), in the same instance: the
// instance default entry serves the first reviews, the Owner chooses the second entry for the project, and from then on
// the claim and the usage feed name that entry (#432, ADR 0005).
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import { changeAdminSetting } from "../helpers/admin-api";
import { seedCatalog, setCatalogDefaults } from "../helpers/catalog";
import { e2eEnv, llmEnv } from "../helpers/e2e-env";
import { MEASURED_COST } from "../helpers/measured-cost-pattern";
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
import { identityFor } from "../../src/product-identity/identities";
import { startRunner, type RunnerProcess } from "../helpers/runner-process";
import { chooseOption, openSection } from "../helpers/settings-form";
import { deliverPullRequestEvent } from "../helpers/webhooks";

// Workspace A, the limited one, and workspace B, on its own key. Each owns its account, organization, installation
// and repository (ids no other journey uses).
const ownerA: GithubAccount = {
  id: 7710001,
  login: "limits-owner-a",
  name: "Limits Owner A",
  email: "limits-owner-a@example.test",
};
const ownerB: GithubAccount = {
  id: 7710002,
  login: "limits-owner-b",
  name: "Limits Owner B",
  email: "limits-owner-b@example.test",
};
const ORG_A = {
  login: "limits-org-a",
  id: 7810001,
  type: "Organization",
} as const;
const ORG_B = {
  login: "limits-org-b",
  id: 7810002,
  type: "Organization",
} as const;
const INSTALLATION_A = 9810001;
const INSTALLATION_B = 9810002;
const REPO_A = { id: 9811001, fullName: "limits-org-a/widgets" };
const REPO_B = { id: 9811002, fullName: "limits-org-b/gadgets" };
const OWNER_A_EMAIL = "limits-a@e2e.test";
const OWNER_B_EMAIL = "limits-b@e2e.test";
const MEMBER_EMAIL = "limits-member@e2e.test";

// The operator's key (saved in the admin portal, by the instance admin) and the own key of workspace B. Dummies
// that must show up in no page, comment or answer.
const OPERATOR_KEY = "sk-or-v1-e2e-operator-key-0123456789abcdef-opr1";
const OWN_KEY_B = "sk-or-v1-e2e-own-key-of-workspace-b-0123456789-own2";

// Which model backs each catalog entry: operator data, made up, and distinctive so that a search for them cannot match
// anything else. They are in the catalog, the fake LLM and nowhere a workspace can read. The names are what members
// read; "Quick look" is the instance default of Diff Review, "Thorough" the entry the Owner chooses for the project.
const ENTRIES = {
  quick: {
    name: "Quick look",
    description: "Fast passes over small changes.",
    model: "acme-labs/entryproof-m-alpha-z1y2",
  },
  thorough: {
    name: "Thorough",
    description: "Careful passes over large changes.",
    model: "acme-labs/entryproof-m-beta-z1y2",
  },
  explorer: {
    name: "Explorer",
    description: "Explores the repository around a change.",
    model: "acme-labs/entryproof-m-gamma-z1y2",
  },
  detective: {
    name: "Detective",
    description: "Follows every call to the end.",
    model: "acme-labs/entryproof-m-delta-z1y2",
  },
} as const;
const ENTRY_MODEL_IDS: string[] = Object.values(ENTRIES).map(
  (entry) => entry.model,
);
// What the provider's metadata says the entry models cost, per token (as the provider writes it): distinctive
// figures, so that a page that shows a price, per token or per million tokens, is found.
const PROMPT_PRICE_PER_TOKEN = "0.0000007319";
const COMPLETION_PRICE_PER_TOKEN = "0.0000029173";
const PRICE_FIGURES = ["0.7319", "2.9173", "0.0000007319", "0.0000029173"];
// The fake LLM reports this cost with every answer (usage.cost, in US dollars): 100 micro-USD.
const REPORTED_COST_MICRO_USD = 100;
// The cost limit of workspace A (micro-USD of measured cost per period): four runs' worth, so that two runs read as
// exactly 50 % on the plan page and one as 25 %.
const COST_LIMIT_MICRO_USD = 4 * REPORTED_COST_MICRO_USD;
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
  // The ids of the seeded catalog entries by name (the usage feed names an entry by id).
  let entryIds: Record<string, string> = {};

  test.beforeAll(async ({ browser, request }) => {
    test.setTimeout(240_000);
    llm = await startLlmFake({ port: e2eEnv.operatorLlmFakePort });
    registerEntryModels(llm);
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
    registerEntryModels(fakeLlm());
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
  function entryId(name: string): string {
    const id = entryIds[name];
    if (id === undefined) throw new Error(`The entry ${name} was not seeded.`);
    return id;
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
  test("the script sets default entitlements and the catalog, and two pull requests are reviewed with the operator's key and the model of the default entry", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const page = ownerPage();
    // The instance admin saves the operator's key in the admin portal; the API has no call for it.
    await changeAdminSetting(e2eEnv.operatorAppUrl, {
      operatorLlmKey: { apiKey: OPERATOR_KEY },
    });
    // The operator's catalog: two released entries for Diff Review and two for Dynamic Review, the first of each kind
    // the instance default. Then the script: the page "Manage plan" leads to, the entitlements of workspace B (its own
    // key, no limit) and the default for everybody else.
    entryIds = await seedCatalog(
      e2eEnv.operatorDatabaseUrl,
      Object.values(ENTRIES).map((entry, index) => ({
        name: entry.name,
        description: entry.description,
        modelId: entry.model,
        kinds: index < 2 ? ["diff"] : ["dynamic"],
        sortOrder: (index % 2) + 1,
      })),
    );
    await setCatalogDefaults(e2eEnv.operatorDatabaseUrl, {
      diff: entryId(ENTRIES.quick.name),
      dynamic: entryId(ENTRIES.explorer.name),
    });
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
    const defaults =
      await script().putDefaultEntitlements(DEFAULT_ENTITLEMENTS);
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
    // the workspace, which has none), for the model of the default entry, and with the provider's parameter
    // requirement of #270.
    for (const number of [1, 2])
      expect(reviewsOf(await commentsOf(request, REPO_A, number))).toHaveLength(
        1,
      );
    const asked = fakeLlm().requests();
    expect(asked).toHaveLength(2);
    for (const item of asked) {
      expect(item.authorization).toBe(`Bearer ${OPERATOR_KEY}`);
      expect(item.model).toContain(ENTRIES.quick.model);
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
  test("the usage feed holds the two settled records with the measured cost and the default entry, in order, and no model, repository or person", async () => {
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
        modelTier: null,
        catalogEntryId: entryId(ENTRIES.quick.name),
        catalogEntryName: ENTRIES.quick.name,
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
  test("an Owner reads the review defaults with the choice of the catalog and without a model name anywhere on the page", async () => {
    const page = ownerPage();
    await page.goto(`/w/${slugA}/settings/review-defaults`);
    await openSection(page, "LLM");
    // The defaults choose a catalog entry per kind like a project does (#676): the provider dropdown names the maker of the
    // models (never the product), then the entries of that provider by the names the operator gave them. Who bills is a note.
    await expect(
      page.getByText(/chosen for each project, on the settings page/),
    ).toHaveCount(0);
    await expect(page.getByRole("radiogroup", { name: "Quality" })).toHaveCount(
      0,
    );
    const providerDropdown = page.getByRole("combobox", {
      name: "Provider",
      exact: true,
    });
    await expect(providerDropdown).toHaveText("Default");
    await expect(providerDropdown).not.toContainText(
      identityFor("code-review-com").name,
    );
    // This instance never switches billing on, and nothing is billed while it is off: no "Billed via" note (#675).
    await expect(
      page.getByText(`Billed via ${identityFor("code-review-com").name}`),
    ).toHaveCount(0);
    await chooseOption(page, "Provider", "Acme Labs");
    await page.getByRole("combobox", { name: "Model" }).click();
    await expect(
      page.getByRole("option", { name: ENTRIES.quick.name }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: ENTRIES.explorer.name }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    // No model field to fill in, and no fallback model or Dynamic model field.
    await expect(page.getByLabel("Fallback model")).toHaveCount(0);
    await expect(page.getByLabel("Dynamic Review model")).toHaveCount(0);
    await expectNothingSecret(
      [["the review defaults", await page.content()]],
      "the review defaults",
    );
  });

  // #433-T10
  test("an Owner chooses two different catalog entries for Diff and Dynamic Review of a project, and sees no model or provider", async () => {
    // The entries are those T02 seeded: the Owner chooses the second of each kind over the instance default.
    const page = ownerPage();
    await page.goto(`/w/${slugA}/projects`);
    await page
      .getByRole("link", { name: REPO_A.fullName, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: REPO_A.fullName }),
    ).toBeVisible();

    // The LLM section of a workspace on the operator's key: the provider dropdown names the maker of the models (never the
    // product), then the entries of that provider that serve Diff Review by the names the operator gave them, in the order of
    // the catalog, and no Dynamic entry. Who bills is a note, not a provider.
    await openSection(page, "LLM");
    const providerDropdown = page.getByRole("combobox", {
      name: "Provider",
      exact: true,
    });
    // Billing is off on this instance, so the choice carries no "Billed via" note (#675).
    await expect(providerDropdown).toBeVisible();
    await expect(
      page.getByText(`Billed via ${identityFor("code-review-com").name}`),
    ).toHaveCount(0);
    await providerDropdown.click();
    await expect(page.getByRole("option")).toHaveCount(2);
    await page.getByRole("option", { name: "Acme Labs" }).click();
    await expect(providerDropdown).toHaveText("Acme Labs");
    const diffModel = page.getByRole("combobox", { name: "Model" });
    await diffModel.click();
    await expect(page.getByRole("option")).toHaveCount(2);
    await expect(
      page.getByRole("option", { name: ENTRIES.quick.name }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: ENTRIES.explorer.name }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    // No model field, no estimate and no fallback on the managed form.
    await expect(page.getByLabel("Fallback model")).toHaveCount(0);
    await expect(page.getByText("Estimated cost")).toHaveCount(0);

    await chooseOption(page, "Model", /^Thorough/);
    await openSection(page, "Review");
    await page.getByRole("radio", { name: "Dynamic Review" }).click();
    await openSection(page, "LLM");
    await chooseOption(page, "Provider", "Acme Labs");
    await page.getByRole("combobox", { name: "Model" }).click();
    await expect(page.getByRole("option")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await chooseOption(page, "Model", /^Detective/);
    await page.getByRole("button", { name: "Save review settings" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Switch to Dynamic Review" })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();

    // Both choices are stored: a reload shows them, one per kind.
    await page.reload();
    await openSection(page, "LLM");
    await expect(page.getByRole("combobox", { name: "Model" })).toContainText(
      "Detective",
    );
    await openSection(page, "Review");
    await page.getByRole("radio", { name: "Diff Review" }).click();
    await openSection(page, "LLM");
    await expect(page.getByRole("combobox", { name: "Model" })).toContainText(
      "Thorough",
    );
    // Nothing the operator keeps to itself is in the page: not a model id, not the provider.
    const html = await page.content();
    expect(html).not.toContain("entryproof");
    expect(html).not.toMatch(/openrouter/i);

    // The project goes back to Diff Review for the journeys that follow (confirmed, as every switch is).
    await page.getByRole("button", { name: "Save review settings" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Switch to Diff Review" })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();
  });

  // #285-T05, #285-T11
  test("the script moves the start of the period forward and the next push is reviewed, on the entry the Owner chose for the project; the plan page follows", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const page = ownerPage();
    // Before the reset the plan page says that the limit is reached, as the refusals did.
    await page.goto(`/w/${slugA}/settings/plan`);
    await expect(page.getByText("2 of 2, limit reached")).toBeVisible();
    await expect(page.getByText("0 used, no limit")).toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveAccessibleName(
      "50 % of the usage limit used",
    );

    periodStartA = new Date().toISOString();
    await script().putDefaultEntitlements({
      ...DEFAULT_ENTITLEMENTS,
      periodStart: periodStartA,
    });
    await page.reload();
    await expect(page.getByText("0 of 2", { exact: true })).toBeVisible();
    await expect(page.getByText("2 of 2, limit reached")).toHaveCount(0);
    // The runs of the old period are not in the cost of the new one.
    await expect(page.getByRole("progressbar")).toHaveAccessibleName(
      "0 % of the usage limit used",
    );

    await deliver(request, "A", {
      action: "synchronize",
      number: 3,
      variant: "3",
    });
    await openRuns(page, slugA);
    await expect(
      runsOf(page, REPO_A.fullName, 3).locator("[data-status]"),
    ).toHaveText([/Succeeded/, /Failed/, /Failed/], RUN_TIMEOUT);

    // The Owner chose "Thorough" for the project in T10 (over the instance default "Quick look"): the claim names that
    // entry, so the review ran on its model and not on the default's.
    const asked = fakeLlm().requests();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.authorization).toBe(`Bearer ${OPERATOR_KEY}`);
    expect(asked[0]?.model).toContain(ENTRIES.thorough.model);
    expect(asked[0]?.model).not.toContain(ENTRIES.quick.model);
    expect(reviewsOf(await commentsOf(request, REPO_A, 3))).toHaveLength(1);
    await page.goto(`/w/${slugA}/settings/plan`);
    await expect(page.getByText("1 of 2", { exact: true })).toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveAccessibleName(
      "25 % of the usage limit used",
    );
  });

  // #285-T06
  test("the script suspends the workspace: the next review is refused with the neutral notice, a workspace on its own key is still reviewed, and unsuspending restores it", async ({
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
    // The page says that reviews are paused and nothing of why: not the code the script sent.
    await expectNothingSecret(
      [["the paused plan page", await page.content()]],
      "a paused workspace",
    );

    await deliver(request, "A", {
      action: "synchronize",
      number: 3,
      variant: "4",
    });
    await openRuns(page, slugA);
    await expect(
      runsOf(page, REPO_A.fullName, 3).locator("[data-status]"),
    ).toHaveText([/Failed/, /Succeeded/, /Failed/, /Failed/], RUN_TIMEOUT);
    // The refusal is the answer to this push: the model was not asked.
    expect(fakeLlm().requests()).toHaveLength(0);
    const refused = runsOf(page, REPO_A.fullName, 3).first();
    await refused.getByRole("link", { name: `${REPO_A.fullName} #3` }).click();
    const detail = page
      .locator('[data-slot="run-detail"]')
      .filter({ visible: true });
    await expect(detail.getByText("workspace_suspended")).toBeVisible();
    await expectNothingSecret(
      [["the run of a paused workspace", await page.content()]],
      "a paused workspace",
    );

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

    // While A is suspended, the workspace on its own key is reviewed, with its own key and model (T09 has the rest).
    await openRuns(ownKeyPage(), slugB);
    await deliver(request, "B", { action: "opened", number: 1, variant: "6" });
    await expect(
      runsOf(ownKeyPage(), REPO_B.fullName, 1).locator("[data-status]"),
    ).toContainText("Succeeded", RUN_TIMEOUT);
    const askedWhileSuspended = fakeLlm().requests();
    expect(askedWhileSuspended).toHaveLength(1);
    expect(askedWhileSuspended[0]?.authorization).toBe(`Bearer ${OWN_KEY_B}`);

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
    expect(
      fakeLlm()
        .requests()
        .filter((item) => item.authorization === `Bearer ${OPERATOR_KEY}`),
    ).toHaveLength(1);

    // One notice per period and pull request, not one per refusal: the two refusals of the first period (T03) left
    // one, the refusal of the second period left one.
    const comments = await commentsOf(request, REPO_A, 3);
    expect(noticesOf(comments)).toHaveLength(2);
    expect(reviewsOf(comments)).toHaveLength(1);
  });

  // #285-T08
  test("an Owner clicks Manage plan and the script redeems the token: the identity is returned once and the second redeem is refused", async () => {
    const page = ownerPage();
    // The operator's page is not reachable from the test, and the browser must never ask for it: the journey takes
    // the answer of the hand-over route (a 303 to the operator's page) before the browser sees it, reads where it
    // leads and gives the browser a page of the app instead.
    let location = "";
    const handoffRoute = `**/api/w/${slugA}/plan-handoff`;
    await page.route(handoffRoute, async (route) => {
      const answer = await route.fetch({ maxRedirects: 0 });
      expect(answer.status()).toBe(303);
      location = answer.headers()["location"] ?? "";
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Handed over</title><p>Handed over</p>",
      });
    });
    await page.goto(`/w/${slugA}/settings/plan`);
    await page.getByRole("button", { name: "Manage plan" }).click();
    await expect.poll(() => location).not.toBe("");
    await page.unroute(handoffRoute);
    const target = new URL(location);
    expect(`${target.origin}${target.pathname}`).toBe(PLAN_PAGE);
    const token = target.searchParams.get("handoff") ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

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
  test("a member's views and the comments on the pull requests contain no entry model id, key, price, amount or cost", async ({
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
    // that the models are provided by the product (not billed: billing is off here, #675). No "Manage plan" for a member.
    await expect(member.getByText(PLAN_LABEL)).toBeVisible();
    await expect(member.getByText("2 of 2, limit reached")).toBeVisible();
    await expect(
      member.getByText(
        "The models for your reviews are provided by code-review.com.",
      ),
    ).toBeVisible();
    // Two runs of four runs' worth of cost: exactly half, and the Dynamic line is there too.
    await expect(member.getByRole("progressbar")).toHaveAccessibleName(
      "50 % of the usage limit used",
    );
    await expect(member.getByText("0 used, no limit")).toBeVisible();
    await expect(
      member.getByRole("button", { name: "Manage plan" }),
    ).toHaveCount(0);

    // Every page and answer a member can read, and the same for the Owner.
    const memberTexts = await collectViews(member, slugA, REPO_A.fullName, {
      advanced: false,
    });
    const ownerTexts = await collectViews(ownerPage(), slugA, REPO_A.fullName, {
      advanced: true,
    });
    // What the browser shows once the pages are hydrated and have polled: the DOM and the visible text of the plan,
    // the runs, a run and the review defaults, for the member and for the Owner.
    const runIds = (
      JSON.parse(
        memberTexts.find(([name]) => name === `/api/w/${slugA}/runs`)?.[1] ??
          "{}",
      ) as { runs?: Array<{ id: string }> }
    ).runs?.map((run) => run.id);
    const firstRun = runIds?.[0];
    expect(firstRun, "the workspace has a run").toBeDefined();
    const memberDom = await renderedViews(member, slugA, String(firstRun));
    const ownerDom = await renderedViews(ownerPage(), slugA, String(firstRun));
    const commentTexts: Array<[string, string]> = [];
    for (const number of [1, 2, 3])
      for (const comment of await commentsOf(request, REPO_A, number))
        commentTexts.push([
          `a comment on pull request ${String(number)}`,
          comment.body,
        ]);
    expect(commentTexts.length).toBeGreaterThanOrEqual(5);
    // The search finds what it looks for (a table of texts that must fail it, one row per kind of secret).
    await expectTheSearchBites();
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
        ...memberDom,
        ...ownerDom.map(
          ([name, text]) => [`Owner: ${name}`, text] as [string, string],
        ),
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
  test("a workspace on its own key on the same instance is unaffected by the limit, the suspension and the catalog of the other", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const page = ownKeyPage();
    // Workspace A has used what it may in this period (T06 left it at its limit): its next review is refused.
    await ownerPage().goto(`/w/${slugA}/settings/plan`);
    await expect(ownerPage().getByText("2 of 2, limit reached")).toBeVisible();
    await deliver(request, "A", { action: "opened", number: 4, variant: "7" });
    await openRuns(ownerPage(), slugA);
    const refusedRun = runsOf(ownerPage(), REPO_A.fullName, 4);
    await expect(refusedRun.locator("[data-status]")).toContainText(
      "Failed",
      RUN_TIMEOUT,
    );
    await refusedRun
      .getByRole("link", { name: `${REPO_A.fullName} #4` })
      .click();
    await expect(
      ownerPage()
        .locator('[data-slot="run-detail"]')
        .filter({ visible: true })
        .getByText("quota_exhausted"),
    ).toBeVisible();
    expect(fakeLlm().requests()).toHaveLength(0);

    // At that moment, the workspace on its own key is reviewed.
    await openRuns(page, slugB);
    await deliver(request, "B", { action: "opened", number: 2, variant: "8" });
    await expect(
      runsOf(page, REPO_B.fullName, 2).locator("[data-status]"),
    ).toContainText("Succeeded", RUN_TIMEOUT);

    // It was reviewed with its own key and its own model: not the operator's key, not the model of an entry.
    const asked = fakeLlm().requests();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.authorization).toBe(`Bearer ${OWN_KEY_B}`);
    expect(asked[0]?.model).toContain(llmEnv.model);
    for (const id of ENTRY_MODEL_IDS) expect(asked[0]?.model).not.toContain(id);
    for (const number of [1, 2])
      expect(reviewsOf(await commentsOf(request, REPO_B, number))).toHaveLength(
        1,
      );
    // The refusal notice of A, like every comment of A, holds nothing of the catalog.
    await expect
      .poll(
        async () => noticesOf(await commentsOf(request, REPO_A, 4)).length,
        RUN_TIMEOUT,
      )
      .toBe(1);
    await expectNothingSecret(
      (await commentsOf(request, REPO_A, 4)).map(
        (comment) => ["a comment on pull request 4", comment.body] as const,
      ) as Array<[string, string]>,
      "workspace A",
    );

    // The usage of the two workspaces is kept apart: B's runs are its own key, no entry, a measured cost; A's records
    // did not change, and the refused review of A left none (the summary has no safety lag).
    const summaryB = await script().call(
      "GET",
      `/workspaces/${workspaceIdB}/usage/summary?${period(periodStartA)}`,
    );
    expect(summaryB.body).toMatchObject({
      groups: [
        {
          reviewKind: "diff",
          keyMode: "own",
          recordCount: 2,
          settledCount: 2,
          knownCostMicroUsd: 2 * REPORTED_COST_MICRO_USD,
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

    // Its pages are those of a workspace on its own key: it chooses a model, not a catalog entry, and nothing says
    // the instance provides its models.
    await page.goto(`/w/${slugB}/settings/review-defaults`);
    await expect(page.locator('[data-field="catalogEntryDiff"]')).toHaveCount(
      0,
    );
    await openSection(page, "LLM");
    await expect(page.getByRole("combobox", { name: "Model" })).toBeVisible();
    await page.goto(`/w/${slugB}/settings/plan`);
    await expect(
      page.getByText(/The models for your reviews are provided/),
    ).toHaveCount(0);
    await expect(page.getByText("2 used, no limit").first()).toBeVisible();
  });

  // #285-T04 (continued): the feed after everything.
  test("the usage feed, read again at the end, holds every settled record of the workspace in order, with the entry each ran on", async () => {
    test.setTimeout(240_000);
    const records = await pollUsage(script(), workspaceIdA, 4);
    // The two first runs ran on the instance default, the two after the Owner's choice on the chosen entry (#432, #433).
    expect(records.map((record) => record.catalogEntryName)).toEqual([
      ENTRIES.quick.name,
      ENTRIES.quick.name,
      ENTRIES.thorough.name,
      ENTRIES.thorough.name,
    ]);
    expect(records.map((record) => record.catalogEntryId)).toEqual([
      entryId(ENTRIES.quick.name),
      entryId(ENTRIES.quick.name),
      entryId(ENTRIES.thorough.name),
      entryId(ENTRIES.thorough.name),
    ]);
    expect(records.every((record) => record.modelTier === null)).toBe(true);
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
    const own = await pollUsage(script(), workspaceIdB, 2);
    for (const record of own)
      expect(record).toMatchObject({
        keyMode: "own",
        modelTier: null,
        catalogEntryId: null,
        catalogEntryName: null,
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
    managedCostLimitMicroUsd: COST_LIMIT_MICRO_USD,
    ownKeyCostLimitMicroUsd: null,
  },
  suspended: false,
  suspensionCode: null,
} as const;

/** The fake LLM's model metadata for the entry models: what the provider says the models support and cost. */
function registerEntryModels(llm: FakeLlm): void {
  for (const id of ENTRY_MODEL_IDS)
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
  options: { advanced: boolean },
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
    `/w/${slug}/projects`,
    `/w/${slug}/connections`,
    `/w/${slug}/members`,
    `/w/${slug}/runs`,
    `/api/w/${slug}/plan`,
    `/api/w/${slug}/llm-key`,
    `/api/w/${slug}/runs`,
    `/api/w/${slug}/review-settings`,
  ])
    await read(path);
  // Advanced (the deletion of the workspace, #658) is the Owner's page; for a member it is the 404 page, in the browser (the
  // page streams, so what the server sends first is the loading state) and without anything of the page in it.
  if (options.advanced) await read(`/w/${slug}/settings/advanced`);
  else {
    await page.goto(`/w/${slug}/settings`);
    await expect(
      page.getByRole("navigation", { name: "Settings sections" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Advanced" })).toHaveCount(0);
    await page.goto(`/w/${slug}/settings/advanced`);
    await expect(page.getByText("404", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Delete workspace…" }),
    ).toHaveCount(0);
  }
  // The project of the repository (its page and its settings), found by the link on the Projects page.
  const projects =
    texts.find(([name]) => name.endsWith("/projects"))?.[1] ?? "";
  const href = new RegExp(`/w/${slug}/projects/([^"/?#]+)`).exec(projects);
  const repositoryId = href?.[1];
  if (repositoryId === undefined)
    throw new Error("The Projects page has no link to the project.");
  await read(`/w/${slug}/projects/${repositoryId}`);
  await read(`/api/w/${slug}/repositories/${repositoryId}/project/settings`);
  await read(`/api/w/${slug}/repositories/${repositoryId}/pull-requests`);
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
 * What a browser shows of the pages that load and poll their data (the plan page, the Runs list, a run, the review
 * defaults) once they are hydrated: the DOM and the visible text, named after the page.
 */
async function renderedViews(
  page: Page,
  slug: string,
  runId: string,
): Promise<Array<[string, string]>> {
  const texts: Array<[string, string]> = [];
  const take = async (name: string, path: string, ready: Locator) => {
    await page.goto(path);
    await expect(ready.first()).toBeVisible();
    // Hydrated: React has taken the document over, so what is read next is what the browser shows.
    await page.waitForFunction(() =>
      Object.keys(document).some((key) => key.startsWith("__reactContainer")),
    );
    texts.push([`${name} (DOM)`, await page.content()]);
    texts.push([`${name} (text)`, await page.locator("body").innerText()]);
  };
  await take(
    "the plan page",
    `/w/${slug}/settings/plan`,
    page.getByText(PLAN_LABEL),
  );
  await take(
    "the Runs list",
    `/w/${slug}/runs`,
    page.getByRole("heading", { level: 1, name: "Runs" }),
  );
  await take(
    "a run",
    `/w/${slug}/runs/${runId}`,
    page.locator('[data-slot="run-detail"]').filter({ visible: true }),
  );
  await take(
    "the review defaults",
    `/w/${slug}/settings/review-defaults`,
    page.getByLabel("Most findings per review", { exact: true }),
  );
  return texts;
}

const CONTROLS: Array<{
  name: string;
  text: string;
  options?: { costIsTheOperators?: boolean };
  /** What the failure says, or null when the text must pass. */
  fails: string | null;
}> = [
  {
    name: "the id of an entry model",
    text: `reviewed by ${ENTRIES.quick.model}`,
    fails: `a control holds ${ENTRIES.quick.model}`,
  },
  {
    name: "the name of an entry model without its vendor",
    text: "model entryproof-m-gamma-z1y2",
    fails: "a control holds entryproof-m-gamma-z1y2",
  },
  {
    name: "the operator's key",
    text: `key ${OPERATOR_KEY}`,
    fails: `a control holds ${OPERATOR_KEY}`,
  },
  {
    name: "the operator's key without its last four characters",
    text: `key ${OPERATOR_KEY.slice(0, -4)}`,
    fails: `a control holds ${OPERATOR_KEY.slice(0, -4)}`,
  },
  {
    name: "the code of a suspension",
    text: `paused because ${SUSPENSION_CODE}`,
    fails: `a control holds ${SUSPENSION_CODE}`,
  },
  {
    name: "the operator's token",
    text: `token ${e2eEnv.operatorApiToken}`,
    fails: `a control holds ${e2eEnv.operatorApiToken}`,
  },
  {
    name: "a price",
    text: `${PRICE_FIGURES[0]} per million`,
    fails: `a control holds the price ${PRICE_FIGURES[0]}`,
  },
  {
    name: "a measured cost",
    text: "cost 0.0001",
    fails: "a control holds a measured cost",
  },
  {
    name: "a measured cost with trailing zeros",
    text: "cost 0.00010",
    fails: "a control holds a measured cost",
  },
  {
    name: "a measured cost in the data of a run",
    text: '{"costUsd":0.5}',
    fails: "a control holds a measured cost",
  },
  {
    name: "an amount with a currency sign",
    text: "costs $12.50",
    fails: "a control holds an amount of money",
  },
  {
    name: "an amount with a currency code",
    text: "12 EUR a month",
    fails: "a control holds an amount of money",
  },
  {
    // The operator's feed carries the cost, so the bypass lets exactly that through ...
    name: "a measured cost, for the operator's feed",
    text: '{"costMicroUsd":100} 0.0001',
    options: { costIsTheOperators: true },
    fails: null,
  },
  {
    // ... and nothing else of the list.
    name: "an entry model id, for the operator's feed",
    text: `{"costMicroUsd":100,"model":"${ENTRIES.thorough.model}"}`,
    options: { costIsTheOperators: true },
    fails: `a control holds ${ENTRIES.thorough.model}`,
  },
  {
    name: "a price, for the operator's feed",
    text: `${PRICE_FIGURES[1]}`,
    options: { costIsTheOperators: true },
    fails: `a control holds the price ${PRICE_FIGURES[1]}`,
  },
];

/** The search is not vacuous: every kind of secret it looks for fails it, with the failure that names it. */
async function expectTheSearchBites(): Promise<void> {
  for (const control of CONTROLS) {
    const search = expectNothingSecret(
      [["a control", control.text]],
      "control",
      control.options,
    );
    if (control.fails === null) await search;
    else
      await expect(search, control.name).rejects.toThrow(
        `control: ${control.fails}`,
      );
  }
}

/**
 * Nothing in these texts is a model id of an entry, a price of a model, a key, an amount of money or a measured cost.
 * `where` names the kind of text for the failure message.
 */
async function expectNothingSecret(
  texts: Array<[string, string]>,
  where: string,
  /** The operator reads the measured cost of the runs (the feed); a workspace never does. */
  options: { costIsTheOperators?: boolean } = {},
): Promise<void> {
  const ids = ENTRY_MODEL_IDS;
  const secrets = [
    ...ids,
    ...ids.map((id) => id.split("/")[1] ?? id),
    "entryproof",
    OPERATOR_KEY,
    OPERATOR_KEY.slice(0, -4),
    SUSPENSION_CODE,
    e2eEnv.operatorApiToken,
  ];
  for (const [name, text] of texts) {
    for (const secret of secrets)
      expect(around(text, secret), `${where}: ${name} holds ${secret}`).toBe(
        "",
      );
    for (const figure of PRICE_FIGURES)
      expect(
        around(text, figure),
        `${where}: ${name} holds the price ${figure}`,
      ).toBe("");
    if (options.costIsTheOperators === true) continue;
    // A measured cost (the fake reports 0.0001 US dollars with every answer) and an amount of money: a currency sign
    // or a currency code next to a number.
    // The name of a cost field with no figure (`"costUsd":null`, `"costHidden":true`) is no leak; a figure is.
    const cost = MEASURED_COST.exec(text);
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

/** Where `needle` is in `text`, with what is around it, or "" when it is not there (for a failure that shows the place). */
function around(text: string, needle: string): string {
  const at = text.indexOf(needle);
  return at < 0 ? "" : text.slice(Math.max(0, at - 100), at + 100);
}
