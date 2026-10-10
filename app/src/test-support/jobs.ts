// Fixtures for the job queue tests: a migrated database with one integration and a few repositories,
// a clock the test moves by hand, and a way to enqueue with sensible defaults.
import type { Kysely } from "kysely";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { Database } from "../db/schema.ts";
import { createJobQueue, type JobQueue } from "../jobs/job-queue.ts";
import type { EnqueueJobInput, Job } from "../jobs/job-types.ts";
import type { JobQueueLimits } from "../jobs/job-limits.ts";
import { createTestDatabase } from "./test-database.ts";

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

export type JobQueueFixture = {
  db: Kysely<Database>;
  /** The path of the database file, for a second connection or a child process. */
  databasePath: string;
  queue: JobQueue;
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
};

export async function createJobQueueFixture(
  options: { limits?: Partial<JobQueueLimits> } = {},
): Promise<JobQueueFixture> {
  const { db, config } = await createTestDatabase();
  const clock = createTestClock();
  const integration = await createIntegrationsRepository(db, clock.now).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const repositories = createRepositoriesRepository(db, clock.now);
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

  const queue = createJobQueue(db, { now: clock.now, limits: options.limits });
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
    databasePath: config.path,
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
  };
}
