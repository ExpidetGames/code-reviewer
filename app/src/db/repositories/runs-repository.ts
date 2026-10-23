// SPDX-License-Identifier: Apache-2.0

// The read side of the jobs table of ONE workspace (the factory takes the workspace id; see
// ../workspace-scope.ts) for the pages: the runs list, one run, and the latest run of each
// repository. It only reads: every change to a job goes through the job queue
// (`jobs-repository.ts`), which holds the rules. A run is a job together with the name of its
// repository, so the pages need no second lookup. The list is read without the columns it never
// shows (the stored result with the log, the arguments, the lease): it is asked for every few seconds
// by every open tab.
import "server-only";
import type { Kysely } from "kysely";
import type { JobStatus } from "../../jobs/job-status.ts";
import type { Job } from "../../jobs/job-types.ts";
import type { RunRowSource } from "../../runs/run-view.ts";
import type { Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";
import {
  decodeJobVocabulary,
  decodeReviewKind,
  toJob,
} from "./jobs-repository.ts";

/**
 * A job with the `owner/name` of the repository it is about, and whether it ran on a managed quality level (#283: its
 * usage record names one).
 */
export type StoredRun = {
  job: Job;
  project: string;
  /**
   * Whether the run was on the operator's key: its usage record says `managed`, names a catalog entry (#432) or a tier
   * (#280). The cost of such a run is not shown to a member.
   */
  onManagedKey: boolean;
  /**
   * The body of the review comment the run posted, as kept after the run ended (#657); null when none was kept, an empty
   * string when the comment could not be read. Untrusted text.
   */
  reviewComment: string | null;
};
/** A job as the list shows it: the listed fields only. */
export type StoredRunRow = { job: RunRowSource; project: string };

export type RunListFilter = {
  repositoryId?: string;
  status?: JobStatus;
  /** At most this many runs, newest first. */
  limit: number;
};

export type RunsRepository = {
  /**
   * The newest runs first (by creation time, then id), filtered by repository and status.
   * `hasMore` says whether more runs match than the limit lets through.
   */
  list(
    filter: RunListFilter,
  ): Promise<{ runs: StoredRunRow[]; hasMore: boolean }>;
  /** One run by its id; undefined for an id nobody has. */
  get(id: string): Promise<StoredRun | undefined>;
  /**
   * The newest job of each of the repositories (by creation time); repositories without one are left
   * out. One lookup per repository, each answered by the index `jobs_repository_recent`.
   */
  latestPerRepository(
    repositoryIds: readonly string[],
  ): Promise<
    Pick<
      Job,
      "repositoryId" | "status" | "createdAt" | "claimedAt" | "finishedAt"
    >[]
  >;
};

export function createRunsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
): RunsRepository {
  return {
    async list(filter) {
      let query = db
        .selectFrom("jobs")
        .innerJoin("repositories", "repositories.id", "jobs.repository_id")
        .select([
          "jobs.id",
          "jobs.repository_id",
          "jobs.pr_number",
          "jobs.pr_url",
          "jobs.command",
          "jobs.review_kind",
          "jobs.trigger_kind",
          "jobs.actor_login",
          "jobs.status",
          "jobs.created_at",
          "jobs.claimed_at",
          "jobs.finished_at",
          "jobs.error_code",
          "repositories.full_name as project",
        ])
        .where("jobs.workspace_id", "=", workspaceId);
      if (filter.repositoryId !== undefined)
        query = query.where("jobs.repository_id", "=", filter.repositoryId);
      if (filter.status !== undefined)
        query = query.where("jobs.status", "=", filter.status);
      const limit = Math.max(1, Math.trunc(filter.limit));
      // One more than asked for tells whether the list is cut off.
      const rows = await query
        .orderBy("jobs.created_at", "desc")
        .orderBy("jobs.id", "desc")
        .limit(limit + 1)
        .execute();
      return {
        runs: rows.slice(0, limit).map((row) => {
          const { status, command, triggerKind } = decodeJobVocabulary(row);
          return {
            project: row.project,
            job: {
              id: row.id,
              repositoryId: row.repository_id,
              prNumber: row.pr_number,
              prUrl: row.pr_url,
              command,
              reviewKind: decodeReviewKind(row),
              triggerKind,
              actorLogin: row.actor_login,
              status,
              createdAt: row.created_at,
              claimedAt: row.claimed_at,
              finishedAt: row.finished_at,
              errorCode: row.error_code,
            },
          };
        }),
        hasMore: rows.length > limit,
      };
    },

    async get(id) {
      const row = await db
        .selectFrom("jobs")
        .innerJoin("repositories", "repositories.id", "jobs.repository_id")
        .leftJoin("usage_records", (join) =>
          join
            .onRef("usage_records.job_id", "=", "jobs.id")
            .on("usage_records.workspace_id", "=", workspaceId),
        )
        .leftJoin("job_check_runs", (join) =>
          join
            .onRef("job_check_runs.job_id", "=", "jobs.id")
            .on("job_check_runs.workspace_id", "=", workspaceId),
        )
        .selectAll("jobs")
        .select("repositories.full_name as project")
        .select([
          "usage_records.key_mode as key_mode",
          "usage_records.catalog_entry_id as catalog_entry_id",
          "usage_records.model_tier as model_tier",
          "job_check_runs.review_comment as review_comment",
        ])
        .where("jobs.workspace_id", "=", workspaceId)
        .where("jobs.id", "=", id)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const {
        project,
        key_mode: keyMode,
        catalog_entry_id: entryId,
        model_tier: modelTier,
        review_comment: reviewComment,
        ...job
      } = row;
      return {
        job: toJob(job),
        project,
        onManagedKey:
          keyMode === "managed" || entryId !== null || modelTier !== null,
        reviewComment,
      };
    },

    async latestPerRepository(repositoryIds) {
      const newest = [];
      for (const repositoryId of new Set(repositoryIds)) {
        const row = await db
          .selectFrom("jobs")
          .select([
            "id",
            "status",
            "command",
            "trigger_kind",
            "created_at",
            "claimed_at",
            "finished_at",
          ])
          .where("workspace_id", "=", workspaceId)
          .where("repository_id", "=", repositoryId)
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .limit(1)
          .executeTakeFirst();
        if (row === undefined) continue;
        newest.push({
          repositoryId,
          status: decodeJobVocabulary(row).status,
          createdAt: row.created_at,
          claimedAt: row.claimed_at,
          finishedAt: row.finished_at,
        });
      }
      return newest;
    },
  };
}
