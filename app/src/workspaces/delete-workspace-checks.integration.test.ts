// SPDX-License-Identifier: LicenseRef-Proprietary

// Deleting a workspace completes the check runs of its waiting reviews on GitHub (#658), against the fake GitHub through the real
// App provider: a review that waited shows "Waiting" on its pull request, the deletion removes the job, so nothing else would
// ever complete that check run. It is best effort and never in the way of the deletion.
import { describe, expect, it } from "vitest";
import { createWorkspaceMembersRepository } from "../db/repositories/workspace-members-repository.ts";
import { createCheckRunsHarness } from "../test-support/check-runs-harness.ts";
import { insertUser } from "../test-support/users.ts";
import { createWorkspaceDeletion } from "./delete-workspace.ts";
import { createCheckFinisher, DELETED_CHECK_SUMMARY } from "./finish-checks.ts";
import { getProductIdentity } from "../product-identity/current.ts";

const PRODUCT = getProductIdentity();

async function start() {
  const t = await createCheckRunsHarness();
  const { db, workspaceId } = t.fixture;
  await insertUser(db, { id: "owner" });
  await createWorkspaceMembersRepository(db, workspaceId).add("owner", "owner");
  const name = (
    await db
      .selectFrom("workspaces")
      .select("name")
      .where("id", "=", workspaceId)
      .executeTakeFirstOrThrow()
  ).name;
  const lines: string[] = [];
  const deletion = createWorkspaceDeletion({
    db,
    now: t.fixture.clock.now,
    log: (line) => lines.push(line),
    finishChecks: createCheckFinisher({
      product: PRODUCT,
      registry: { resolve: () => t.provider },
      log: (line) => lines.push(line),
    }),
  });
  const remove = () =>
    deletion.delete({ workspaceId, actorId: "owner", confirmName: name });
  return { ...t, lines, remove, workspaceId };
}

describe("the check runs of a deleted workspace", () => {
  // #658-T03
  it("completes the check run of a waiting review as neutral, with the reason in words", async () => {
    const t = await start();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    expect(t.checkRuns()).toMatchObject([
      { status: "queued", output: { title: "Waiting" } },
    ]);

    expect(await t.remove()).toEqual({ ok: true });

    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      output: { summary: DELETED_CHECK_SUMMARY },
    });
    expect(t.lines.filter((line) => line.includes("CHECK_RUN"))).toEqual([]);
    expect(
      await t.fixture.db
        .selectFrom("jobs")
        .select("id")
        .where("workspace_id", "=", t.workspaceId)
        .execute(),
    ).toEqual([]);
  });

  // #658-T03
  it("makes no check run for a review that never had one", async () => {
    const t = await start();
    await t.fixture.enqueueNew();

    expect(await t.remove()).toEqual({ ok: true });

    expect(t.checkRuns()).toEqual([]);
  });

  // #658-T03
  it("deletes anyway and logs one line when GitHub cannot be reached for the installation", async () => {
    const t = await start();
    const first = await t.fixture.enqueueNew();
    await t.service.syncJob(first.id);
    t.fake.removeInstallation(4242);

    expect(await t.remove()).toEqual({ ok: true });

    expect(t.checkRuns()[0]).toMatchObject({ status: "queued" });
    const logged = t.lines.filter((line) =>
      line.includes("CHECK_RUN_NOT_COMPLETED"),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`workspace ${t.workspaceId}`);
    expect(
      await t.fixture.db
        .selectFrom("workspaces")
        .select("deleted_at")
        .where("id", "=", t.workspaceId)
        .executeTakeFirstOrThrow(),
    ).not.toEqual({ deleted_at: null });
  });

  // #658-T03
  it("deletes anyway when the completion itself throws something that is not an integration error", async () => {
    const t = await start();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    const lines: string[] = [];
    const deletion = createWorkspaceDeletion({
      db: t.fixture.db,
      now: t.fixture.clock.now,
      log: (line) => lines.push(line),
      finishChecks: () => Promise.reject(new TypeError("boom")),
    });
    const name = "Default workspace";

    expect(
      await deletion.delete({
        workspaceId: t.workspaceId,
        actorId: "owner",
        confirmName: name,
      }),
    ).toEqual({ ok: true });

    expect(
      lines.filter((line) => line.includes("CHECK_RUN_NOT_COMPLETED")),
    ).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("boom");
  });
});
