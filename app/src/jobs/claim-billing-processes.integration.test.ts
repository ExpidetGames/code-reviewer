// SPDX-License-Identifier: Apache-2.0

// #498-T05 with real OS processes on one SQLite file: two app instances claim at the same moment and the last of a balance
// goes to exactly one of them. better-sqlite3 blocks its thread, so only separate processes can overlap; the write lock of
// the claim transaction is what serializes the balance check and the hold. (The same case on Postgres, with connections of
// one pool, is in claim-billing.integration.test.ts.)
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
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
  for (const child of children) child.send(`go ${String(startAt)}`);
  const answers = await Promise.all(
    children.map(async (child) => JSON.parse(await child.nextLine()) as T),
  );
  for (const child of children) expect(await child.exited).toBe(0);
  return answers;
}

describe("claiming the last of a balance from two processes", () => {
  // #498-T05
  it("gives the hold to exactly one of two runners and leaves one reservation", async () => {
    const fixture = await createJobQueueFixture();
    await setBillingSwitch(fixture.db, true);
    // One Diff hold on the workspace's own key: 25 minutes x 13,000.
    await fundWorkspace(fixture.db, fixture.workspaceId, 325_000);
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
    const journal = createBillingJournalRepository(
      fixture.db,
      fixture.workspaceId,
    );
    expect(
      (await journal.entries({ limit: 10 })).entries.filter(
        (entry) => entry.type === "reservation",
      ),
    ).toHaveLength(1);
    expect(await journal.verify()).toMatchObject({ consistent: true });
    expect(
      await fixture.db.selectFrom("usage_records").selectAll().execute(),
    ).toHaveLength(1);
  });
});
