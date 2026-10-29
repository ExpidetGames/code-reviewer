// SPDX-License-Identifier: LicenseRef-Proprietary

// The model of a catalog entry is operator data (#432, ADR 0005, 2.17): a workspace on the operator's key selects an
// entry and never sees which model backs it. This test makes entries with ids no other test uses, runs managed jobs of
// both kinds through the claim and the completion (the runner reports the model, repeats it in its log and in its error),
// and then reads everything a workspace member can read - settings, the Runs list and detail, the plan page, the usage
// records, the comments the app wrote on the pull request - and searches all of it for any model id of any entry, of
// every status. It is the successor of the privacy test of the model tiers (#280).
import { DEFAULT_LLM_PROVIDER } from "../../src/llm/providers/index.ts";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "../../src/auth/access-policy.ts";
import { createReviewSettingsRouteHandlers } from "../../src/review-settings/http.ts";
import { createRunsRepository } from "../../src/db/repositories/runs-repository.ts";
import { createUsageRecordsRepository } from "../../src/db/repositories/usage-records-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../../src/db/repositories/workspace-entitlements-repository.ts";
import { createRunsService } from "../../src/runs/runs-service.ts";
import { sha } from "../../src/test-support/jobs.ts";
import {
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";
import { readPlanView } from "../../src/usage/usage-summary.ts";
import type { EntitlementsData } from "../../src/workspaces/entitlements.ts";
import { getProductIdentity } from "../../src/product-identity/current.ts";

const PRODUCT = getProductIdentity();

const OPERATOR_KEY = "plain-operator-key-0001-aaaaaaaa";
// The ids below are made up for the test. Nothing in the repository names a real model for an entry.
const MODELS = {
  selected: "hidden-vendor/entry-selected-model:extended",
  other: "hidden-vendor/entry-other-model",
  retired: "hidden-vendor/entry-retired-model",
};
const MODEL_IDS = Object.values(MODELS);
// What a search for "any model id of any entry" looks for: the ids, and the part that names the maker.
const NEEDLES = [
  ...MODEL_IDS,
  "hidden-vendor",
  "entry-selected",
  "entry-other",
];

function managed(overrides: Partial<EntitlementsData> = {}): EntitlementsData {
  return {
    planLabel: "plan",
    keyMode: "managed",
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: 5_000_000,
      ownKeyCostLimitMicroUsd: null,
    },
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: false,
    suspensionCode: null,
    ...overrides,
  };
}

async function start() {
  const h = await startRunnerApiHarness({
    projects: true,
    refusalNotices: {},
    defaultEntry: false,
  });
  await h.llm
    .operatorKey()
    .save({ provider: DEFAULT_LLM_PROVIDER, apiKey: OPERATOR_KEY }, null);
  const selected = await h.catalogFixture.entry({
    name: "Thorough",
    modelId: MODELS.selected,
  });
  const other = await h.catalogFixture.entry({
    name: "Quick",
    modelId: MODELS.other,
  });
  await h.catalogFixture.entry({
    name: "Gone",
    modelId: MODELS.retired,
    status: "retired",
  });
  await h.setCatalogDefaults({ diff: other.id, dynamic: other.id });
  await createWorkspaceEntitlementsRepository(
    h.db,
    h.workspaceId,
    h.clock.now,
  ).put(managed(), null);
  await h.projectService.activateProject(h.repositoryId);
  await h.reviewSettings.updateProjectSettings(h.repositoryId, {
    catalogEntryDiff: selected.id,
    catalogEntryDynamic: selected.id,
  });
  return { h, selected };
}

/** A managed job that ran: claimed (so the model reached the runner), and completed with a result that repeats it. */
async function run(h: RunnerApiHarness, kind: "diff" | "dynamic") {
  if (kind === "dynamic")
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      reviewKind: "dynamic",
    });
  const job = await h.enqueueNew(
    kind === "dynamic" ? { reviewKind: "dynamic", headSha: sha("d") } : {},
  );
  const claim = await h.claimed(
    kind === "dynamic" ? { engines: ["opencode"] } : {},
  );
  const given = MODELS.selected;
  // The runner is the one party that gets the model.
  expect(JSON.stringify(claim.job.input.llm)).toContain(given);
  const completed = await h.complete(job.id, claim.job.leaseToken, {
    ok: false,
    errorCode: "llm_rate_limit",
    errorMessage: `429 from the provider for openrouter/${given}`,
    logTail: `calling openrouter/${given}\nusing model ${given}`,
    usage: {
      model: `openrouter/${given}`,
      promptTokens: 1200,
      completionTokens: 80,
      totalTokens: 1280,
      aiCalls: 1,
      fallbackUsed: false,
      costUsd: 0.02,
      stoppedEarly: null,
    },
  });
  expect(completed.status).toBe(200);
  return job;
}

/** Every answer and page source a workspace member can read, as one text. */
async function whatAMemberCanRead(h: RunnerApiHarness): Promise<string> {
  const runs = createRunsService({
    product: PRODUCT,
    runs: createRunsRepository(h.db, h.workspaceId),
    now: h.clock.now,
  });
  const list = await runs.list({});
  const details = await Promise.all(list.runs.map((row) => runs.get(row.id)));
  const usage = createUsageRecordsRepository(h.db, h.workspaceId, h.clock.now);
  return JSON.stringify({
    globalSettings: await h.reviewSettings.getGlobalSettings(),
    projectSettings: await h.reviewSettings.getProjectSettings(h.repositoryId),
    runsList: list,
    runDetails: details,
    plan: await readPlanView(h.db, h.workspaceId, h.clock.now),
    usageRecords: (await usage.pageSettled({ limit: 100 })).records,
    usageSummary: await usage.summarize({
      from: "2026-01-01T00:00:00.000Z",
      to: "2027-01-01T00:00:00.000Z",
    }),
    comments: h.notices.comments(h.repository.fullName, 7),
  });
}

/** The review settings of the workspace as its routes answer them while its key mode is `managed`. */
async function settingsAnswers(h: RunnerApiHarness): Promise<string> {
  const handlers = createReviewSettingsRouteHandlers({
    requireUser: async () => ({ id: "u1" }) as SessionUser,
    service: h.reviewSettings,
  });
  const answers = [
    await handlers.getGlobal(
      new Request("https://app.test/api/review-settings"),
    ),
    await handlers.getProject(
      new Request("https://app.test/api/project"),
      h.repositoryId,
    ),
  ];
  return (await Promise.all(answers.map((answer) => answer.text()))).join("\n");
}

describe("what a workspace member can read after managed runs", () => {
  // #432-T13
  it("shows the tokens of a managed run in the Runs view, and neither its model nor its cost", async () => {
    const { h } = await start();
    const job = await run(h, "diff");
    const runs = createRunsService({
      product: PRODUCT,
      runs: createRunsRepository(h.db, h.workspaceId),
      now: h.clock.now,
    });

    const detail = JSON.stringify(await runs.get(job.id));

    expect(detail).toContain('"totalTokens":1280');
    expect(detail).not.toContain("0.02");
    expect(detail).toContain('"costHidden":true');
  });

  // #432-T13
  it("holds no model id of any entry, and no model or provider field, in the settings of the workspace and of the project", async () => {
    const { h, selected } = await start();
    await run(h, "diff");
    await run(h, "dynamic");

    const text = await settingsAnswers(h);

    for (const needle of NEEDLES) expect(text).not.toContain(needle);
    expect(text).not.toMatch(
      /"(model|fallbackModel|dynamicModel|provider|dynamicProvider)"/,
    );
    // The member reads the choices they have: the entry they selected, by id and name.
    expect(text).toContain(selected.id);
    expect(text).toContain("Thorough");
  });

  // #432-T13
  it("holds no model id of any entry: settings, Runs, plan and usage, for a Diff and a Dynamic run", async () => {
    const { h } = await start();
    await run(h, "diff");
    await run(h, "dynamic");

    const text = await whatAMemberCanRead(h);

    for (const needle of NEEDLES) expect(text).not.toContain(needle);
    // The member can read what they should: the cost and tokens of the run.
    expect(text).toContain("1200");
  });

  // #432-T13
  it("holds no model id in a refusal notice on the pull request", async () => {
    const { h } = await start();
    await createWorkspaceEntitlementsRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    ).put(
      managed({
        limits: {
          diffRunsPerPeriod: 0,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
      }),
      null,
    );
    await h.enqueueNew();

    expect((await h.claim()).status).toBe(204);
    await h.notices.settled();

    const comments = h.notices.comments(h.repository.fullName, 7);
    expect(comments).toHaveLength(1);
    for (const needle of NEEDLES)
      expect(JSON.stringify(comments)).not.toContain(needle);
  });

  // #432-T13
  it("holds no model id on the stored job when the selected entry is gone: only the code", async () => {
    const { h, selected } = await start();
    await h.setCatalogDefaults({ diff: null, dynamic: null });
    await h.catalogFixture.service.retire(selected.id, null);
    const job = await h.enqueueNew();

    expect((await h.claim()).status).toBe(204);

    const text = await whatAMemberCanRead(h);
    expect(await h.queue.get(job.id)).toMatchObject({
      errorCode: "managed_model_unavailable",
    });
    for (const needle of NEEDLES) expect(text).not.toContain(needle);
    for (const line of h.logLines())
      for (const needle of NEEDLES) expect(line).not.toContain(needle);
  });

  // #432-T13
  it("holds the model the operator put behind the entry later neither: the views never carried it", async () => {
    const { h, selected } = await start();
    await run(h, "diff");
    await h.catalogFixture.service.update(
      selected.id,
      { modelId: "hidden-vendor/new-model" },
      null,
      { confirmModelChange: true },
    );

    const text = await whatAMemberCanRead(h);

    expect(text).not.toContain("hidden-vendor");
  });
});
