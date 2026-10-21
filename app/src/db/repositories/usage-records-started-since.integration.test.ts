// SPDX-License-Identifier: Apache-2.0

// #499: how many reviews a workspace started after a moment (every usage record reserved later, whatever became of it), the read
// of the hidden hourly brake, on SQLite and on Postgres.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createJobQueueFixture } from "../../test-support/jobs.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import type { Database } from "../schema.ts";
import { createUsageRecordsRepository } from "./usage-records-repository.ts";

const databases: Array<
  [string, (() => Promise<Kysely<Database>>) | undefined]
> = [
  ["SQLite", undefined],
  [
    "Postgres",
    hasPostgres()
      ? async () => (await createPostgresTestDatabase({ poolMax: 4 })).db
      : undefined,
  ],
];

describe.each(databases)("the started reviews on %s", (name, open) => {
  const run = name === "Postgres" && open === undefined ? it.skip : it;

  async function setup() {
    const database = await open?.();
    const fixture = await createJobQueueFixture({
      dynamicReview: true,
      ...(database === undefined ? {} : { database }),
    });
    let pull = 0;
    const at = (iso: string) => () => new Date(iso);
    const records = (iso: string) =>
      createUsageRecordsRepository(fixture.db, fixture.workspaceId, at(iso));
    const newJob = () => {
      pull += 1;
      return fixture.enqueueNew({ prNumber: pull, reviewKind: "diff" });
    };
    return { fixture, records, newJob };
  }

  // #499-T05
  run(
    "counts the records reserved after a moment, of every state",
    async () => {
      const { records, newJob } = await setup();
      const settled = await newJob();
      const voided = await newJob();
      const running = await newJob();
      await records("2026-10-21T09:00:00.000Z").reserve(settled.id, "own");
      await records("2026-10-21T09:00:00.000Z").settle(settled.id, {
        state: "settled",
        costMicroUsd: 10,
        promptTokens: 1,
        completionTokens: 1,
      });
      await records("2026-10-21T09:10:00.000Z").reserve(voided.id, "own");
      await records("2026-10-21T09:10:00.000Z").settle(voided.id, {
        state: "void",
      });
      await records("2026-10-21T09:20:00.000Z").reserve(running.id, "own");
      const now = records("2026-10-21T10:00:00.000Z");

      expect(await now.startedSince("2026-10-21T08:59:59.999Z")).toBe(3);
      // Exclusive: a record exactly at the moment is not after it.
      expect(await now.startedSince("2026-10-21T09:00:00.000Z")).toBe(2);
      expect(await now.startedSince("2026-10-21T09:20:00.000Z")).toBe(0);
    },
  );

  // #499-T05
  run("never counts the records of another workspace", async () => {
    const { fixture, records, newJob } = await setup();
    const job = await newJob();
    await records("2026-10-21T09:00:00.000Z").reserve(job.id, "own");
    const other = await createUsageRecordsRepository(
      fixture.db,
      "some-other-workspace",
      () => new Date("2026-10-21T10:00:00.000Z"),
    ).startedSince("2026-10-21T08:00:00.000Z");

    expect(other).toBe(0);
  });

  // #499-T05
  run(
    "leaves out the record of the job that asks, so a job claimed again is not counted against itself",
    async () => {
      const { records, newJob } = await setup();
      const first = await newJob();
      const second = await newJob();
      await records("2026-10-21T09:00:00.000Z").reserve(first.id, "own");
      await records("2026-10-21T09:00:00.000Z").reserve(second.id, "own");
      const now = records("2026-10-21T10:00:00.000Z");

      expect(
        await now.startedSince("2026-10-21T08:00:00.000Z", {
          exceptJobId: first.id,
        }),
      ).toBe(1);
      expect(
        await now.startedSince("2026-10-21T08:00:00.000Z", {
          exceptJobId: "no-such-job",
        }),
      ).toBe(2);
    },
  );
});
