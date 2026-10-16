// SPDX-License-Identifier: Apache-2.0

// The instance that never switched any of the operator limits on (#285-T01, principle 1 of #268): no operator token and
// no entitlements. A pull request is reviewed exactly as before, with the workspace's own key and the model of the
// instance, and nothing of the epic shows: the operator API is a path that does not exist, the plan page says that
// no limits apply, and the settings still ask for a model. It runs on the app of the journey with the real runner
// (the second app), after that journey, against the fake GitHub and a fake LLM.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import { syncFromGithubAsAdmin } from "../helpers/admin-api";
import { e2eEnv, llmEnv } from "../helpers/e2e-env";
import {
  addGithubAccount,
  addGithubInstallation,
  addGithubPullRequest,
  GITHUB_APP_OWNER_ACCOUNT,
  getPullRequestComments,
  signInThroughTheForm,
  type GithubAccount,
} from "../helpers/github-fake";
import { operatorClient } from "../helpers/operator-api";
import { startRunner, type RunnerProcess } from "../helpers/runner-process";
import { deliverPullRequestEvent } from "../helpers/webhooks";

const account: GithubAccount = {
  id: 7410101,
  login: "plain-instance",
  name: "Plain Instance",
  email: "plain-instance@example.test",
};
const INSTALLATION_ID = 9510101;
const REPOSITORY = { id: 9610101, fullName: "plain-instance/widgets" };
const OWNER = { login: account.login, id: account.id };
const REVIEW_MARKER = "<!-- pr-agent:review:full -->";
const RUN_TIMEOUT = { timeout: 120_000 };

test.describe.configure({ mode: "serial" });

test.describe("an instance without an operator token and without entitlements", () => {
  let llm: FakeLlm | undefined;
  let runner: RunnerProcess | undefined;

  test.beforeAll(async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    if (baseURL === undefined) throw new Error("The project has no baseURL.");
    llm = await startLlmFake();
    runner = await startRunner({ appUrl: baseURL, llmBaseUrl: llm.baseUrl });

    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await addGithubAccount(context.request, account, "pipeline");
    await addGithubInstallation(
      context.request,
      { id: INSTALLATION_ID, account: GITHUB_APP_OWNER_ACCOUNT },
      [REPOSITORY],
    );
    await syncFromGithubAsAdmin(baseURL);
    await signInThroughTheForm(page, account);
    // The workspace's own key, saved as an Owner does it (the instance has none in its environment).
    const saved = await page.request.put("/api/w/default/llm-key", {
      data: { provider: llmEnv.provider, apiKey: llmEnv.apiKey },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    const row = page.getByRole("row").filter({ hasText: REPOSITORY.fullName });
    await expect(row).toBeVisible();
    await row
      .getByRole("switch", { name: `Review ${REPOSITORY.fullName}` })
      .click();
    await expect(row.getByText("Active", { exact: true })).toBeVisible();
    await context.close();
  });

  test.afterAll(async () => {
    await runner?.stop();
    await llm?.close();
  });

  function fakeLlm(): FakeLlm {
    if (llm === undefined) throw new Error("The fake LLM was not started.");
    return llm;
  }

  async function openSettings(page: Page, section: string) {
    await page.goto(`/w/default/settings${section}`);
    await expect(
      page.getByRole("navigation", { name: "Settings sections" }),
    ).toBeVisible();
  }

  // #285-T01
  test("@smoke a pull request is reviewed as before and the operator routes are missing paths", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    const number = 11;
    const head = "7".padEnd(40, "0");
    await addGithubPullRequest(request, REPOSITORY.fullName, {
      number,
      title: "Add a greeting helper",
      headSha: head,
    });
    await signInThroughTheForm(page, account);
    await page.getByRole("link", { name: "Runs", exact: true }).click();

    const answer = await deliverPullRequestEvent(request, {
      action: "opened",
      installationId: INSTALLATION_ID,
      repository: { ...REPOSITORY, owner: OWNER },
      number,
      title: "Add a greeting helper",
      headSha: head,
    });
    expect(answer).toEqual({ status: "accepted", outcome: "trigger_enqueued" });
    const run = page
      .locator("[data-run-id]")
      .filter({ hasText: REPOSITORY.fullName })
      .filter({ hasText: `#${String(number)}` });
    await expect(run.locator("[data-status]")).toContainText(
      "Succeeded",
      RUN_TIMEOUT,
    );

    // One review comment, written with the workspace's own key and the model of the instance; the provider was told
    // to route only to endpoints that support what the request needs.
    const comments = await getPullRequestComments(
      request,
      REPOSITORY.fullName,
      number,
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(REVIEW_MARKER);
    const asked = fakeLlm().requests();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.authorization).toBe(`Bearer ${llmEnv.apiKey}`);
    expect(asked[0]?.model).toContain(llmEnv.model);
    expect(asked[0]?.provider).toMatchObject({ require_parameters: true });

    // The operator API does not exist here: every path below it is a path that does not exist, whatever the
    // method and whatever the token (the right one of the other instance included), and the app says at its start
    // that it is off.
    const bearer = { authorization: `Bearer ${e2eEnv.operatorApiToken}` };
    for (const [method, path] of [
      ["GET", "/api/operator/v1/workspaces"],
      ["GET", "/api/operator/v1/entitlements/default"],
      ["PUT", "/api/operator/v1/entitlements/default"],
      ["GET", "/api/operator/v1/usage"],
      ["GET", "/api/operator/v1/usage/unknown-cost"],
      ["GET", "/api/operator/v1/model-tiers"],
      ["GET", "/api/operator/v1/plan-management"],
      ["POST", "/api/operator/v1/handoff/redeem"],
    ] as const) {
      for (const headers of [bearer, {}]) {
        const missing = await request.fetch(path, {
          method,
          headers,
          maxRedirects: 0,
        });
        expect(missing.status(), `${method} ${path}`).toBe(404);
        expect(await missing.text(), `${method} ${path}`).not.toContain(
          '"version"',
        );
      }
    }
    const client = await operatorClient({ baseURL: e2eEnv.pipelineAppUrl });
    try {
      const listed = await client.call("GET", "/workspaces");
      expect(listed.status).toBe(404);
    } finally {
      await client.dispose();
    }
    expect(
      readFileSync(resolve(process.cwd(), e2eEnv.logFiles.pipeline), "utf8"),
    ).toContain("[operator-api] off: OPERATOR_API_TOKEN is not set.");
  });

  // #285-T01
  test("the workspace pages show no limits, no plan, no quality level and no hand-over", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);

    // The plan page is there by its address and says that no limits apply; the settings navigation does not list it.
    await openSettings(page, "");
    const sections = page.getByRole("navigation", {
      name: "Settings sections",
    });
    await expect(sections.getByRole("link", { name: "General" })).toBeVisible();
    await expect(
      sections.getByRole("link", { name: "Plan", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Manage plan" })).toHaveCount(
      0,
    );
    await page.goto("/w/default/settings/plan");
    await expect(
      page.getByText("No limits apply to this workspace."),
    ).toBeVisible();
    const plan = await page.request.get("/api/w/default/plan");
    expect(plan.status()).toBe(200);
    expect(await plan.json()).toMatchObject({ kind: "unlimited" });

    // The route of the hand-over does not exist while no operator page is set.
    const handoff = await page.request.post("/api/w/default/plan-handoff", {
      maxRedirects: 0,
    });
    expect(handoff.status()).toBe(404);

    // The workspace is still asked for a model and a key, and no quality level replaces them.
    await openSettings(page, "/review-defaults");
    await expect(page.locator('[data-field="modelTier"]')).toHaveCount(0);
    await expect(page.getByLabel("Model", { exact: true })).toBeVisible();
    await openSettings(page, "/llm");
    await expect(page.getByRole("form", { name: "LLM key" })).toBeVisible();
  });
});
