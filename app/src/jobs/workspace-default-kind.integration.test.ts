// SPDX-License-Identifier: LicenseRef-Proprietary

// #676-T04: the kind a job is pinned to when it is queued is the project's own, else the workspace default, else Diff. It
// is resolved inside the enqueue transaction.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import type { Database } from "../db/schema.ts";
import { createReviewSettingsService } from "../review-settings/service.ts";
import { builtInReviewSettings } from "../review-settings/settings.ts";
import { dynamicReviewEnabled } from "./dynamic-review-gate.ts";
import {
  createJobQueueFixture,
  createTestQueue,
  sha,
} from "../test-support/jobs.ts";
import { enqueueInWorkspace } from "../test-support/other-workspace-jobs.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { createJobReviewSettingsHooks } from "./review-settings-hooks.ts";
import { createTestDatabase } from "../test-support/test-database.ts";

describe("the kind of a queued job", () => {
  async function start() {
    const fixture = await createJobQueueFixture({
      dynamicReview: true,
    });
    const projects = createProjectsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );
    await projects.activate(fixture.repositoryId);
    const service = createReviewSettingsService({
      appSettings: createAppSettingsRepository(fixture.db, fixture.workspaceId),
      projects,
      builtIn: () => builtInReviewSettings("test/model"),
    });
    return { fixture, service };
  }

  it("is Diff while neither the project nor the workspace chose a kind", async () => {
    const { fixture } = await start();

    expect((await fixture.enqueueNew({})).reviewKind).toBe("diff");
  });

  it("is the workspace default for a project that chose no kind", async () => {
    const { fixture, service } = await start();
    await service.updateGlobalSettings({ reviewKind: "dynamic" }, "ada");

    const job = await fixture.enqueueNew({});

    expect(job).toMatchObject({ reviewKind: "dynamic", status: "queued" });
  });

  it("is the project's own kind where it chose one, whatever the workspace default is", async () => {
    const { fixture, service } = await start();
    await service.updateGlobalSettings({ reviewKind: "dynamic" }, "ada");
    await service.updateProjectSettings(fixture.repositoryId, {
      reviewKind: "diff",
    });

    expect((await fixture.enqueueNew({})).reviewKind).toBe("diff");
  });

  it("follows the default taken back: the next job is Diff again", async () => {
    const { fixture, service } = await start();
    await service.updateGlobalSettings({ reviewKind: "dynamic" }, "ada");
    await service.updateGlobalSettings({}, "ada");

    expect((await fixture.enqueueNew({})).reviewKind).toBe("diff");
  });

  it("leaves a job that is already queued on the kind it was queued for", async () => {
    const { fixture, service } = await start();
    const waiting = await fixture.enqueueNew({});
    await service.updateGlobalSettings({ reviewKind: "dynamic" }, "ada");

    expect((await fixture.queue.get(waiting.id))?.reviewKind).toBe("diff");
  });

  // #676-T04: the waiting reviews of a project that follows the default were queued for the other engine (review fix 5).
  describe("when the kind of the defaults changes", () => {
    async function twoProjects() {
      const fixture = await createJobQueueFixture({
        dynamicReview: true,
      });
      const projects = createProjectsRepository(
        fixture.db,
        fixture.workspaceId,
        fixture.clock.now,
      );
      await projects.activate(fixture.repositoryId);
      await projects.activate(fixture.otherRepositoryId);
      const make = (
        hooks: Parameters<typeof createReviewSettingsService>[0]["hooks"],
      ) =>
        createReviewSettingsService({
          appSettings: createAppSettingsRepository(
            fixture.db,
            fixture.workspaceId,
          ),
          projects,
          builtIn: () => builtInReviewSettings("test/model"),
          hooks,
        });
      const service = make(createJobReviewSettingsHooks(fixture.workspaceId));
      // The second project chose its own kind; the first follows the default.
      await service.updateProjectSettings(fixture.otherRepositoryId, {
        reviewKind: "diff",
      });
      const running = await fixture.enqueueNew({ prNumber: 7 });
      expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(
        running.id,
      );
      const waitingFollowing = await fixture.enqueueNew({
        prNumber: 8,
        headSha: sha("b"),
      });
      const waitingOwn = await fixture.enqueueNew({
        repositoryId: fixture.otherRepositoryId,
        prNumber: 9,
        headSha: sha("c"),
      });
      return { fixture, service, make, running, waitingFollowing, waitingOwn };
    }

    it("cancels the waiting reviews of the projects that follow it, and leaves a running review and a project with its own kind alone", async () => {
      const { fixture, service, running, waitingFollowing, waitingOwn } =
        await twoProjects();

      await service.updateGlobalSettings({ reviewKind: "dynamic" }, "ada");

      expect(await fixture.queue.get(waitingFollowing.id)).toMatchObject({
        status: "cancelled",
        errorCode: "review_kind_changed",
      });
      expect((await fixture.queue.get(running.id))?.status).toBe("running");
      expect((await fixture.queue.get(waitingOwn.id))?.status).toBe("queued");
    });

    it("cancels them when the default is taken back as well, and not when only something else of it changes", async () => {
      const { fixture, service, waitingFollowing } = await twoProjects();
      await service.updateGlobalSettings({ reviewKind: "diff" }, "ada");
      await service.updateGlobalSettings(
        { reviewKind: "diff", reviewVerdict: "any" },
        "ada",
      );
      expect((await fixture.queue.get(waitingFollowing.id))?.status).toBe(
        "queued",
      );

      await service.updateGlobalSettings({ reviewKind: "dynamic" }, "ada");
      expect((await fixture.queue.get(waitingFollowing.id))?.status).toBe(
        "cancelled",
      );
    });

    // #676-T04: the hook is made for one workspace; a repository of another one in the event cancels nothing there.
    it("does not touch the jobs of another workspace, whatever repositories the event names", async () => {
      const { fixture, waitingFollowing } = await twoProjects();
      const other = await addWorkspace(fixture.db, "other");
      const foreignJob = await enqueueInWorkspace(fixture, other);
      const foreign = await fixture.db
        .selectFrom("jobs")
        .select("repository_id")
        .where("id", "=", foreignJob)
        .executeTakeFirstOrThrow();

      await createJobReviewSettingsHooks(fixture.workspaceId)
        .onWorkspaceDefaultsKindChanged!(
        {
          previousKind: "diff",
          nextKind: "dynamic",
          followingRepositoryIds: [foreign.repository_id, fixture.repositoryId],
        },
        fixture.db,
      );

      expect((await fixture.queue.get(foreignJob))?.status).toBe("queued");
      expect((await fixture.queue.get(waitingFollowing.id))?.status).toBe(
        "cancelled",
      );
    });

    it("keeps the default and the waiting reviews as they were when what runs with the save fails", async () => {
      const { fixture, make, waitingFollowing } = await twoProjects();
      const real = createJobReviewSettingsHooks(fixture.workspaceId);
      const failing = make({
        async onProjectSettingsChanged() {},
        async onWorkspaceDefaultsKindChanged(event, executor) {
          await real.onWorkspaceDefaultsKindChanged!(event, executor);
          throw new Error("the settings save failed");
        },
      });

      await expect(
        failing.updateGlobalSettings({ reviewKind: "dynamic" }, "ada"),
      ).rejects.toThrow("the settings save failed");

      expect((await fixture.queue.get(waitingFollowing.id))?.status).toBe(
        "queued",
      );
      expect(
        (await failing.getGlobalSettings()).dynamic.effective.reviewKind,
      ).toBe("diff");
    });
  });
});

// #676-T04: a review that is being queued while the defaults change must not escape the cancellation. The enqueue locks
// its repository row and then reads the default; the save of the defaults takes the same row lock before it decides which
// projects follow and cancels their jobs, so one of the two waits for the other. Needs two connections, so Postgres only.
describe("a review queued while the kind of the defaults changes (Postgres)", () => {
  async function waitForBlockedQuery(db: Kysely<Database>) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { rows } = await sql<{
        blocked: string;
      }>`select count(*) as blocked from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`.execute(
        db,
      );
      if (Number(rows[0]?.blocked ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("The save of the defaults never waited for a lock.");
  }

  it("is cancelled with the others when the enqueue has not committed yet, so no follower keeps a waiting job of the old kind", async () => {
    const { db } = await createTestDatabase();
    const fixture = await createJobQueueFixture({
      dynamicReview: true,
      database: db,
    });
    const projects = createProjectsRepository(
      db,
      fixture.workspaceId,
      fixture.clock.now,
    );
    await projects.activate(fixture.repositoryId);
    const service = createReviewSettingsService({
      appSettings: createAppSettingsRepository(db, fixture.workspaceId),
      projects,
      builtIn: () => builtInReviewSettings("test/model"),
      hooks: createJobReviewSettingsHooks(fixture.workspaceId),
    });

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let queued!: (jobId: string) => void;
    const hasQueued = new Promise<string>((resolve) => (queued = resolve));
    // An enqueue that read the old default (Diff) and inserted its job, and has not committed.
    const enqueuing = db.transaction().execute(async (trx) => {
      const result = await createTestQueue(trx, fixture.workspaceId, {
        now: fixture.clock.now,
        dynamicReviewEnabled,
      }).enqueue({
        repositoryId: fixture.repositoryId,
        prNumber: 11,
        prUrl: "https://github.test/acme/widgets/pull/11",
        headSha: sha("d"),
        command: "review",
        triggerKind: "webhook",
        actorLogin: "octocat",
      });
      if (result.status !== "created")
        throw new Error("The job was not created.");
      queued(result.job.id);
      await held;
    });
    const jobId = await hasQueued;

    let saved = false;
    const saving = service
      .updateGlobalSettings({ reviewKind: "dynamic" }, "ada")
      .then(() => (saved = true));
    await waitForBlockedQuery(db);
    // The save waits for the enqueue's lock on the repository instead of cancelling what it cannot see.
    expect(saved).toBe(false);

    release();
    await enqueuing;
    await saving;

    expect(await fixture.queue.get(jobId)).toMatchObject({
      reviewKind: "diff",
      status: "cancelled",
      errorCode: "review_kind_changed",
    });
  });
});
