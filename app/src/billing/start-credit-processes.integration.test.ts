// SPDX-License-Identifier: Apache-2.0

// #507-T02 and #507-T04 with real OS processes on one SQLite file: two app instances meet billing at the same moment, for one
// workspace or for two workspaces of one GitHub account, and exactly one start credit is written. better-sqlite3 blocks its
// thread, so only separate processes can overlap; the write lock of the transaction and the primary key of the memory of grants
// are what serialize them. (The same cases on Postgres, with connections of one pool, are in start-credit.integration.test.ts.)
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { startDbProcess, type DbProcess } from "../test-support/db-process.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../test-support/workspaces.ts";

const childScript = fileURLToPath(
  new URL("../test-support/start-credit-child.ts", import.meta.url),
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

async function bind(
  db: Awaited<ReturnType<typeof createTestDatabase>>["db"],
  workspaceId: string,
  accountId: number,
  installationId: string,
) {
  await createIntegrationsRepository(db, workspaceId).create({
    type: "github_app",
    displayName: `account-${String(accountId)}`,
    externalId: installationId,
    config: { accountId },
  });
}

describe("the start credit from two processes", () => {
  // #507-T02
  it("writes one entry when two processes meet billing for one workspace at the same moment", async () => {
    const { db, config } = await createTestDatabase();
    await setBillingSwitch(db, true);
    const workspaceId = await defaultWorkspaceId(db);
    await bind(db, workspaceId, 5001, "1");

    const answers = await runTogether<{ status: string }>([
      ["grant", config.path, workspaceId],
      ["grant", config.path, workspaceId],
    ]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([
      "already_granted",
      "granted",
    ]);
    const journal = createBillingJournalRepository(db, workspaceId);
    expect(
      (await journal.entries({ limit: 10 })).entries.filter(
        (entry) => entry.type === "start_credit",
      ),
    ).toHaveLength(1);
    expect(await journal.verify()).toMatchObject({ consistent: true });
  });

  // #507-T04
  it("writes one entry in total when two processes meet billing for two workspaces of one GitHub account", async () => {
    const { db, config } = await createTestDatabase();
    await setBillingSwitch(db, true);
    const one = await defaultWorkspaceId(db);
    const two = await addWorkspace(db, "second");
    await bind(db, one, 5002, "1");
    await bind(db, two, 5002, "2");

    const answers = await runTogether<{ status: string }>([
      ["grant", config.path, one],
      ["grant", config.path, two],
    ]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([
      "account_already_granted",
      "granted",
    ]);
    const credits = await db
      .selectFrom("billing_journal_entries")
      .selectAll()
      .where("type", "=", "start_credit")
      .execute();
    expect(credits).toHaveLength(1);
    expect(
      await db.selectFrom("billing_start_credit_grants").selectAll().execute(),
    ).toHaveLength(1);
  });
});
