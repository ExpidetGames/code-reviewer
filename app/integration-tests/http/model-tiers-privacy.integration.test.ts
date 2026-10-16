// SPDX-License-Identifier: Apache-2.0

// The model of a tier is operator data (#280): a workspace on the operator's key chooses a tier and never sees which
// model backs it. This test configures tiers with ids no other test uses, runs managed jobs of both kinds through the
// claim and the completion (the runner reports the model, repeats it in its log and in its error), and then reads
// everything a workspace member can read - settings, the Runs list and detail, the plan page, the usage
// records, the comments the app wrote on the pull request - and searches all of it for any model id of any tier.
import { describe, expect, it } from "vitest";
import type { SessionUser } from "../../src/auth/access-policy.ts";
import { createAppSettingsRepository } from "../../src/db/repositories/app-settings-repository.ts";
import { createProjectsRepository } from "../../src/db/repositories/projects-repository.ts";
import { createRunsRepository } from "../../src/db/repositories/runs-repository.ts";
import { createUsageRecordsRepository } from "../../src/db/repositories/usage-records-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../../src/db/repositories/workspace-entitlements-repository.ts";
import { configuredTiers } from "../../src/model-tiers/tiers.ts";
import { createReviewSettingsRouteHandlers } from "../../src/review-settings/http.ts";
import { createReviewSettingsService } from "../../src/review-settings/service.ts";
import { builtInReviewSettings } from "../../src/review-settings/settings.ts";
import { createRunsService } from "../../src/runs/runs-service.ts";
import { sha } from "../../src/test-support/jobs.ts";
import {
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";
import { readPlanView } from "../../src/usage/usage-summary.ts";
import type { EntitlementsData } from "../../src/workspaces/entitlements.ts";

const OPERATOR_KEY = "plain-operator-key-0001-aaaaaaaa";
const TIERS = {
  low: {
    diff: "hidden-vendor/tier-low-diff",
    dynamic: "hidden-vendor/tier-low-dyn",
  },
  medium: {
    diff: "hidden-vendor/tier-medium-diff",
    dynamic: "hidden-vendor/tier-medium-dyn",
  },
  high: {
    diff: "hidden-vendor/tier-high-diff:extended",
    dynamic: "hidden-vendor/tier-high-dyn",
  },
};
const MODEL_IDS = Object.values(TIERS).flatMap((models) =>
  Object.values(models),
);
// What a search for "any model id of any tier" looks for: the ids, and the part that names the maker.
const NEEDLES = [...MODEL_IDS, "hidden-vendor", "tier-high", "tier-low"];

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
    modelTiers: TIERS,
    refusalNotices: {},
  });
  await h.llm.operatorKey().save({ apiKey: OPERATOR_KEY }, null);
  await createWorkspaceEntitlementsRepository(
    h.db,
    h.workspaceId,
    h.clock.now,
  ).put(managed(), null);
  await h.projectService.activateProject(h.repositoryId);
  await h.reviewSettings.updateGlobalSettings({ modelTier: "low" }, "owner");
  await h.reviewSettings.updateProjectSettings(h.repositoryId, {
    modelTier: "high",
  });
  return h;
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
  const given = kind === "diff" ? TIERS.high.diff : TIERS.high.dynamic;
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

/**
 * The review settings of the workspace as its routes answer them while its key mode is `managed` (the harness's own
 * service is the one the claim uses and does not know the key mode).
 */
async function settingsAnswers(h: RunnerApiHarness): Promise<string> {
  const service = createReviewSettingsService({
    appSettings: createAppSettingsRepository(h.db, h.workspaceId),
    projects: createProjectsRepository(h.db, h.workspaceId),
    builtIn: () => builtInReviewSettings("vendor/instance-model"),
    operatorsModels: async () => true,
    tierAvailability: async () => configuredTiers(TIERS),
  });
  const handlers = createReviewSettingsRouteHandlers({
    requireUser: async () => ({ id: "u1" }) as SessionUser,
    service,
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
  // #283-T07
  it("holds no model id of any tier, and no model field, in the settings of the workspace and of the project", async () => {
    const h = await start();
    await run(h, "diff");
    await run(h, "dynamic");

    const text = await settingsAnswers(h);

    for (const needle of NEEDLES) expect(text).not.toContain(needle);
    expect(text).not.toMatch(/"(model|fallbackModel|dynamicModel)"/);
    expect(text).not.toContain("vendor/instance-model");
    expect(text).toContain('"modelTier":"high"');
  });

  // #280-T08
  it("holds no model id of any tier: settings, Runs, plan and usage, for a Diff and a Dynamic run", async () => {
    const h = await start();
    await run(h, "diff");
    await run(h, "dynamic");

    const text = await whatAMemberCanRead(h);

    for (const needle of NEEDLES) expect(text).not.toContain(needle);
    // The member can read what they should: the tier they chose and the cost and tokens of the run.
    expect(text).toContain('"modelTier":"high"');
    expect(text).toContain("1200");
  });

  // #280-T08
  it("holds no model id in a refusal notice on the pull request", async () => {
    const h = await start();
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

  // #280-T08
  it("holds no model id on the stored job when a tier is missing: only the code", async () => {
    const h = await start();
    await h.setTiers({ medium: TIERS.medium });
    const job = await h.enqueueNew();

    expect((await h.claim()).status).toBe(204);

    const text = await whatAMemberCanRead(h);
    expect(await h.queue.get(job.id)).toMatchObject({
      errorCode: "managed_tier_unavailable",
    });
    for (const needle of NEEDLES) expect(text).not.toContain(needle);
    for (const line of h.logLines())
      for (const needle of NEEDLES) expect(line).not.toContain(needle);
  });

  // #280-T08
  it("holds the model of a tier the operator configured later neither: the settings never carried it", async () => {
    const h = await start();
    await run(h, "diff");
    await h.setTiers({ ...TIERS, high: { diff: "hidden-vendor/new-high" } });

    const text = await whatAMemberCanRead(h);

    expect(text).not.toContain("hidden-vendor");
  });
});
