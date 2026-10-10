// The read side of the jobs table for the pages: the runs list, one run, and the latest run of each
// repository. It only reads: every change to a job goes through the job queue
// (`jobs-repository.ts`), which holds the rules. A run is a job together with the name of its
// repository, so the pages need no second lookup.
import "server-only";
import type { Kysely } from "kysely";
import type { JobStatus } from "../../jobs/job-status.ts";
import type { Job } from "../../jobs/job-types.ts";
import type { Database } from "../schema.ts";
import { toJob } from "./jobs-repository.ts";

/** A job with the `owner/name` of the repository it is about. */
export type StoredRun = { job: Job; project: string };

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
  list(filter: RunListFilter): Promise<{ runs: StoredRun[]; hasMore: boolean }>;
  /** One run by its id; undefined for an id nobody has. */
  get(id: string): Promise<StoredRun | undefined>;
  /** The newest job of each of the repositories (by creation time); repositories without one are left out. */
  latestPerRepository(repositoryIds: readonly string[]): Promise<Job[]>;
};

export function createRunsRepository(db: Kysely<Database>): RunsRepository {
  return {
    async list(filter) {
      let query = db
        .selectFrom("jobs")
        .innerJoin("repositories", "repositories.id", "jobs.repository_id")
        .selectAll("jobs")
        .select("repositories.full_name as project");
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
        runs: rows.slice(0, limit).map(({ project, ...row }) => ({
          job: toJob(row),
          project,
        })),
        hasMore: rows.length > limit,
      };
    },

    async get(id) {
      const row = await db
        .selectFrom("jobs")
        .innerJoin("repositories", "repositories.id", "jobs.repository_id")
        .selectAll("jobs")
        .select("repositories.full_name as project")
        .where("jobs.id", "=", id)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const { project, ...job } = row;
      return { job: toJob(job), project };
    },

    async latestPerRepository(repositoryIds) {
      if (repositoryIds.length === 0) return [];
      const rows = await db
        .selectFrom("jobs")
        .selectAll()
        .where("repository_id", "in", [...repositoryIds])
        .where("id", "=", (eb) =>
          eb
            .selectFrom("jobs as newer")
            .select("newer.id")
            .whereRef("newer.repository_id", "=", "jobs.repository_id")
            .orderBy("newer.created_at", "desc")
            .orderBy("newer.id", "desc")
            .limit(1),
        )
        .execute();
      return rows.map(toJob);
    },
  };
}
