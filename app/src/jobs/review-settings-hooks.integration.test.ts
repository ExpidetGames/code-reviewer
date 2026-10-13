// SPDX-License-Identifier: Apache-2.0

// #195-T04: a project's review kind is pinned on every waiting job. Changing it cancels those waiting
// jobs in the very transaction that writes the settings (status `cancelled`, code `review_kind_changed`)
// while a running job finishes. If the save fails, the hook's rejection rolls everything back: the
// stored kind and the waiting jobs stay as they were.
import { describe, expect, it } from "vitest";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createReviewSettingsService } from "../review-settings/service.ts";
import { builtInReviewSettings } from "../review-settings/settings.ts";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import { createJobReviewSettingsHooks } from "./review-settings-hooks.ts";

function serviceWith(
  fixture: Awaited<ReturnType<typeof createJobQueueFixture>>,
  hooks: Parameters<typeof createReviewSettingsService>[0]["hooks"],
) {
  return createReviewSettingsService({
    appSettings: createAppSettingsRepository(fixture.db, fixture.workspaceId),
    projects: createProjectsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    ),
    builtIn: () => builtInReviewSettings("test/model"),
    hooks,
  });
}

describe("cancelling waiting reviews when the review kind changes", () => {
  // #195-T04
  it("cancels the waiting jobs with review_kind_changed and lets the running job finish", async () => {
    const fixture = await createJobQueueFixture();
    await createProjectsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    ).activate(fixture.repositoryId);
    const service = serviceWith(
      fixture,
      createJobReviewSettingsHooks(fixture.workspaceId),
    );

    const running = await fixture.enqueueNew({ prNumber: 7 });
    const claimed = await fixture.queue.claimNext("runner-a");
    expect(claimed?.job.id).toBe(running.id);
    const waiting = await fixture.enqueueNew({
      prNumber: 8,
      headSha: sha("b"),
    });

    await service.updateProjectSettings(fixture.repositoryId, {
      reviewKind: "dynamic",
    });

    expect(await fixture.queue.get(running.id)).toMatchObject({
      status: "running",
    });
    expect(await fixture.queue.get(waiting.id)).toMatchObject({
      status: "cancelled",
      errorCode: "review_kind_changed",
    });
  });

  // #195-T04
  it("keeps the stored kind and the waiting jobs when the save fails", async () => {
    const fixture = await createJobQueueFixture();
    await createProjectsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    ).activate(fixture.repositoryId);
    const working = serviceWith(
      fixture,
      createJobReviewSettingsHooks(fixture.workspaceId),
    );
    await working.updateProjectSettings(fixture.repositoryId, {
      reviewKind: "dynamic",
    });
    const waiting = await fixture.enqueueNew({
      prNumber: 8,
      headSha: sha("b"),
      reviewKind: "dynamic",
    });

    const failing = serviceWith(fixture, {
      async onProjectSettingsChanged() {
        throw new Error("the settings save failed");
      },
    });
    await expect(
      failing.updateProjectSettings(fixture.repositoryId, {
        reviewKind: "diff",
      }),
    ).rejects.toThrow("the settings save failed");

    // The kind did not change and the waiting Dynamic job was not cancelled.
    const stored = await createProjectsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    ).get(fixture.repositoryId);
    expect(stored?.settings).toMatchObject({ reviewKind: "dynamic" });
    expect(await fixture.queue.get(waiting.id)).toMatchObject({
      status: "queued",
    });
  });
});
