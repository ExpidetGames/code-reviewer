// SPDX-License-Identifier: LicenseRef-Proprietary

// Providers and the model catalog, from the admin portal to a member's run, and what no member may read on the way
// (#435, the last issue of #420). On a new multi-tenant instance with the operator API on, through the real UI and the
// fakes only (the fake GitHub, the fake LLM, and a script that plays the Dynamic runner and the operator's service):
//   - a person who is no admin gets the answer of a path that does not exist for the portal and its data routes (T05);
//   - the instance admin saves the operator's key, adds three models in the portal (a draft stays a draft), releases two
//     and sets the default of each kind (T01);
//   - a managed workspace reviews on the default entry (T02); its Owner reads an Advanced page (the deletion of the workspace) and the LLM access page that name no provider;
//     the Owner picks another entry by name and the review runs with that entry's model on the operator's key; the
//     Dynamic job of the same project is handed out with its entry's model, also on the operator's key (T02);
//   - the provider answers with an error that names the model, the provider and the operator's key: nothing of it reaches
//     the workspace (T06);
//   - the admin retires the entry in use: the project says so and the next review stops with neutral copy (T04);
//   - an Owner and a Member send the API choices the page never offers (a draft, a retired, an unknown entry, a raw
//     model): each is refused and nothing changes (T06);
//   - a workspace on its own key picks provider and model for its project and the review runs on its own key and its own
//     model, and the catalog is nowhere in its pages (T03);
//   - the Owner and a plain Member of the managed workspace read no model id and no provider anywhere: every route of
//     the app they can read, the pages in their browsers, every response those browsers received, the comments on the
//     pull requests and the logs, searched for every model id of the catalog in every form (T06).
// The search is proven before its clean answer is trusted: leaks planted in realistic shapes must fail it, an admin
// surface that holds the ids must fail it through every collector, and a collector that is not signed in fails the run.
// The case ids are those of #435.
//
// `@smoke` is the cheap slice that pull requests run: the portal gate, the catalog, one managed review, the Advanced
// page and the whole privacy search over what that review left. The rest runs in the full lane.
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
  browse,
  expectSignedIn,
  findLeaks,
  forbiddenFor,
  formsOf,
  readAs,
  recordNetwork,
  type Forbidden,
  type NetworkRecorder,
  type Surface,
} from "../helpers/member-scan";
import { cleanTexts, plantedLeaks } from "../helpers/member-scan-proof";
import {
  browseRoutes,
  expectRecorded,
  idsOf,
  readRoutes,
} from "../helpers/member-surfaces";
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
import { chooseOption, openSection } from "../helpers/settings-form";
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
// comment or answer of a person, in no form. The ids are made up and distinctive, so that a search for them matches
// nothing else.
const OPERATOR_KEY = "sk-or-v1-e2e-catalog-operator-key-0123456789abcdef-op35";
const OWN_KEY = "sk-or-v1-e2e-catalog-own-key-of-workspace-o-0123456789-ow35";

// The catalog: what members read is the name and the description. The model ids are the operator's. They carry a dot
// and a variant after a colon, as real ids do, so that an encoding of them is not the id.
const ENTRIES = {
  small: {
    name: "Small",
    description: "Quick passes over small changes.",
    model: "acme-labs/e2eproof-m-small-q7w8.5:beta",
    kinds: ["Diff", "Dynamic"],
  },
  big: {
    name: "Big",
    description: "Careful passes over large changes.",
    model: "acme-labs/e2eproof-m-big-q7w8.5:beta",
    kinds: ["Diff", "Dynamic"],
  },
  // Stays a draft for the whole journey: no member may read its name, and its model id is searched for as well.
  draft: {
    name: "Hidden draft",
    description: "Not released.",
    model: "acme-labs/e2eproof-m-draft-q7w8.5:beta",
    kinds: ["Diff"],
  },
} as const;
const CATALOG_MODEL_IDS: string[] = Object.values(ENTRIES).map(
  (entry) => entry.model,
);
// What workspace O chooses for its project: its own model, not an entry of the catalog.
// A model of the list the dropdown offers for the provider: a workspace on its own key cannot type one (#656).
const OWN_MODEL = "openai/gpt-5.4-mini";
const UNKNOWN_ENTRY = "00000000-0000-4000-8000-000000000000";

const REVIEW_MARKER = "<!-- pr-agent:review:full -->";
// A review through the real PR-Agent takes a few seconds; the first one also loads PR-Agent.
const RUN_TIMEOUT = { timeout: 120_000 };

/** A head commit that is different for every pull request (`variant`). */
const headSha = (variant: string, number: number) =>
  variant + String(number).padStart(39, "0");

type Catalog = {
  entries: Array<{
    id: string;
    name: string;
    modelId: string;
    provider: string;
    status: string;
  }>;
  providers: Array<{ id: string; label: string }>;
};

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
  // What the browsers of the Owner and the Member of M receive from the moment the workspace is managed.
  let networkOwner: NetworkRecorder | undefined;
  let networkMember: NetworkRecorder | undefined;
  // The ids of the entries by name, as the admin portal lists them.
  const entryIds: Record<string, string> = {};
  // The pull requests the journey opened, to read the comments on all of them.
  const opened: Array<{ which: "M" | "O"; number: number }> = [];

  test.beforeAll(async ({ browser, request }) => {
    test.setTimeout(240_000);
    llm = await startLlmFake({ port: e2eEnv.catalogLlmFakePort });
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

    // A person founds a workspace, connects their installation and switches their repository on, as in the product.
    // The reviews of this one are on the operator's key (the entitlement is set below).
    const m = await founder(
      browser,
      e2eEnv.catalogAppUrl,
      OWNER_M_EMAIL,
      "Catalog M",
    );
    pageM = m.page;
    contexts.push(m.page.context());
    slugM = m.slug;
    await connectGithub(m.page, slugM, {
      installOn: ORG_M.login,
      authorizeAs: ownerM,
    });
    await switchRepositoryOn(m.page, slugM, REPO_M.fullName);

    // A plain Member of M, who reads what a member reads.
    const memberContext = await browser.newContext({
      baseURL: e2eEnv.catalogAppUrl,
    });
    contexts.push(memberContext);
    memberPage = await memberContext.newPage();
    await signUpAndIn(memberPage, MEMBER_EMAIL);
    await joinWorkspace(memberPage, { email: MEMBER_EMAIL }, "member", slugM);

    // The instance admin, in a browser of their own.
    adminPage = await signInAsAdmin(browser);
    contexts.push(adminPage.context());

    workspaceIdM = await script().workspaceId(slugM);
    // Workspace M takes the operator's key; the default entitlements say so for everybody who has none of their own.
    await script().putDefaultEntitlements(MANAGED);

    // From here on the workspace is managed: every answer the browsers of its Owner and its Member receive is kept.
    networkOwner = await recordNetwork(m.page.context());
    networkMember = await recordNetwork(memberContext);
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
    opened.push({ which, number });
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
  async function adminCatalog(): Promise<Catalog> {
    const response = await admin().request.get("/api/admin/model-catalog");
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as Catalog;
  }

  /** What no member of the managed workspace may read, from the catalog the portal lists and the keys of the journey. */
  async function forbiddenForM(): Promise<Forbidden[]> {
    return forbiddenFor(membersLook(await adminCatalog()));
  }

  /** The comments the app wrote on every pull request the journey opened (a failed run leaves its words there too). */
  async function allComments(request: APIRequestContext): Promise<Surface[]> {
    const surfaces: Surface[] = [];
    for (const { which, number } of opened) {
      const repository = which === "M" ? REPO_M : REPO_O;
      for (const comment of await commentsOf(request, repository, number))
        surfaces.push({
          name: `a comment on pull request ${String(number)} of ${repository.fullName}`,
          text: comment.body,
        });
    }
    return surfaces;
  }

  /**
   * The run page as the Owner opens it for a run that fails. The Runs list stays mounted (hidden) behind the run page,
   * so every assertion is scoped to the visible detail.
   */
  async function openFailedRun(page: Page, number: number) {
    const row = runsOf(page, REPO_M.fullName, number);
    await expect(row.locator("[data-status]")).toContainText(
      "Failed",
      RUN_TIMEOUT,
    );
    await row
      .getByRole("link", { name: `${REPO_M.fullName} #${String(number)}` })
      .click();
    const detail = page
      .locator('[data-slot="run-detail"]')
      .filter({ visible: true });
    await expect(detail).toBeVisible();
    // The words of this run, read now: the locator follows whichever run page is open next.
    await expect(detail).toContainText("Failed");
    return { detail, text: await detail.innerText() };
  }

  // #435-T05
  test("@smoke a person who is no admin gets the answer of a path that does not exist for the portal and the catalog routes", async () => {
    const MISSING = "/there-is-no-such-page";
    const paths = [
      "/admin",
      "/admin/llm",
      "/api/admin/settings",
      "/api/admin/model-catalog",
      "/api/admin/model-catalog/defaults",
      "/api/admin/model-catalog/order",
      "/api/admin/model-catalog/check",
      "/api/admin/model-catalog/no-such-entry",
      "/api/admin/model-catalog/no-such-entry/release",
      "/api/admin/model-catalog/no-such-entry/retire",
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
  test("@smoke the admin saves the operator's key, adds three models, releases two and sets a default for each kind, all in the portal", async () => {
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
  test("@smoke a project that chose nothing is reviewed on the default entry, with the operator's key", async ({
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
    expect(runnerOutput()).not.toContain(OPERATOR_KEY);
  });

  // #435-T06, #658-T02
  test("@smoke the Advanced and LLM pages of the Owner of a managed workspace name no provider", async () => {
    const page = ownerOfM();
    const catalog = await adminCatalog();
    const providers = forbiddenFor({
      modelIds: [],
      providerIds: catalog.providers.map((provider) => provider.id),
      providerLabels: catalog.providers.map((provider) => provider.label),
      keys: [],
    });
    const surfaces: Surface[] = [];
    for (const [path, title, check] of [
      // The Owner's Advanced page holds the deletion of the workspace and nothing about keys or defaults.
      [
        `/w/${slugM}/settings/advanced`,
        "Settings · Advanced",
        () =>
          expect(
            page.getByRole("button", { name: "Delete workspace…" }),
          ).toBeVisible(),
      ],
      [
        `/w/${slugM}/settings/llm`,
        "Settings · LLM",
        () =>
          expect(
            page.getByRole("button", { name: /Remove .*key/ }),
          ).toHaveCount(0),
      ],
    ] as const) {
      surfaces.push(
        ...(await readAs(page, path, { marker: title })).surfaces,
        ...(
          await readAs(page, path, {
            headers: { RSC: "1" },
            marker: slugM,
            label: `${path} (RSC payload)`,
          })
        ).surfaces,
        ...(await browse(page, path, { title })),
      );
      await check();
    }
    expect(findLeaks(surfaces, providers)).toEqual([]);
  });

  // #435-T02
  test("an Owner picks an entry by its name and the next review runs with that entry's model on the operator's key", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const page = ownerOfM();
    await openProject(page, slugM, REPO_M.fullName);
    await openSection(page, "LLM");
    // Nothing is chosen yet. The provider dropdown names the maker of the released entries, never the product, next to the
    // default; the draft's is not offered. This instance never switches billing on, and nothing is billed while it is off, so
    // the note of who bills is not there (the unit tests of the LLM fieldset hold the note while billing is on).
    const provider = page.getByRole("combobox", {
      name: "Provider",
      exact: true,
    });
    await expect(provider).toHaveText("Default");
    await expect(page.getByText("Billed via code-review.com")).toHaveCount(0);
    await provider.click();
    await expect(page.getByRole("option")).toHaveCount(2);
    await expect(page.getByRole("option", { name: "Default" })).toBeVisible();
    await page.getByRole("option", { name: "Acme Labs" }).click();
    await expect(provider).toHaveText("Acme Labs");
    // Released entries of that provider by name, in the order of the catalog; the draft is not offered.
    await page.getByRole("combobox", { name: "Model" }).click();
    await expect(page.getByRole("option")).toHaveCount(2);
    await expect(
      page.getByRole("option", { name: ENTRIES.small.name }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: ENTRIES.big.name }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: ENTRIES.draft.name }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await chooseOption(page, "Model", /^Big/);
    await save(page);
    await page.reload();
    await openSection(page, "LLM");
    await expect(page.getByRole("combobox", { name: "Model" })).toContainText(
      "Big",
    );

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
    await openSection(page, "LLM");
    await chooseOption(page, "Provider", "Acme Labs");
    await page.getByRole("combobox", { name: "Model" }).click();
    await expect(page.getByRole("option")).toHaveCount(2);
    await page.keyboard.press("Escape");
    // The default of Dynamic Review is Big; the Owner picks the other entry.
    await chooseOption(page, "Model", /^Small/);
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

  // #435-T06
  test("a provider error that names the model, the provider and the key reaches the workspace as neutral copy", async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const page = ownerOfM();
    await openRuns(page, slugM);

    // The provider says which model it could not find, and who it is.
    fakeLlm().failWith({
      status: 404,
      message: `OpenRouter: the model ${ENTRIES.big.model} does not exist (openrouter/${ENTRIES.big.model})`,
    });
    await open(request, "M", 4);
    const notFound = (await openFailedRun(page, 4)).text;
    expect(fakeLlm().requests().length).toBeGreaterThan(0);
    expect(reviewsOf(await commentsOf(request, REPO_M, 4))).toHaveLength(0);

    // The provider answers a rejected key by quoting it.
    fakeLlm().reset();
    registerModels(fakeLlm());
    fakeLlm().failWith({ status: 401, message: "No auth credentials found" });
    fakeLlm().quoteKeyInErrors(true);
    await openRuns(page, slugM);
    await open(request, "M", 5);
    const rejected = (await openFailedRun(page, 5)).text;
    expect(reviewsOf(await commentsOf(request, REPO_M, 5))).toHaveLength(0);

    // What the details say, in the words of the app. The model and the provider are nowhere in them.
    const forbidden = await forbiddenForM();
    for (const [name, text] of [
      ["the model could not be found", notFound],
      ["the key was rejected", rejected],
    ] as const) {
      expect(text, name).toMatch(/failed/i);
      expect(
        findLeaks([{ name: `the run detail (${name})`, text }], forbidden),
      ).toEqual([]);
    }
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
    await openSection(page, "LLM");
    await expect(page.getByRole("combobox", { name: "Model" })).toContainText(
      `${ENTRIES.big.name} (No longer available)`,
    );
    await expect(page.locator("[data-choice-unavailable]")).toBeVisible();

    await openRuns(page, slugM);
    await open(request, "M", 6);
    const { detail } = await openFailedRun(page, 6);
    await expect(
      detail.getByText(
        /review option chosen for this project is not available/,
      ),
    ).toBeVisible();
    // No move to another entry, and no call to any model.
    expect(fakeLlm().requests()).toHaveLength(0);
    expect(await commentsOf(request, REPO_M, 6)).toEqual([]);
  });

  // #435-T06
  test("an Owner and a Member who send a choice the page never offers are refused, and nothing changes or leaks", async () => {
    const forbidden = await forbiddenForM();
    const ids = await idsOf(ownerOfM(), slugM);
    const settingsPath = `/api/w/${slugM}/repositories/${ids.repositoryId}/project/settings`;
    const globalPath = `/api/w/${slugM}/review-settings`;
    const attempts = [
      {
        name: "an entry that is a draft",
        path: settingsPath,
        settings: { catalogEntryDiff: entryId(ENTRIES.draft.name) },
      },
      {
        name: "an entry that was retired",
        path: settingsPath,
        settings: { catalogEntryDiff: entryId(ENTRIES.big.name) },
      },
      {
        name: "an entry nobody made",
        path: settingsPath,
        settings: { catalogEntryDynamic: UNKNOWN_ENTRY },
      },
      {
        name: "a draft for Dynamic Review",
        path: settingsPath,
        settings: { catalogEntryDynamic: entryId(ENTRIES.draft.name) },
      },
      {
        name: "a provider and a model of their own",
        path: settingsPath,
        settings: { provider: "openrouter", model: "attacker/own-model" },
      },
      {
        name: "a model for Dynamic Review",
        path: settingsPath,
        settings: {
          dynamicProvider: "openrouter",
          dynamicModel: "attacker/own-model",
        },
      },
      {
        name: "a model in the defaults of the workspace",
        path: globalPath,
        settings: { provider: "openrouter", model: "attacker/own-model" },
      },
    ];
    const answers: Surface[] = [];
    for (const [who, page] of [
      ["Owner", ownerOfM()],
      ["Member", member()],
    ] as const) {
      const before = await readAs(page, settingsPath, {
        marker: "catalogSelection",
      });
      const globalBefore = await readAs(page, globalPath, { marker: "{" });
      for (const attempt of attempts) {
        const response = await page.request.put(attempt.path, {
          data: { settings: attempt.settings },
        });
        const text = await response.text();
        answers.push({ name: `${who}: ${attempt.name}`, text });
        expect(
          response.status(),
          `${who}: ${attempt.name} answered ${text.slice(0, 200)}`,
        ).toBeGreaterThanOrEqual(400);
        expect(response.status()).toBeLessThan(500);
        // The choice in force is the one it was.
        expect((await readAs(page, settingsPath)).text).toBe(before.text);
        expect((await readAs(page, globalPath)).text).toBe(globalBefore.text);
      }
      // The key tests of a managed workspace say nothing about a provider either.
      for (const path of [
        `/api/w/${slugM}/llm-key/test`,
        `/api/w/${slugM}/llm-keys/openrouter/test`,
      ]) {
        const response = await page.request.post(path, { data: {} });
        answers.push({
          name: `${who}: POST ${path}`,
          text: await response.text(),
        });
        expect(response.status(), path).toBeLessThan(500);
      }
    }
    expect(findLeaks(answers, forbidden)).toEqual([]);
  });

  test.describe("a workspace on its own key", () => {
    test.beforeAll(async ({ browser }) => {
      test.setTimeout(240_000);
      const o = await founder(
        browser,
        e2eEnv.catalogAppUrl,
        OWNER_O_EMAIL,
        "Catalog O",
      );
      pageO = o.page;
      contexts.push(o.page.context());
      slugO = o.slug;
      await connectGithub(o.page, slugO, {
        installOn: ORG_O.login,
        authorizeAs: ownerO,
      });
      await switchRepositoryOn(o.page, slugO, REPO_O.fullName);
      workspaceIdO = await script().workspaceId(slugO);
      // Workspace O has an entitlement row of its own: its own key.
      await script().putEntitlements(workspaceIdO, OWN);
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
      // The project was switched on before the workspace had a key, so a Dynamic review could not have run on it: it starts as
      // a Diff Review (#656-T02); this review is a Diff Review.
      await expect(
        page.getByRole("radio", { name: "Diff Review" }),
      ).toBeChecked();
      await openSection(page, "LLM");
      await expect(page.locator('[data-field="catalogEntryDiff"]')).toHaveCount(
        0,
      );
      const provider = page.getByRole("combobox", {
        name: "Provider",
        exact: true,
      });
      await provider.click();
      await page.getByRole("option", { name: /^OpenRouter/ }).click();
      await chooseOption(page, "Model", OWN_MODEL);
      await save(page);
      await page.reload();
      await openSection(page, "LLM");
      await expect(page.getByRole("combobox", { name: "Model" })).toHaveText(
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

      // The catalog is not read for it: its pages hold no model of the catalog, not the operator's key, and not its
      // own key, which is write-only (the provider is its own and may be named).
      const ids = await idsOf(page, slugO);
      const read = await readRoutes(page, slugO, ids);
      const browsed = await browseRoutes(page, slugO, ids);
      const catalog = await adminCatalog();
      const leaks = findLeaks(
        [
          ...read.surfaces,
          ...browsed.surfaces,
          ...(await allComments(request)).filter(({ name }) =>
            name.includes(REPO_O.fullName),
          ),
        ],
        forbiddenFor({
          modelIds: catalog.entries.map((entry) => entry.modelId),
          providerIds: [],
          providerLabels: [],
          keys: [
            { label: "the operator's key", value: OPERATOR_KEY },
            { label: "the own key of workspace O", value: OWN_KEY },
          ],
          names: [{ label: "the name of a draft", value: ENTRIES.draft.name }],
        }),
      );
      expect(leaks).toEqual([]);
      expect(read.apiOk).toBeGreaterThan(5);

      // The Owner of M asks for the pages and the data of O, which is not theirs: the answer is the one of a path that
      // does not exist, and holds nothing of O or of the catalog.
      const foreign = [
        ...(await readOthers(ownerOfM(), slugO, "refused")),
        ...(await readOthers(member(), slugO, "refused")),
      ];
      expect(findLeaks(foreign, await forbiddenForM())).toEqual([]);
    });
  });

  // #435-T06
  test("@smoke the search finds a model, a provider and a key in every shape a page or an answer holds them, and passes the words of the product", async ({
    browser,
  }) => {
    const catalog = await adminCatalog();
    const forbidden = await forbiddenForM();
    const provider = firstOf(catalog.providers, "provider");

    // A leak the search misses is a text it passes: the plants are made here, with encoders of their own.
    const plants = (modelId: string, key: string, only: string) =>
      plantedLeaks({
        modelId,
        providerId: provider.id,
        providerLabel: provider.label,
        key,
      })
        .filter(({ name }) => name.includes(only))
        .map((planted) => ({ planted, modelId, key }));
    const missed = [
      ...CATALOG_MODEL_IDS.flatMap((id) => plants(id, OPERATOR_KEY, "")),
      // The own key of workspace O is as secret in the pages of M.
      ...plants(ENTRIES.small.model, OWN_KEY, "key"),
    ]
      .filter(({ planted }) => findLeaks([planted], forbidden).length === 0)
      .map(
        ({ planted, modelId, key }) => `${planted.name} (${modelId}, ${key})`,
      );
    expect(missed, "leaks the search did not find").toEqual([]);

    expect(findLeaks(cleanTexts(), forbidden)).toEqual([]);
    // The forms are real: an id with a dot and a colon is not itself in its encoded forms.
    const forms = formsOf(ENTRIES.small.model);
    expect(forms.length).toBeGreaterThan(8);
    expect(forms).toContain(encodeURIComponent(ENTRIES.small.model));

    // A collector that is not signed in fails the run; it never reports "nothing found" for the login page.
    const stranger = await browser.newContext({
      baseURL: e2eEnv.catalogAppUrl,
    });
    const strangerPage = await stranger.newPage();
    await expect(
      readAs(strangerPage, `/w/${slugM}/projects`, { marker: "Projects" }),
    ).rejects.toThrow(/login/);
    await expect(expectSignedIn(strangerPage, slugM)).rejects.toThrow();
    await stranger.close();
  });

  // #435-T06
  test("@smoke an admin surface that holds the ids fails the search through every way of reading it", async () => {
    const page = admin();
    const catalog = await adminCatalog();
    const recorder = await recordNetwork(page.context());
    const read: Record<string, Surface[]> = {
      "the page": (await readAs(page, "/admin/llm")).surfaces,
      "the RSC payload": (
        await readAs(page, "/admin/llm", { headers: { RSC: "1" } })
      ).surfaces,
      "the data route": (await readAs(page, "/api/admin/model-catalog"))
        .surfaces,
      "the browser": await browse(page, "/admin/llm"),
    };
    const { surfaces: recorded, failures } = await recorder.stop();
    expect(failures).toEqual([]);
    read["the responses the browser received"] = recorded;

    // The ids the portal lists, in the forms of the search; and the providers.
    const forbidden = forbiddenFor({
      modelIds: catalog.entries.map((entry) => entry.modelId),
      providerIds: catalog.providers.map((entry) => entry.id),
      providerLabels: catalog.providers.map((entry) => entry.label),
      keys: [],
    });
    const blind = Object.entries(read)
      .filter(([, surfaces]) => findLeaks(surfaces, forbidden).length === 0)
      .map(([how]) => how);
    expect(
      blind,
      "ways of reading that found nothing on the admin page",
    ).toEqual([]);
  });

  // #435-T06
  test("@smoke the Owner and a Member of the managed workspace read no model id, no provider and no key anywhere", async ({
    request,
  }) => {
    test.setTimeout(300_000);
    const catalog = await adminCatalog();
    // The ids the portal lists are those the journey made: nothing was added that the search does not look for.
    expect(catalog.entries.map((entry) => entry.modelId).sort()).toEqual(
      [...CATALOG_MODEL_IDS].sort(),
    );
    const forbidden = await forbiddenForM();
    // The two people read in parallel: each has a browser of their own.
    const scanOne = async (
      who: string,
      page: Page,
      recorderOrNone: NetworkRecorder | undefined,
    ): Promise<Surface[]> => {
      const recorder = firstOf(recorderOrNone ? [recorderOrNone] : [], who);
      const ids = await idsOf(page, slugM);
      // Runs of every outcome the journey made so far: reviewed, handed out as Dynamic, failed, refused.
      expect(ids.runIds.length).toBeGreaterThanOrEqual(
        opened.filter(({ which }) => which === "M").length,
      );
      const read = await readRoutes(page, slugM, ids);
      expect(
        read.apiOk,
        `${who}: data routes that answered`,
      ).toBeGreaterThanOrEqual(6 + ids.runIds.length);
      expect(read.pages, `${who}: pages read`).toBeGreaterThan(10);
      const browsed = await browseRoutes(page, slugM, ids);
      expect(browsed.visited.length).toBeGreaterThan(10);
      // The browser really asked for every page it showed, and the run pages are among them.
      expectRecorded(recorder, browsed.visited, who);
      for (const runId of ids.runIds)
        expect(browsed.visited).toContain(`/w/${slugM}/runs/${runId}`);

      const { surfaces: responses, failures } = await recorder.stop();
      expect(failures, `${who}: requests that failed`).toEqual([]);
      expect(responses.length, `${who}'s responses`).toBeGreaterThan(
        browsed.visited.length,
      );
      return [...read.surfaces, ...browsed.surfaces, ...responses].map(
        (surface) => ({ name: `${who}: ${surface.name}`, text: surface.text }),
      );
    };
    const surfaces: Surface[] = (
      await Promise.all([
        scanOne("Member", member(), networkMember),
        scanOne("Owner", ownerOfM(), networkOwner),
      ])
    ).flat();

    surfaces.push(...(await allComments(request)));
    // The logs are the operator's side and name the models they work with; what no log may hold is a key, in any form
    // (the runner repeats what it is told, the app redacts what the provider quotes).
    const keysOnly = forbiddenFor({
      modelIds: [],
      providerIds: [],
      providerLabels: [],
      keys: [
        { label: "the operator's key", value: OPERATOR_KEY },
        { label: "the own key of workspace O", value: OWN_KEY },
      ],
    });
    const logs = [
      {
        name: "the log of the app",
        text: readFileSync(e2eEnv.logFiles.catalog, "utf8"),
      },
      { name: "the output of the runner", text: runnerOutput() },
    ];
    expect(findLeaks(logs, keysOnly)).toEqual([]);

    expect(findLeaks(surfaces, forbidden)).toEqual([]);
  });

  // #435-T06
  test("the usage feed names the entry and its id for the managed runs and no model and no provider", async () => {
    test.setTimeout(240_000);
    const records = await pollUsage(script(), workspaceIdM, 3);
    // One record for each managed run that reached a model or was handed out, whatever order they were settled in.
    expect(
      records
        .map((record) =>
          [record.reviewKind, record.keyMode, record.catalogEntryName].join(
            " ",
          ),
        )
        .sort(),
    ).toEqual(
      [
        `diff managed ${ENTRIES.small.name}`,
        `diff managed ${ENTRIES.big.name}`,
        `dynamic managed ${ENTRIES.small.name}`,
      ].sort(),
    );
    expect(records.map((record) => record.catalogEntryId).sort()).toEqual(
      [
        entryId(ENTRIES.small.name),
        entryId(ENTRIES.big.name),
        entryId(ENTRIES.small.name),
      ].sort(),
    );
    // The own workspace has no entry in its records.
    const own = await pollUsage(script(), workspaceIdO, 1);
    expect(
      own.map((record) => [record.keyMode, record.catalogEntryId]),
    ).toEqual([["own", null]]);

    // Every read of the feed: the list of each workspace, every workspace, a period, the runs of unknown cost.
    const reads = await script().usageReads(workspaceIdM);
    const forbidden = await forbiddenForM();
    expect(
      findLeaks(
        [
          { name: "the usage of M", text: JSON.stringify(records) },
          { name: "the usage of O", text: JSON.stringify(own) },
          ...reads.map((read, index) => ({
            name: `the usage read ${String(index + 1)}`,
            text: read.text,
          })),
        ],
        forbidden,
      ),
    ).toEqual([]);
    for (const read of reads) expect(read.status, read.text).toBe(200);
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
  // The provider is asked about the model without its variant (":beta" is a way of routing the same model).
  for (const id of CATALOG_MODEL_IDS.map(
    (model) => model.split(":")[0] ?? model,
  ))
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

/** What no member of the managed workspace may read, from the catalog the portal lists and the keys the journey made. */
function membersLook(catalog: Catalog) {
  return {
    modelIds: [
      ...new Set([
        ...catalog.entries.map((entry) => entry.modelId),
        ...CATALOG_MODEL_IDS,
      ]),
    ],
    providerIds: catalog.providers.map((provider) => provider.id),
    providerLabels: catalog.providers.map((provider) => provider.label),
    keys: [
      { label: "the operator's key", value: OPERATOR_KEY },
      { label: "the own key of workspace O", value: OWN_KEY },
    ],
    names: [{ label: "the name of a draft", value: ENTRIES.draft.name }],
    keyShapes: ["sk-or-v1-"],
  };
}

/** The first of a list a step needs to have, or a failure that says what is missing. */
function firstOf<T>(items: readonly T[], what: string): T {
  const first = items[0];
  if (first === undefined) throw new Error(`There is no ${what}.`);
  return first;
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

/** What a person who is not in the workspace gets for its pages and its data: asked as a person would, and read. */
async function readOthers(
  page: Page,
  slug: string,
  status: "refused" | "any",
): Promise<Surface[]> {
  const surfaces: Surface[] = [];
  for (const path of [
    `/w/${slug}/runs`,
    `/w/${slug}/settings/llm`,
    `/api/w/${slug}/runs`,
    `/api/w/${slug}/plan`,
    `/api/w/${slug}/llm-keys/openrouter`,
  ])
    surfaces.push(...(await readAs(page, path, { status })).surfaces);
  return surfaces;
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
