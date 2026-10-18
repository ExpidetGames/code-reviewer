// SPDX-License-Identifier: Apache-2.0

// Providers and the model catalog, from the admin portal to a member's run, and what no member may read on the way
// (#435, the last issue of #420). On a new multi-tenant instance with the operator API on, through the real UI and the
// fakes only (the fake GitHub, the fake LLM, and a script that plays the Dynamic runner and the operator's service):
//   - the instance admin saves the operator's key, adds three models in the portal (a draft stays a draft), releases two
//     and sets the default of each kind (T01);
//   - a person who is no admin gets the answer of a path that does not exist for the portal and its data routes (T05);
//   - a managed workspace reviews on the default entry, its Owner picks another entry by name and the review runs with
//     that entry's model on the operator's key; the Dynamic job of the same project is handed out with its entry's
//     model, also on the operator's key (T02);
//   - the admin retires the entry in use: the project says so and the next review stops with neutral copy (T04);
//   - a workspace on its own key picks provider and model for its project and the review runs on its own key and its own
//     model, and the catalog is nowhere in its pages (T03);
//   - a plain Member and the Owner of the managed workspace read no model id and no provider anywhere: the pages and
//     their Next.js payloads, the data routes, what the browser shows, every response it received, the comments on the
//     pull requests, the operator's usage feed and the log of the app, searched for every model id of the catalog (T06).
// The search is checked on texts that must fail it before a clean answer is trusted. The case ids are those of #435.
//
// Not in this journey: a second provider (the app has one adapter and the browser lane runs the production build, which
// has no test-only provider; the keys of two providers are told apart by integration tests, #426-T01), and the Dynamic
// engine itself (it needs root; the privileged lane runs it, e2e/dynamic/). The runner of this journey is the real one
// with the real PR-Agent, for Diff Review.
import { readFileSync } from "node:fs";
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import { changeAdminSetting } from "../helpers/admin-api";
import { e2eEnv } from "../helpers/e2e-env";
import {
  addGithubAccount,
  addGithubInstallation,
  addGithubOrgMember,
  addGithubPullRequest,
  getPullRequestComments,
  joinWorkspace,
  setGithubAppSetupUrl,
  type GithubAccount,
} from "../helpers/github-fake";
import {
  collectViews,
  controlsFor,
  findLeaks,
  forbiddenForMembers,
  recordNetwork,
  renderedViews,
  type Surface,
} from "../helpers/member-scan";
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
import { rawRequest } from "../helpers/raw-request";
import { startRunner, type RunnerProcess } from "../helpers/runner-process";
import {
  dynamicRunnerScript,
  type ClaimedDynamicJob,
  type DynamicRunnerScript,
} from "../helpers/runner-api";
import { deliverPullRequestEvent } from "../helpers/webhooks";

// The managed workspace (M) and the one on its own key (O). Each owns its account, organization, installation and
// repository (ids no other journey uses).
const ownerM: GithubAccount = {
  id: 7720001,
  login: "catalog-owner-m",
  name: "Catalog Owner M",
  email: "catalog-owner-m@example.test",
};
const ownerO: GithubAccount = {
  id: 7720002,
  login: "catalog-owner-o",
  name: "Catalog Owner O",
  email: "catalog-owner-o@example.test",
};
const ORG_M = {
  login: "catalog-org-m",
  id: 7820001,
  type: "Organization",
} as const;
const ORG_O = {
  login: "catalog-org-o",
  id: 7820002,
  type: "Organization",
} as const;
const INSTALLATION_M = 9840001;
const INSTALLATION_O = 9840002;
const REPO_M = { id: 9821001, fullName: "catalog-org-m/widgets" };
const REPO_O = { id: 9821002, fullName: "catalog-org-o/gadgets" };
const OWNER_M_EMAIL = "catalog-m@e2e.test";
const OWNER_O_EMAIL = "catalog-o@e2e.test";
const MEMBER_EMAIL = "catalog-member@e2e.test";

// The operator's key (saved in the admin portal) and the own key of workspace O: dummies that must show up in no page,
// comment or answer of a person. The ids are made up and distinctive, so that a search for them matches nothing else.
const OPERATOR_KEY = "sk-or-v1-e2e-catalog-operator-key-0123456789abcdef-op35";
const OWN_KEY = "sk-or-v1-e2e-catalog-own-key-of-workspace-o-0123456789-ow35";

// The catalog: what members read is the name and the description. The model ids are the operator's.
const ENTRIES = {
  small: {
    name: "Small",
    description: "Quick passes over small changes.",
    model: "e2eproof/m-small-q7w8",
    kinds: ["Diff", "Dynamic"],
  },
  big: {
    name: "Big",
    description: "Careful passes over large changes.",
    model: "e2eproof/m-big-q7w8",
    kinds: ["Diff", "Dynamic"],
  },
  // Stays a draft for the whole journey: no member may read its name, and its model id is searched for as well.
  draft: {
    name: "Hidden draft",
    description: "Not released.",
    model: "e2eproof/m-draft-q7w8",
    kinds: ["Diff"],
  },
} as const;
const CATALOG_MODEL_IDS: string[] = Object.values(ENTRIES).map(
  (entry) => entry.model,
);
// What workspace O chooses for its project: its own model, not an entry of the catalog.
const OWN_MODEL = "ownproof/own-model-k3j4";

const REVIEW_MARKER = "<!-- pr-agent:review:full -->";
// A review through the real PR-Agent takes a few seconds; the first one also loads PR-Agent.
const RUN_TIMEOUT = { timeout: 120_000 };

/** A head commit that is different for every pull request (`variant`). */
const headSha = (variant: string, number: number) =>
  variant + String(number).padStart(39, "0");

test.describe.configure({ mode: "serial" });

test.describe("the catalog from the admin portal to a member's run", () => {
  let llm: FakeLlm | undefined;
  let runner: RunnerProcess | undefined;
  let operator: OperatorClient | undefined;
  let dynamicScript: DynamicRunnerScript | undefined;
  const contexts: BrowserContext[] = [];
  let adminPage: Page | undefined;
  let pageM: Page | undefined;
  let pageO: Page | undefined;
  let memberPage: Page | undefined;
  let slugM = "";
  let slugO = "";
  let workspaceIdM = "";
  let workspaceIdO = "";
  // What the browsers of the Owner and the Member of M received, from the first page on.
  let networkOwner: ReturnType<typeof recordNetwork> | undefined;
  let networkMember: ReturnType<typeof recordNetwork> | undefined;
  // The ids of the entries by name, as the admin portal lists them.
  const entryIds: Record<string, string> = {};

  test.beforeAll(async ({ browser, request }) => {
    test.setTimeout(240_000);
    llm = await startLlmFake({ port: e2eEnv.operatorLlmFakePort });
    registerModels(llm);
    runner = await startRunner({
      appUrl: e2eEnv.catalogAppUrl,
      llmBaseUrl: llm.baseUrl,
    });
    operator = await operatorClient({ baseURL: e2eEnv.catalogAppUrl });
    dynamicScript = await dynamicRunnerScript(e2eEnv.catalogAppUrl);

    await addGithubAccount(request, ownerM, null);
    await addGithubAccount(request, ownerO, null);
    await addGithubInstallation(
      request,
      { id: INSTALLATION_M, account: ORG_M },
      [REPO_M],
    );
    await addGithubInstallation(
      request,
      { id: INSTALLATION_O, account: ORG_O },
      [REPO_O],
    );
    await addGithubOrgMember(request, {
      org: ORG_M.login,
      login: ownerM.login,
      role: "admin",
    });
    await addGithubOrgMember(request, {
      org: ORG_O.login,
      login: ownerO.login,
      role: "admin",
    });
    await setGithubAppSetupUrl(
      request,
      `${e2eEnv.catalogAppUrl}/github/connected`,
    );

    // Two people found two workspaces, connect their installation and switch their repository on, as in the product.
    // The reviews of the first are on the operator's key, the second brings its own: that is the entitlement.
    const m = await founder(
      browser,
      e2eEnv.catalogAppUrl,
      OWNER_M_EMAIL,
      "Catalog M",
    );
    const o = await founder(
      browser,
      e2eEnv.catalogAppUrl,
      OWNER_O_EMAIL,
      "Catalog O",
    );
    pageM = m.page;
    pageO = o.page;
    contexts.push(m.page.context(), o.page.context());
    slugM = m.slug;
    slugO = o.slug;
    networkOwner = recordNetwork(m.page);
    await connectGithub(m.page, slugM, {
      installOn: ORG_M.login,
      authorizeAs: ownerM,
    });
    await connectGithub(o.page, slugO, {
      installOn: ORG_O.login,
      authorizeAs: ownerO,
    });
    await switchRepositoryOn(m.page, slugM, REPO_M.fullName);
    await switchRepositoryOn(o.page, slugO, REPO_O.fullName);

    // A plain Member of M, who reads what a member reads.
    const memberContext = await browser.newContext({
      baseURL: e2eEnv.catalogAppUrl,
    });
    contexts.push(memberContext);
    memberPage = await memberContext.newPage();
    networkMember = recordNetwork(memberPage);
    await signUpAndIn(memberPage, MEMBER_EMAIL);
    await joinWorkspace(memberPage, { email: MEMBER_EMAIL }, "member", slugM);

    // The instance admin, in a browser of their own.
    adminPage = await signInAsAdmin(browser);
    contexts.push(adminPage.context());

    workspaceIdM = await script().workspaceId(slugM);
    workspaceIdO = await script().workspaceId(slugO);
    // Workspace M takes the operator's key; the default entitlements say so for everybody who has none of their own.
    // Workspace O has an entitlement row of its own: its own key.
    await script().putDefaultEntitlements(MANAGED);
    await script().putEntitlements(workspaceIdO, OWN);
  });

  test.beforeEach(() => {
    fakeLlm().reset();
    registerModels(fakeLlm());
  });

  test.afterAll(async () => {
    for (const context of contexts) await context.close();
    await operator?.dispose();
    await dynamicScript?.dispose();
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
  function dynamicRunner(): DynamicRunnerScript {
    if (dynamicScript === undefined)
      throw new Error("The Dynamic runner script was not started.");
    return dynamicScript;
  }
  function pageOf(page: Page | undefined, who: string): Page {
    if (page === undefined) throw new Error(`${who} has no page.`);
    return page;
  }
  const admin = () => pageOf(adminPage, "The admin");
  const ownerOfM = () => pageOf(pageM, "Owner M");
  const ownerOfO = () => pageOf(pageO, "Owner O");
  const member = () => pageOf(memberPage, "The Member");
  function entryId(name: string): string {
    const id = entryIds[name];
    if (id === undefined) throw new Error(`The entry ${name} has no id.`);
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

  /** The webhook GitHub sends when a pull request is opened. */
  async function open(
    request: APIRequestContext,
    which: "M" | "O",
    number: number,
  ): Promise<void> {
    const repository = which === "M" ? REPO_M : REPO_O;
    const org = which === "M" ? ORG_M : ORG_O;
    const installationId = which === "M" ? INSTALLATION_M : INSTALLATION_O;
    const title = `Change number ${String(number)}`;
    const head = headSha(which === "M" ? "1" : "2", number);
    await addGithubPullRequest(request, repository.fullName, {
      number,
      title,
      headSha: head,
    });
    const answer = await deliverPullRequestEvent(request, {
      action: "opened",
      installationId,
      repository: { ...repository, owner: { login: org.login, id: org.id } },
      number,
      title,
      headSha: head,
    });
    expect(answer).toEqual({ status: "accepted", outcome: "trigger_enqueued" });
  }

  const reviewsOf = (comments: Array<{ body: string }>) =>
    comments.filter((comment) => comment.body.includes(REVIEW_MARKER));

  /** The project page of the repository, as an Owner opens it. */
  async function openProject(page: Page, slug: string, repository: string) {
    await page.goto(`/w/${slug}/projects`);
    await page.getByRole("link", { name: repository, exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: repository }),
    ).toBeVisible();
  }

  async function save(page: Page, confirm?: string) {
    await page.getByRole("button", { name: "Save review settings" }).click();
    if (confirm !== undefined)
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: confirm })
        .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();
  }

  /** The catalog as the admin portal's data route lists it (the operator's view: ids, models, providers). */
  async function adminCatalog() {
    const response = await admin().request.get("/api/admin/model-catalog");
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as {
      entries: Array<{
        id: string;
        name: string;
        modelId: string;
        provider: string;
        status: string;
      }>;
      providers: Array<{ id: string; label: string }>;
    };
  }

  // #435-T05
  test("a person who is no admin gets the answer of a path that does not exist for the portal and the catalog routes", async () => {
    const MISSING = "/there-is-no-such-page";
    const paths = [
      "/admin",
      "/admin/llm",
      "/api/admin/model-catalog",
      "/api/admin/model-catalog/defaults",
      "/api/admin/model-catalog/order",
      "/api/admin/model-catalog/check",
      "/api/admin/llm-keys/openrouter/test",
    ];
    for (const page of [ownerOfM(), member()]) {
      // A read of a path that is not there is a 404; what a write gets depends on the method, and is the same for all.
      const missingRead = await rawRequest(
        page,
        e2eEnv.catalogAppUrl,
        MISSING,
        {},
      );
      expect(missingRead.status).toBe(404);
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        const init = initOf(method);
        const expected = await rawRequest(
          page,
          e2eEnv.catalogAppUrl,
          MISSING,
          init,
        );
        for (const path of paths) {
          const answer = await rawRequest(
            page,
            e2eEnv.catalogAppUrl,
            path,
            init,
          );
          expect(answer.status, `${method} ${path}`).toBe(expected.status);
          expect(answer.lines, `${method} ${path}`).toEqual(expected.lines);
          expect(answer.body, `${method} ${path}`).toBe(expected.body);
        }
      }
    }
  });

  // #435-T01
  test("the admin saves the operator's key, adds three models, releases two and sets a default for each kind, all in the portal", async () => {
    test.setTimeout(240_000);
    const page = admin();
    await page.goto("/admin/llm");

    // The operator's key, as the admin enters it: write-only, shown as set afterwards.
    const keyForm = page.getByRole("form", { name: "OpenRouter LLM key" });
    await keyForm.getByLabel("API key").fill(OPERATOR_KEY);
    await keyForm.getByRole("button", { name: "Save key" }).click();
    await expect(
      keyForm.getByText(`A key is saved, ending in ${OPERATOR_KEY.slice(-4)}.`),
    ).toBeVisible();

    // The catalog starts empty and collapsed. Three models are added; each is a draft until it is released.
    await page.getByRole("button", { name: "Show model catalog" }).click();
    await expect(page.getByText("No models yet.")).toBeVisible();
    for (const entry of Object.values(ENTRIES)) {
      await page.getByRole("button", { name: "Add model" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name", { exact: true }).fill(entry.name);
      await dialog.getByLabel("Description").fill(entry.description);
      await dialog.getByLabel("Model id").fill(entry.model);
      for (const kind of entry.kinds)
        await dialog.getByLabel(kind, { exact: true }).check();
      await dialog.getByRole("button", { name: "Check model" }).click();
      await expect(dialog.getByRole("status")).toBeVisible();
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(rowOf(page, entry.name)).toContainText("Draft");
    }
    const draftRows = await adminCatalog();
    expect(draftRows.entries.map((entry) => entry.status)).toEqual([
      "draft",
      "draft",
      "draft",
    ]);
    for (const entry of draftRows.entries) entryIds[entry.name] = entry.id;

    // Released: the provider vouches for the model again, and only then the entry is offered. The third stays a draft.
    for (const entry of [ENTRIES.small, ENTRIES.big]) {
      await page.getByRole("button", { name: `Release ${entry.name}` }).click();
      await expect(rowOf(page, entry.name)).toContainText("Released");
    }
    await expect(rowOf(page, ENTRIES.draft.name)).toContainText("Draft");

    // The default of each kind: a released entry only (a draft has no button).
    await expect(
      page.getByRole("button", {
        name: `${ENTRIES.draft.name}: default for Diff`,
      }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: `${ENTRIES.small.name}: default for Diff` })
      .click();
    await expect(page.getByText("Default for Diff: Small")).toBeVisible();
    await page
      .getByRole("button", { name: `${ENTRIES.big.name}: default for Dynamic` })
      .click();
    await expect(page.getByText("Default for Dynamic: Big")).toBeVisible();

    // The portal lists what it was given, and a reload shows the same.
    await page.reload();
    // With entries in it the catalog is open.
    await expect(page.getByText("Default for Diff: Small")).toBeVisible();
    await expect(page.getByText("Default for Dynamic: Big")).toBeVisible();
    const catalog = await adminCatalog();
    expect(
      catalog.entries
        .map((entry) => [entry.name, entry.modelId, entry.status])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ).toEqual([
      [ENTRIES.big.name, ENTRIES.big.model, "released"],
      [ENTRIES.draft.name, ENTRIES.draft.model, "draft"],
      [ENTRIES.small.name, ENTRIES.small.model, "released"],
    ]);
  });

  // #435-T02
  test("a project that chose nothing is reviewed on the default entry, with the operator's key", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const page = ownerOfM();
    await openRuns(page, slugM);
    await open(request, "M", 1);
    await expect(
      runsOf(page, REPO_M.fullName, 1).locator("[data-status]"),
    ).toContainText("Succeeded", RUN_TIMEOUT);

    expect(reviewsOf(await commentsOf(request, REPO_M, 1))).toHaveLength(1);
    const asked = fakeLlm().requests();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.authorization).toBe(`Bearer ${OPERATOR_KEY}`);
    expect(asked[0]?.model).toContain(ENTRIES.small.model);
    expect(runnerOutput()).not.toContain(OPERATOR_KEY.slice(0, -4));
  });

  // #435-T02
  test("an Owner picks an entry by its name and the next review runs with that entry's model on the operator's key", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const page = ownerOfM();
    await openProject(page, slugM, REPO_M.fullName);
    const diffChoice = page.locator('[data-field="catalogEntryDiff"]');
    // Released entries by name and description, in the order of the catalog; the draft is not offered.
    await expect(diffChoice.locator("[data-entry]")).toHaveCount(2);
    await expect(diffChoice).toContainText(ENTRIES.small.description);
    await expect(diffChoice).toContainText(ENTRIES.big.description);
    await expect(diffChoice).not.toContainText(ENTRIES.draft.name);
    await expect(diffChoice).toContainText("Default of this instance");
    await diffChoice.getByRole("radio", { name: /^Big/ }).click();
    await save(page);
    await page.reload();
    await expect(
      page
        .locator('[data-field="catalogEntryDiff"]')
        .getByRole("radio", { name: /^Big/ }),
    ).toBeChecked();

    await openRuns(page, slugM);
    await open(request, "M", 2);
    await expect(
      runsOf(page, REPO_M.fullName, 2).locator("[data-status]"),
    ).toContainText("Succeeded", RUN_TIMEOUT);
    expect(reviewsOf(await commentsOf(request, REPO_M, 2))).toHaveLength(1);
    const asked = fakeLlm().requests();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.authorization).toBe(`Bearer ${OPERATOR_KEY}`);
    expect(asked[0]?.model).toContain(ENTRIES.big.model);
    expect(asked[0]?.model).not.toContain(ENTRIES.small.model);
  });

  // #435-T02
  test("the Dynamic Review of the project is handed out with the model of the entry the Owner picked for it, on the operator's key", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    await changeAdminSetting(e2eEnv.catalogAppUrl, {
      dynamicReview: { enabled: true },
    });
    const page = ownerOfM();
    await openProject(page, slugM, REPO_M.fullName);
    await page.getByRole("radio", { name: "Dynamic Review" }).click();
    const dynamicChoice = page.locator('[data-field="catalogEntryDynamic"]');
    await expect(dynamicChoice.locator("[data-entry]")).toHaveCount(2);
    // The instance default of Dynamic Review is Big; the Owner picks the other entry.
    await dynamicChoice.getByRole("radio", { name: /^Small/ }).click();
    await save(page, "Switch to Dynamic Review");

    await open(request, "M", 3);
    const job = await claimDynamicJob(dynamicRunner());
    expect(job.llm.apiKey).toBe(OPERATOR_KEY);
    expect(job.llm.model).toContain(ENTRIES.small.model);
    expect(job.dynamic.model).toContain(ENTRIES.small.model);
    expect(job.dynamic.model).not.toContain(ENTRIES.big.model);
    await dynamicRunner().complete(job, { model: job.dynamic.model });
    await openRuns(page, slugM);
    await expect(
      runsOf(page, REPO_M.fullName, 3).locator("[data-status]"),
    ).toContainText("Succeeded", RUN_TIMEOUT);
    expect(fakeLlm().requests()).toHaveLength(0);

    // The project is a Diff Review project again for the cases that follow.
    await openProject(page, slugM, REPO_M.fullName);
    await page.getByRole("radio", { name: "Diff Review" }).click();
    await save(page, "Switch to Diff Review");
  });

  // #435-T04
  test("the admin retires the entry in use: the project says so and the next review stops with copy for a member, without any model call", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    // Big is the default of Dynamic Review: it has to stop being one before it can be retired, as the portal says.
    const portal = admin();
    await portal.goto("/admin/llm");
    await portal
      .getByRole("button", { name: `${ENTRIES.big.name}: default for Dynamic` })
      .click();
    await expect(portal.getByText("Default for Dynamic: none")).toBeVisible();
    await portal
      .getByRole("button", { name: `Retire ${ENTRIES.big.name}` })
      .click();
    // The confirmation tells how many projects use it now.
    await expect(portal.getByRole("alertdialog")).toContainText("1 project");
    await portal
      .getByRole("alertdialog")
      .getByRole("button", { name: "Retire", exact: true })
      .click();
    await expect(rowOf(portal, ENTRIES.big.name)).toContainText("Retired");

    const page = ownerOfM();
    await openProject(page, slugM, REPO_M.fullName);
    const retiredEntry = page
      .locator('[data-field="catalogEntryDiff"]')
      .locator(`[data-entry="${entryId(ENTRIES.big.name)}"]`);
    await expect(retiredEntry).toContainText("No longer available");
    await expect(page.locator("[data-choice-unavailable]")).toBeVisible();

    await openRuns(page, slugM);
    await open(request, "M", 4);
    const refused = runsOf(page, REPO_M.fullName, 4);
    await expect(refused.locator("[data-status]")).toContainText(
      "Failed",
      RUN_TIMEOUT,
    );
    await refused.getByRole("link", { name: `${REPO_M.fullName} #4` }).click();
    await expect(
      page
        .locator('[data-slot="run-detail"]')
        .filter({ visible: true })
        .getByText(/review option chosen for this project is not available/),
    ).toBeVisible();
    // No move to another entry, and no call to any model.
    expect(fakeLlm().requests()).toHaveLength(0);
    expect(await commentsOf(request, REPO_M, 4)).toEqual([]);
  });

  // #435-T03
  test("a workspace on its own key picks provider and model for its project and the review runs on its own key and model", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const page = ownerOfO();
    // The Owner enters the key of the workspace, as the form of the LLM access does it.
    await page.goto(`/w/${slugO}/settings/llm`);
    const form = page.getByRole("form", { name: "OpenRouter LLM key" });
    await form.getByLabel("API key").fill(OWN_KEY);
    await form.getByRole("button", { name: "Save key" }).click();
    await expect(
      form.getByText(`A key is saved (ends in ${OWN_KEY.slice(-4)})`),
    ).toBeVisible();

    // The project chooses a provider and a model, not an entry: the catalog is nowhere on the page.
    await openProject(page, slugO, REPO_O.fullName);
    await expect(page.locator('[data-field="catalogEntryDiff"]')).toHaveCount(
      0,
    );
    const provider = page.getByRole("combobox", {
      name: "Provider",
      exact: true,
    });
    await provider.click();
    await page.getByRole("option", { name: /^OpenRouter/ }).click();
    await page.getByLabel("Model", { exact: true }).fill(OWN_MODEL);
    await save(page);
    await page.reload();
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue(
      OWN_MODEL,
    );

    await openRuns(page, slugO);
    await open(request, "O", 1);
    await expect(
      runsOf(page, REPO_O.fullName, 1).locator("[data-status]"),
    ).toContainText("Succeeded", RUN_TIMEOUT);
    const asked = fakeLlm().requests();
    expect(asked).toHaveLength(1);
    // Its own key and its own model: not the operator's key, and no model of the catalog.
    expect(asked[0]?.authorization).toBe(`Bearer ${OWN_KEY}`);
    expect(asked[0]?.model).toContain(OWN_MODEL);
    for (const id of CATALOG_MODEL_IDS)
      expect(asked[0]?.model).not.toContain(id);
    expect(reviewsOf(await commentsOf(request, REPO_O, 1))).toHaveLength(1);

    // The catalog is not read for it: the pages of workspace O hold neither a model of the catalog nor the operator's key.
    const leaks = findLeaks(
      [
        ...(await collectViews(page, slugO)),
        ...(await commentsOf(request, REPO_O, 1)).map((comment) => ({
          name: "a comment on a pull request of workspace O",
          text: comment.body,
        })),
      ],
      forbiddenForMembers({
        modelIds: CATALOG_MODEL_IDS,
        providerIds: [],
        providerLabels: [],
        secrets: [{ label: "the operator's key", value: OPERATOR_KEY }],
      }),
    );
    expect(leaks).toEqual([]);
  });

  // #435-T06
  test("the search for models and providers finds every kind of thing it looks for, and passes a page with none of them", async () => {
    const catalog = await adminCatalog();
    const forbidden = forbiddenForMembers(membersLook(catalog));
    for (const control of controlsFor(forbidden))
      expect(
        findLeaks([{ name: control.name, text: control.text }], forbidden)
          .length > 0,
        control.name,
      ).toBe(control.leaks);
  });

  // #435-T06
  test("a Member and the Owner of the managed workspace read no model id and no provider anywhere, and no draft", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const catalog = await adminCatalog();
    // The ids the portal lists are those the journey made: nothing was added that the search does not look for.
    expect(catalog.entries.map((entry) => entry.modelId).sort()).toEqual(
      [...CATALOG_MODEL_IDS].sort(),
    );
    const forbidden = [
      ...forbiddenForMembers(membersLook(catalog)),
      // A draft is not offered, so its name is nowhere either.
      { label: "the name of a draft", needle: ENTRIES.draft.name },
    ];

    const surfaces: Surface[] = [];
    for (const [who, page] of [
      ["Member", member()],
      ["Owner", ownerOfM()],
    ] as const) {
      const views = await collectViews(page, slugM);
      const runs = JSON.parse(
        views.find(({ name }) => name === `/api/w/${slugM}/runs`)?.text ?? "{}",
      ) as { runs?: Array<{ id: string }> };
      // Runs of every outcome: reviewed, handed out as Dynamic and refused for the retirement.
      expect(runs.runs?.length ?? 0).toBeGreaterThanOrEqual(4);
      const rendered = await renderedViews(
        page,
        slugM,
        String(runs.runs?.[0]?.id),
      );
      for (const surface of [...views, ...rendered])
        surfaces.push({ name: `${who}: ${surface.name}`, text: surface.text });
    }
    for (const [who, recorder] of [
      ["Owner", networkOwner],
      ["Member", networkMember],
    ] as const) {
      const { surfaces: responses, unread } = await (recorder?.stop() ??
        Promise.resolve({ surfaces: [], unread: [] }));
      expect(responses.length, `${who}'s responses`).toBeGreaterThan(20);
      // The bodies the browser dropped are the prefetches of pages (the pages themselves are read above), and the answers
      // to a save, which the settings read back (also above).
      expect(
        unread.filter(
          ({ method, path }) =>
            !(method === "GET" && path.includes("_rsc=")) &&
            !(method !== "GET" && path.startsWith(`/api/w/${slugM}/`)),
        ),
        `${who}'s responses that were not read`,
      ).toEqual([]);
      for (const surface of responses)
        surfaces.push({
          name: `${who}: ${surface.name}`,
          text: surface.text,
        });
    }
    for (const [repo, numbers] of [
      [REPO_M, [1, 2, 3, 4]],
      [REPO_O, [1]],
    ] as const)
      for (const number of numbers)
        for (const comment of await commentsOf(request, repo, number))
          surfaces.push({
            name: `a comment on pull request ${String(number)} of ${repo.fullName}`,
            text: comment.body,
          });
    // The logs of the app and of the runner are the operator's side and name the models they work with; what no log may
    // hold is the operator's key, so the lines that carry (any part of) it are searched with the rest.
    const keyLines = (text: string) =>
      text
        .split("\n")
        .filter((line) => line.includes(OPERATOR_KEY.slice(0, -4)))
        .join("\n");
    surfaces.push({
      name: "the log of the app",
      text: keyLines(readFileSync(e2eEnv.logFiles.catalog, "utf8")),
    });
    surfaces.push({
      name: "the output of the runner",
      text: keyLines(runnerOutput()),
    });

    expect(findLeaks(surfaces, forbidden)).toEqual([]);
  });

  // #435-T06
  test("the usage feed names the entry and its id for the managed runs and no model and no provider", async () => {
    test.setTimeout(240_000);
    const records = await pollUsage(script(), workspaceIdM, 3);
    expect(
      records.map((record) => [
        record.reviewKind,
        record.keyMode,
        record.catalogEntryName,
      ]),
    ).toEqual([
      ["diff", "managed", ENTRIES.small.name],
      ["diff", "managed", ENTRIES.big.name],
      ["dynamic", "managed", ENTRIES.small.name],
    ]);
    expect(records.map((record) => record.catalogEntryId)).toEqual([
      entryId(ENTRIES.small.name),
      entryId(ENTRIES.big.name),
      entryId(ENTRIES.small.name),
    ]);
    const forbidden = forbiddenForMembers(membersLook(await adminCatalog()));
    expect(
      findLeaks(
        [{ name: "the usage feed", text: JSON.stringify(records) }],
        forbidden,
      ),
    ).toEqual([]);
    // The own workspace has no entry in its records.
    const own = await pollUsage(script(), workspaceIdO, 1);
    expect(
      own.map((record) => [record.keyMode, record.catalogEntryId]),
    ).toEqual([["own", null]]);
  });
});

const MANAGED = {
  planLabel: "e2e-managed-plan",
  keyMode: "managed",
  limits: {
    diffRunsPerPeriod: null,
    dynamicRunsPerPeriod: null,
    managedCostLimitMicroUsd: null,
    ownKeyCostLimitMicroUsd: null,
  },
  suspended: false,
  suspensionCode: null,
} as const;

const OWN = {
  ...MANAGED,
  planLabel: "e2e-own-key-plan",
  keyMode: "own",
} as const;

/** What the fake LLM says about the models of the catalog: tools, parameters, window and price. */
function registerModels(llm: FakeLlm): void {
  for (const id of CATALOG_MODEL_IDS)
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
        pricing: { prompt: "0.0000007319", completion: "0.0000029173" },
        supports_tool_choice: { required: true },
      },
    ]);
}

/** What no member may read, from the catalog the portal lists and the keys the journey made. */
function membersLook(catalog: {
  entries: Array<{ modelId: string }>;
  providers: Array<{ id: string; label: string }>;
}) {
  return {
    modelIds: [
      ...new Set([
        ...catalog.entries.map((entry) => entry.modelId),
        ...CATALOG_MODEL_IDS,
      ]),
    ],
    providerIds: catalog.providers.map((provider) => provider.id),
    providerLabels: catalog.providers.map((provider) => provider.label),
    secrets: [{ label: "the operator's key", value: OPERATOR_KEY }],
  };
}

function rowOf(page: Page, name: string) {
  return page
    .getByRole("row")
    .filter({ has: page.getByText(name, { exact: true }) });
}

async function commentsOf(
  request: APIRequestContext,
  repository: { fullName: string },
  number: number,
) {
  return getPullRequestComments(request, repository.fullName, number);
}

async function signInAsAdmin(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: e2eEnv.catalogAppUrl });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
  await page.getByLabel("Password").fill(e2eEnv.adminPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  return page;
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

/** Claims the Dynamic job as the runner would, once the webhook has made it. */
async function claimDynamicJob(
  runner: DynamicRunnerScript,
): Promise<ClaimedDynamicJob> {
  let claimed: ClaimedDynamicJob | null = null;
  await expect
    .poll(
      async () => {
        claimed = await runner.claim();
        return claimed !== null;
      },
      { timeout: 60_000, intervals: [500, 1_000] },
    )
    .toBe(true);
  if (claimed === null) throw new Error("No Dynamic job was handed out.");
  return claimed;
}

/** What a request of one method carries: a body for the writes. */
function initOf(method: string) {
  return method === "GET"
    ? {}
    : {
        method,
        headers: { "content-type": "application/json" },
        body: "{}",
      };
}
