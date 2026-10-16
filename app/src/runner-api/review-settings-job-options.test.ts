// SPDX-License-Identifier: Apache-2.0

// #195 finding 2: the claim preparation must follow the **claimed job's pinned kind**, never the
// project's current kind. A settings save can run after the atomic claim but before `optionsFor`
// reads the settings; whichever way the kind moved, the job keeps the options of the kind it was
// queued for.
import { describe, expect, it } from "vitest";
import {
  resolveProjectDynamicSettings,
  resolveReviewSettings,
} from "../review-settings/effective.ts";
import {
  builtInProjectDynamicSettings,
  builtInReviewSettings,
  type ProjectReviewKind,
} from "../review-settings/settings.ts";
import type { Job } from "../jobs/job-types.ts";
import { createReviewSettingsJobOptionsSource } from "./review-settings-job-options.ts";

function resolved(projectKind: ProjectReviewKind) {
  const builtInDynamic = {
    ...builtInProjectDynamicSettings(),
    dynamicModel: "dynamic-model",
  };
  return {
    ...resolveReviewSettings({ builtIn: builtInReviewSettings("diff-model") }),
    dynamic: resolveProjectDynamicSettings({
      builtIn: builtInDynamic,
      project: { reviewKind: projectKind },
      defaultSkill: "the shipped skill",
    }),
  };
}

function sourceFor(projectKind: ProjectReviewKind) {
  const value = resolved(projectKind);
  return createReviewSettingsJobOptionsSource({
    settings: () => ({
      resolveForRepository: async () => value,
    }),
  });
}

function job(reviewKind: ProjectReviewKind): Job {
  return {
    id: "6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11",
    workspaceId: "workspace-1",
    repositoryId: "repo-1",
    prNumber: 7,
    prUrl: "https://github.example/acme/widgets/pull/7",
    headSha: "a".repeat(40),
    reviewKind,
    command: "review",
    args: "",
    triggerKind: "webhook",
    actorLogin: "octocat",
    deliveryId: "delivery-1",
    status: "running",
    runAfter: "2026-10-10T12:00:00.000Z",
    attempts: 0,
    runnerId: "runner-1",
    claimedAt: "2026-10-10T12:00:00.000Z",
    heartbeatAt: "2026-10-10T12:00:30.000Z",
    leaseExpiresAt: "2026-10-10T12:02:30.000Z",
    result: null,
    errorCode: null,
    supersededBy: null,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
    finishedAt: null,
  };
}

describe("the job options of a claimed job", () => {
  // #262-T02
  it("gives a Dynamic job of a project without a model override the OpenRouter id, in both model fields", async () => {
    const source = createReviewSettingsJobOptionsSource({
      settings: () => ({
        resolveForRepository: async () => ({
          ...resolveReviewSettings({
            builtIn: builtInReviewSettings("diff-model"),
          }),
          dynamic: resolveProjectDynamicSettings({
            builtIn: builtInProjectDynamicSettings(),
            project: { reviewKind: "dynamic" },
            defaultSkill: "the shipped skill",
          }),
        }),
      }),
    });

    const options = await source.optionsFor(job("dynamic"));

    expect(options.dynamic).toMatchObject({
      model: "deepseek/deepseek-v4.1-flash",
    });
    expect(options.llm?.model).toBe("deepseek/deepseek-v4.1-flash");
  });

  // #195 finding 2
  it("gives a claimed Dynamic job its Dynamic options even after the project turned Diff", async () => {
    const options = await sourceFor("diff").optionsFor(job("dynamic"));

    expect(options.dynamic).toMatchObject({ model: "dynamic-model" });
    expect(options.llm?.model).toBe("dynamic-model");
    // No PR-Agent option is promoted into the Dynamic job.
    expect(options.env).toStrictEqual({});
  });

  // #280-T04
  it("carries the model tier of the project's effective settings for both kinds", async () => {
    const tiered = (kind: ProjectReviewKind, tier?: "low" | "high") =>
      createReviewSettingsJobOptionsSource({
        settings: () => ({
          resolveForRepository: async () => ({
            ...resolveReviewSettings({
              builtIn: builtInReviewSettings("diff-model"),
              ...(tier === undefined ? {} : { project: { modelTier: tier } }),
            }),
            dynamic: resolveProjectDynamicSettings({
              builtIn: builtInProjectDynamicSettings(),
              project: { reviewKind: kind },
              defaultSkill: "the shipped skill",
            }),
          }),
        }),
      });

    expect(
      (await tiered("diff", "high").optionsFor(job("diff"))).modelTier,
    ).toBe("high");
    expect(
      (await tiered("dynamic", "low").optionsFor(job("dynamic"))).modelTier,
    ).toBe("low");
    // #280-T10: medium when nothing sets it.
    expect((await tiered("diff").optionsFor(job("diff"))).modelTier).toBe(
      "medium",
    );
  });

  // #195 finding 2
  it("gives a claimed Diff job the PR-Agent options even after the project turned Dynamic", async () => {
    const options = await sourceFor("dynamic").optionsFor(job("diff"));

    expect(options.dynamic).toBeUndefined();
    expect(options.llm?.model).toBe("diff-model");
    expect(options.env).toHaveProperty("PR_REVIEWER__NUM_MAX_FINDINGS");
  });
});
