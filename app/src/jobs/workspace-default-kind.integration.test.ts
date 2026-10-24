// SPDX-License-Identifier: Apache-2.0

// #676-T04: the kind a job is pinned to when it is queued is the project's own, else the workspace default, else Diff. It
// is resolved inside the enqueue transaction, on both engines (the Postgres cases run when TEST_DATABASE_URL is set).
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import type { Database } from "../db/schema.ts";
import { createReviewSettingsService } from "../review-settings/service.ts";
import { builtInReviewSettings } from "../review-settings/settings.ts";
import { createJobQueueFixture } from "../test-support/jobs.ts";
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
});
