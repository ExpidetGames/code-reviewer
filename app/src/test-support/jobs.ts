// SPDX-License-Identifier: Apache-2.0

// Fixtures for the job queue tests: a migrated database with one integration and a few repositories,
// a clock the test moves by hand, and a way to enqueue with sensible defaults.
import type { Kysely } from "kysely";
import { formatTimestamp } from "../db/codecs.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { toJob } from "../db/repositories/jobs-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { Database } from "../db/schema.ts";
import { createJobQueue, type JobQueue } from "../jobs/job-queue.ts";
import { createRunnerQueue, type RunnerQueue } from "../jobs/runner-queue.ts";
import type {
  EnqueueJobInput,
  Job,
  JobTriggerKind,
} from "../jobs/job-types.ts";
import type { JobStatus } from "../jobs/job-status.ts";
import type { JobQueueLimits } from "../jobs/job-limits.ts";
import { createTestDatabase } from "./test-database.ts";
import { defaultWorkspaceId } from "./workspaces.ts";

export const T0 = new Date("2026-10-10T12:00:00.000Z");

export function sha(letter: string): string {
  return letter.repeat(40);
}

export type TestClock = {
  now(): Date;
  set(date: Date): void;
  advance(ms: number): void;
};

export function createTestClock(start: Date = T0): TestClock {
  let current = start;
  return {
    now: () => current,
    set(date) {
      current = date;
    },
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
  };
}

/**
 * The queue of one workspace together with the runner side of the queue, for tests that enqueue and
 * claim through one object. In the app these are two objects: the runner side is not scoped.
 */
export type TestQueue = JobQueue & RunnerQueue;

export function createTestQueue(
  db: Kysely<Database>,
  workspaceId: string,
  options: { now?: () => Date; limits?: Partial<JobQueueLimits> } = {},
): TestQueue {
  return {
    ...createJobQueue(db, workspaceId, options),
    ...createRunnerQueue(db, options),
  };
}

export type JobQueueFixture = {
  db: Kysely<Database>;
  workspaceId: string;
  /**
   * The path of the SQLite database file, for a second connection or a child process. A fixture on
   * a supplied (Postgres) database has no file: reading this throws instead of handing out an empty
   * path.
   */
  databasePath: string;
  queue: TestQueue;
  clock: TestClock;
  /** The first repository (it gets all jobs of `enqueue` unless told otherwise). */
  repositoryId: string;
  otherRepositoryId: string;
  /** Enqueues an automatic review job on PR 7 for `sha("a")`, with any field overridden. */
  enqueue(
    overrides?: Partial<EnqueueJobInput>,
  ): ReturnType<JobQueue["enqueue"]>;
  /** The lease token stored for a job right now (what its current holder presents). */
  tokenOf(jobId: string): Promise<string>;
  /** Enqueues, expects a new job, and returns it. */
  enqueueNew(overrides?: Partial<EnqueueJobInput>): Promise<Job>;
  /**
   * Inserts a job row directly, for history tests only (#203): the queue cannot create a removed
   * command any more, but a database from before the upgrade still holds such rows.
   */
  seedHistoricalJob(overrides: {
    command: "review" | "improve" | "describe" | "ask";
    repositoryId?: string;
    prNumber?: number;
    /** Defaults to a finished, succeeded review. */
    status?: JobStatus;
    triggerKind?: JobTriggerKind;
    args?: string;
    result?: unknown;
    errorCode?: string | null;
    actorLogin?: string;
  }): Promise<Job>;
};

export async function createJobQueueFixture(
  options: {
    limits?: Partial<JobQueueLimits>;
    /** A database to seed instead of a fresh SQLite one (for the Postgres tests). */
    database?: Kysely<Database>;
  } = {},
): Promise<JobQueueFixture> {
  const created = options.database
    ? { db: options.database, databasePath: null as string | null }
    : await (async () => {
        const test = await createTestDatabase();
        return { db: test.db, databasePath: test.config.path as string | null };
      })();
  const { db } = created;
  const clock = createTestClock();
  const workspaceId = await defaultWorkspaceId(db);
  const integration = await createIntegrationsRepository(
    db,
    workspaceId,
    clock.now,
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const repositories = createRepositoriesRepository(db, workspaceId, clock.now);
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: "7001",
      fullName: "acme/widgets",
      url: "https://github.test/acme/widgets",
    },
    {
      integrationId: integration.id,
      externalId: "7002",
      fullName: "acme/gadgets",
      url: "https://github.test/acme/gadgets",
    },
  ]);
  const [first, second] = await repositories.list({
    integrationId: integration.id,
  });
  if (first === undefined || second === undefined)
    throw new Error("The fixture repositories were not created.");

  const queue = createTestQueue(db, workspaceId, {
    now: clock.now,
    limits: options.limits,
  });
  const defaults = (overrides: Partial<EnqueueJobInput>): EnqueueJobInput => ({
    repositoryId: first.id,
    prNumber: 7,
    prUrl: "https://github.test/acme/widgets/pull/7",
    headSha: sha("a"),
    command: "review",
    triggerKind: "webhook",
    actorLogin: "octocat",
    ...overrides,
  });
  return {
    db,
    workspaceId,
    get databasePath(): string {
      if (created.databasePath === null)
        throw new Error(
          "A Postgres job queue fixture has no database file path; use its connection.",
        );
      return created.databasePath;
    },
    queue,
    clock,
    repositoryId: first.id,
    otherRepositoryId: second.id,
    enqueue: (overrides = {}) => queue.enqueue(defaults(overrides)),
    async tokenOf(jobId) {
      const row = await db
        .selectFrom("jobs")
        .select("lease_token")
        .where("id", "=", jobId)
        .executeTakeFirstOrThrow();
      if (row.lease_token === null)
        throw new Error(`Job ${jobId} has no lease token.`);
      return row.lease_token;
    },
    async enqueueNew(overrides = {}) {
      const result = await queue.enqueue(defaults(overrides));
      if (result.status !== "created")
        throw new Error(`Expected a new job, got: ${result.reason}`);
      return result.job;
    },
    async seedHistoricalJob(overrides) {
      const status = overrides.status ?? "succeeded";
      const timestamp = formatTimestamp(clock.now());
      const id = crypto.randomUUID();
      await db
        .insertInto("jobs")
        .values({
          id,
          workspace_id: workspaceId,
          repository_id: overrides.repositoryId ?? first.id,
          pr_number: overrides.prNumber ?? 7,
          pr_url: "https://github.test/acme/widgets/pull/7",
          head_sha: sha("a"),
          command: overrides.command,
          args: overrides.args ?? "",
          trigger_kind: overrides.triggerKind ?? "comment",
          actor_login: overrides.actorLogin ?? "octocat",
          delivery_id: null,
          status,
          run_after: timestamp,
          attempts: 0,
          runner_id: null,
          lease_token: null,
          claimed_at: null,
          heartbeat_at: null,
          lease_expires_at: null,
          result:
            overrides.result === undefined
              ? null
              : JSON.stringify(overrides.result),
          error_code: overrides.errorCode ?? null,
          superseded_by: null,
          created_at: timestamp,
          updated_at: timestamp,
          finished_at:
            status === "queued" || status === "running" ? null : timestamp,
        })
        .execute();
      const row = await db
        .selectFrom("jobs")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      return toJob(row);
    },
  };
}
