// SPDX-License-Identifier: Apache-2.0

// Usage records for the tests of the operator API and the feed behind it: rows written straight into the tables,
// so a test chooses the id, the state and the time of settlement of each one (the repositories stamp the clock
// and generate the ids, which is what these tests must control). Every record belongs to a job of its workspace
// on a repository of its workspace, as it does in the app.
import type { Kysely } from "kysely";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { Database } from "../db/schema.ts";

export type SeededUsage = {
  workspaceId: string;
  /** Default: a new unique id. */
  id?: string;
  state?: "reserved" | "settled" | "void";
  reviewKind?: "diff" | "dynamic";
  keyMode?: "own" | "managed";
  modelTier?: string | null;
  costMicroUsd?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  reservedAt?: string;
  /** Default for a settled record: `reservedAt`. */
  settledAt?: string;
  /** Why a settled record carries no measurement (`no_result`), or that a newer push replaced the run (`superseded`). */
  settledReason?: "no_result" | "superseded" | null;
  /** What the job's stored result says; the feed must never show it. */
  jobResult?: unknown;
};

export function createUsageSeeder(db: Kysely<Database>) {
  const repositories = new Map<string, string>();
  let counter = 0;

  async function repositoryOf(workspaceId: string): Promise<string> {
    const known = repositories.get(workspaceId);
    if (known !== undefined) return known;
    const integration = await createIntegrationsRepository(
      db,
      workspaceId,
    ).create({
      type: "github_app",
      displayName: "acme",
      externalId: `installation-${workspaceId}`,
      config: {},
    });
    const repositoriesRepository = createRepositoriesRepository(
      db,
      workspaceId,
    );
    await repositoriesRepository.reconcile(integration.id, [
      {
        integrationId: integration.id,
        externalId: `repository-${workspaceId}`,
        fullName: "acme/private-widgets",
        url: "https://github.test/acme/private-widgets",
      },
    ]);
    const [repository] = await repositoriesRepository.list({
      integrationId: integration.id,
    });
    if (repository === undefined)
      throw new Error("The seeded repository was not created.");
    repositories.set(workspaceId, repository.id);
    return repository.id;
  }

  return {
    /** Writes one job and its usage record; returns the ids. */
    async seed(options: SeededUsage): Promise<{ id: string; jobId: string }> {
      counter += 1;
      const state = options.state ?? "settled";
      const reservedAt = options.reservedAt ?? "2026-10-14T12:00:00.000Z";
      const settledAt =
        state === "settled" ? (options.settledAt ?? reservedAt) : null;
      const jobId = `seeded-job-${counter}`;
      const id = options.id ?? `seeded-record-${counter}`;
      await db
        .insertInto("jobs")
        .values({
          id: jobId,
          workspace_id: options.workspaceId,
          repository_id: await repositoryOf(options.workspaceId),
          pr_number: counter,
          pr_url: `https://github.test/acme/private-widgets/pull/${counter}`,
          head_sha: "a".repeat(40),
          command: "review",
          args: "",
          trigger_kind: "webhook",
          review_kind: options.reviewKind ?? "diff",
          actor_login: "octocat",
          delivery_id: null,
          status: "succeeded",
          run_after: reservedAt,
          attempts: 0,
          runner_id: null,
          lease_token: null,
          claimed_at: reservedAt,
          heartbeat_at: null,
          lease_expires_at: null,
          result:
            options.jobResult === undefined
              ? null
              : JSON.stringify(options.jobResult),
          error_code: null,
          superseded_by: null,
          created_at: reservedAt,
          updated_at: reservedAt,
          finished_at: reservedAt,
        })
        .execute();
      const measured = state === "settled";
      await db
        .insertInto("usage_records")
        .values({
          id,
          workspace_id: options.workspaceId,
          job_id: jobId,
          review_kind: options.reviewKind ?? "diff",
          key_mode: options.keyMode ?? "own",
          model_tier: options.modelTier ?? null,
          state,
          cost_micro_usd: measured ? (options.costMicroUsd ?? null) : null,
          prompt_tokens: measured ? (options.promptTokens ?? null) : null,
          completion_tokens: measured
            ? (options.completionTokens ?? null)
            : null,
          reserved_at: reservedAt,
          settled_at: settledAt,
          settled_reason: measured ? (options.settledReason ?? null) : null,
        })
        .execute();
      return { id, jobId };
    },
  };
}
