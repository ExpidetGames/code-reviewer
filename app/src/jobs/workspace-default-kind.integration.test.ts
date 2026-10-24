// SPDX-License-Identifier: LicenseRef-Proprietary

// #676-T04: the kind a job is pinned to when it is queued is the project's own, else the workspace default, else Diff. It
// is resolved inside the enqueue transaction, on both engines (the Postgres cases run when TEST_DATABASE_URL is set).
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import type { Database } from "../db/schema.ts";
import { createReviewSettingsService } from "../review-settings/service.ts";
import { builtInReviewSettings } from "../review-settings/settings.ts";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import { createJobReviewSettingsHooks } from "./review-settings-hooks.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";

type Engine = {
  name: string;
  database: () => Promise<Kysely<Database> | undefined>;
};

const ENGINES: Engine[] = [
  { name: "SQLite", database: async () => undefined },
  ...(hasPostgres()
    ? [
        {
          name: "Postgres",
          database: async () => (await createPostgresTestDatabase()).db,
        },
      ]
    : []),
];

describe.each(ENGINES)("the kind of a queued job on $name", (engine) => {
  async function start() {
    const database = await engine.database();
    const fixture = await createJobQueueFixture({
      dynamicReview: true,
      ...(database === undefined ? {} : { database }),
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
      const database = await engine.database();
      const fixture = await createJobQueueFixture({
        dynamicReview: true,
        ...(database === undefined ? {} : { database }),
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
