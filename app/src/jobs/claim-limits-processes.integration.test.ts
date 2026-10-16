// SPDX-License-Identifier: Apache-2.0

// #277-T06 with real OS processes on one SQLite file: two app instances claim at the same moment, and the
// last unit of a limit goes to exactly one of them. better-sqlite3 blocks its thread, so only separate
// processes can overlap; the write lock of the claim transaction is what serializes the check and the
// reservation. (The same case on Postgres, with two pooled connections, is in claim-limits.integration.test.ts.)
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import { startDbProcess, type DbProcess } from "../test-support/db-process.ts";
import { createJobQueueFixture, sha, T0 } from "../test-support/jobs.ts";
import type { Job } from "./job-types.ts";

const childScript = fileURLToPath(
  new URL("../test-support/jobs-child.ts", import.meta.url),
);

/** Starts one child per argument list, releases them together and collects their JSON answers. */
async function runTogether<T>(argumentLists: string[][]): Promise<T[]> {
  const children: DbProcess[] = argumentLists.map((args) =>
    startDbProcess(args, childScript),
  );
  for (const child of children) expect(await child.nextLine()).toBe("ready");
  const startAt = Date.now() + 400;
  for (const child of children) child.send(`go ${startAt}`);
  const answers = await Promise.all(
    children.map(async (child) => JSON.parse(await child.nextLine()) as T),
  );
  for (const child of children) expect(await child.exited).toBe(0);
  return answers;
}

describe("claiming the last unit of a limit from two processes", () => {
  // #277-T06
  it("gives it to exactly one of two runners and leaves one record", async () => {
    const fixture = await createJobQueueFixture();
    await createWorkspaceEntitlementsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    ).put(
      {
        planLabel: "plan",
        keyMode: "own",
        limits: {
          diffRunsPerPeriod: 1,
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
    const one = await fixture.enqueueNew({ prNumber: 1 });
    const two = await fixture.enqueueNew({ prNumber: 2, headSha: sha("b") });

    const answers = await runTogether<{ job: Job | null }>(
      ["runner-a", "runner-b"].map((runner) => [
        "claim",
        fixture.databasePath,
        T0.toISOString(),
        runner,
      ]),
    );

    expect(answers.filter((answer) => answer.job !== null)).toHaveLength(1);
    const statuses = [
      (await fixture.queue.get(one.id))?.status,
      (await fixture.queue.get(two.id))?.status,
    ];
    expect(statuses.sort()).toEqual(["failed", "running"]);
    expect(
      await fixture.db.selectFrom("usage_records").selectAll().execute(),
    ).toHaveLength(1);
  });
});
