// SPDX-License-Identifier: Apache-2.0

// #434: the differential test. The database is the one the previous release left behind: the operator configured the
// managed tiers (a model for each tier and kind), and projects chose a tier (`modelTier` in their settings, or in the
// workspace's review defaults). The tier migration runs, and the claim of the release that no longer knows tiers must hand
// the runner the model the old claim handed for that tier and kind, with the operator's key and no model in any other
// place. The old claim's answer is the model that the stored configuration names for the (tier, kind): that is what it
// swapped into the job. The model ids below are made up for the test.
import { describe, expect, it } from "vitest";
import { migration } from "../../src/db/migrations/20261018160000_migrate_model_tiers_to_catalog.ts";
import { createWorkspaceEntitlementsRepository } from "../../src/db/repositories/workspace-entitlements-repository.ts";
import { entryIdOf } from "../../src/db/migrations/model-tiers-to-catalog.ts";
import { startRunnerApiHarness } from "../../src/test-support/runner-api-harness.ts";

const OPERATOR_KEY = "plain-operator-key-0001-aaaaaaaa";
const WORKSPACE_KEY = "plain-workspace-key-0003-cccccccc";
const T = "2026-10-18T08:00:00.000Z";

type Tier = "low" | "medium" | "high";
type Kind = "diff" | "dynamic";
const TIERS: Tier[] = ["low", "medium", "high"];
const KINDS: Kind[] = ["diff", "dynamic"];

type Configuration = Partial<Record<Tier, Partial<Record<Kind, string>>>>;

const CONFIGURATIONS: Record<string, Configuration> = {
  "one model per tier for both kinds": {
    low: { diff: "tier/low-both", dynamic: "tier/low-both" },
    medium: { diff: "tier/mid-both", dynamic: "tier/mid-both" },
    high: { diff: "tier/high-both", dynamic: "tier/high-both" },
  },
  "a model per tier and kind": {
    low: { diff: "tier/low-diff", dynamic: "tier/low-dyn" },
    medium: { diff: "tier/mid-diff", dynamic: "tier/mid-dyn" },
    high: { diff: "tier/high-diff", dynamic: "tier/high-dyn" },
  },
  "tiers that lack a kind": {
    low: { diff: "tier/low-diff" },
    medium: { diff: "tier/mid-diff", dynamic: "tier/mid-dyn" },
    high: { dynamic: "tier/high-dyn" },
  },
};

const DYNAMIC_CLAIM = {
  engines: ["opencode"],
  features: ["dynamic_capabilities"],
};

async function start(options: {
  tiers: Configuration;
  kind: Kind;
  /** The tier the project stores, or none. */
  projectTier?: Tier;
  /** The tier of the workspace's review defaults, or none. */
  workspaceTier?: Tier;
  /** The key mode of the workspace; managed unless said otherwise. */
  keyMode?: "own" | "managed";
  /** The entries the plan lists in `modelAccess`; all released entries when absent. */
  modelAccess?: string[];
  /** Run the migration (the default), or leave the database as the previous release wrote it. */
  migrate?: boolean;
}) {
  const h = await startRunnerApiHarness({
    llmKey: WORKSPACE_KEY,
    projects: true,
    defaultEntry: false,
    env: { LLM_MODEL: "vendor/instance-model", LLM_MAX_TOKENS: "64000" },
  });
  const saved = await h.llm
    .operatorKey()
    .save({ provider: "openrouter", apiKey: OPERATOR_KEY }, null);
  expect(saved.ok).toBe(true);
  await createWorkspaceEntitlementsRepository(
    h.db,
    h.workspaceId,
    h.clock.now,
  ).put(
    {
      planLabel: "plan",
      keyMode: options.keyMode ?? "managed",
      ...(options.modelAccess === undefined
        ? {}
        : { modelAccess: { catalogEntries: options.modelAccess } }),
      limits: {
        diffRunsPerPeriod: null,
        dynamicRunsPerPeriod: null,
        managedCostLimitMicroUsd: null,
        ownKeyCostLimitMicroUsd: null,
      },
      periodStart: "2026-10-01T00:00:00.000Z",
      suspended: false,
      suspensionCode: null,
    },
    null,
  );
  await h.projectService.activateProject(h.repositoryId);
  await h.reviewSettings.updateProjectSettings(h.repositoryId, {
    reviewKind: options.kind,
  });

  // What the previous release stored: the tiers, the project's tier and the workspace's.
  await h.db
    .insertInto("instance_settings")
    .values({
      key: "managed_model_tiers",
      value: JSON.stringify(options.tiers),
      updated_by: null,
      updated_at: T,
    })
    .execute();
  if (options.projectTier !== undefined) {
    const row = await h.db
      .selectFrom("projects")
      .select("settings")
      .where("repository_id", "=", h.repositoryId)
      .executeTakeFirstOrThrow();
    await h.db
      .updateTable("projects")
      .set({
        settings: JSON.stringify({
          ...(JSON.parse(row.settings) as object),
          modelTier: options.projectTier,
        }),
      })
      .where("repository_id", "=", h.repositoryId)
      .execute();
  }
  if (options.workspaceTier !== undefined)
    await h.db
      .insertInto("app_settings")
      .values({
        workspace_id: h.workspaceId,
        key: "review_defaults",
        value: JSON.stringify({ modelTier: options.workspaceTier }),
        updated_by: null,
        updated_at: T,
      })
      .execute();

  if (options.migrate !== false) await migration.up(h.db);
  await h.enqueueNew();
  return h;
}

function modelOf(
  input: { llm: { model: string }; dynamic?: { model: string } },
  kind: Kind,
): string {
  return kind === "dynamic"
    ? (input.dynamic?.model ?? "no dynamic model")
    : input.llm.model;
}

describe("the claim after the tier migration", () => {
  for (const [label, tiers] of Object.entries(CONFIGURATIONS))
    describe(`with ${label}`, () => {
      for (const tier of TIERS)
        for (const kind of KINDS) {
          const old = tiers[tier]?.[kind];
          if (old === undefined) continue;
          // #434-T04
          it(`hands a ${kind} job of a project on the ${tier} tier the model the old claim handed`, async () => {
            const h = await start({ tiers, kind, projectTier: tier });

            const { job } = await h.claimed(
              kind === "dynamic" ? DYNAMIC_CLAIM : undefined,
            );

            expect(modelOf(job.input, kind)).toBe(old);
            expect(job.input.llm.apiKey).toBe(OPERATOR_KEY);
            expect(JSON.stringify(job.input)).not.toContain(
              "vendor/instance-model",
            );
          });
        }

      for (const kind of KINDS) {
        const old = tiers.medium?.[kind];
        // #434-T04
        it(`hands a ${kind} job of a project that chose nothing the model of the medium tier`, async () => {
          const h = await start({ tiers, kind });

          if (old === undefined) {
            const [job] = await h.snapshotJobs();
            expect((await h.claim(DYNAMIC_CLAIM)).status).toBe(204);
            expect(await h.queue.get(job!.id)).toMatchObject({
              status: "failed",
              errorCode: "managed_model_unavailable",
            });
            return;
          }
          const { job } = await h.claimed(
            kind === "dynamic" ? DYNAMIC_CLAIM : undefined,
          );
          expect(modelOf(job.input, kind)).toBe(old);
        });

        // #434-T12
        it(`hands a ${kind} job of a project that inherits the workspace's tier the model of that tier`, async () => {
          for (const tier of ["low", "high"] as const) {
            const wanted = tiers[tier]?.[kind];
            if (wanted === undefined) continue;
            const h = await start({ tiers, kind, workspaceTier: tier });

            const { job } = await h.claimed(
              kind === "dynamic" ? DYNAMIC_CLAIM : undefined,
            );

            expect(modelOf(job.input, kind)).toBe(wanted);
          }
        });
      }
    });

  // #434-T04
  it("lets a project's own tier win over the workspace's, as the old layering did", async () => {
    const tiers = CONFIGURATIONS["a model per tier and kind"]!;
    const h = await start({
      tiers,
      kind: "diff",
      projectTier: "low",
      workspaceTier: "high",
    });

    const { job } = await h.claimed();

    expect(job.input.llm.model).toBe("tier/low-diff");
  });

  // #434-T04
  it("does not hand a job of a kind the tier had no model for the model of another tier, except the instance default", async () => {
    // The old claim ended such a job `managed_tier_unavailable`. A project without an entry for the kind gets the instance
    // default entry of the kind (the medium tier's), the same as a project that never chose; never the model of a third tier.
    const tiers = CONFIGURATIONS["tiers that lack a kind"]!;
    const h = await start({ tiers, kind: "diff", projectTier: "high" });

    const { job } = await h.claimed();

    expect(job.input.llm.model).toBe("tier/mid-diff");
    expect(job.input.llm.model).not.toBe("tier/high-dyn");
  });

  // #434-T06
  it("leaves the claim of a workspace on its own key as it was, whatever tier its project stored", async () => {
    const tiers = CONFIGURATIONS["a model per tier and kind"]!;
    const options = {
      tiers,
      kind: "diff",
      projectTier: "high",
      workspaceTier: "low",
      keyMode: "own",
    } as const;
    const unmigrated = await start({ ...options, migrate: false });
    const { job: before } = await unmigrated.claimed();
    const migrated = await start(options);
    const { job: after } = await migrated.claimed();

    expect(after.input.llm).toEqual(before.input.llm);
    expect(after.input.llm.apiKey).toBe(WORKSPACE_KEY);
    expect(JSON.stringify(after.input)).not.toContain("tier/");
  });

  // #434-X5
  it.each([
    ["an empty list", []],
    ["a list that names only another entry", ["mce_other"]],
  ])(
    "stops a managed workspace whose plan has %s, for a project on a tier and for one that chose none",
    async (_name, modelAccess) => {
      const tiers = CONFIGURATIONS["a model per tier and kind"]!;
      for (const projectTier of ["high", undefined] as const) {
        const h = await start({
          tiers,
          kind: "diff",
          projectTier,
          modelAccess,
        });
        const [job] = await h.snapshotJobs();

        expect((await h.claim()).status).toBe(204);

        expect(await h.queue.get(job!.id)).toMatchObject({
          status: "failed",
          errorCode: "managed_model_unavailable",
        });
        expect(h.issuedJobTokens()).toEqual([]);
      }
    },
  );

  // #434-X5
  it("runs again once the plan lists the migrated entries, which is what the operator does after the release", async () => {
    const tiers = CONFIGURATIONS["a model per tier and kind"]!;
    const h = await start({
      tiers,
      kind: "diff",
      projectTier: "high",
      modelAccess: [entryIdOf("high-diff"), entryIdOf("medium-diff")],
    });

    const { job } = await h.claimed();

    expect(job.input.llm.model).toBe("tier/high-diff");
  });
});
