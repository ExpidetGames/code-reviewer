// SPDX-License-Identifier: LicenseRef-Proprietary

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

  // #195-T04, #195 finding 9: the real cancellation runs first, then the save fails, so the rollback
  // must undo the cancellation itself — not merely skip it. The preserved running job still finishes.
  it("rolls back the cancellation when the save fails after it ran, and the running job still finishes", async () => {
    const fixture = await createJobQueueFixture({ dynamicReview: true });
    const projects = createProjectsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );
    await projects.activate(fixture.repositoryId);
    const working = serviceWith(
      fixture,
      createJobReviewSettingsHooks(fixture.workspaceId),
    );
    await working.updateProjectSettings(fixture.repositoryId, {
      reviewKind: "dynamic",
    });
    const running = await fixture.enqueueNew({
      prNumber: 7,
      reviewKind: "dynamic",
    });
    const claimed = await fixture.queue.claimNext("runner-a", ["opencode"]);
    expect(claimed?.job.id).toBe(running.id);
    const waiting = await fixture.enqueueNew({
      prNumber: 8,
      headSha: sha("b"),
      reviewKind: "dynamic",
    });

    const real = createJobReviewSettingsHooks(fixture.workspaceId);
    const failing = serviceWith(fixture, {
      async onProjectSettingsChanged(event, executor) {
        // Cancel the waiting jobs (the real work), then fail: both must roll back together.
        await real.onProjectSettingsChanged(event, executor);
        // Prove the real cancellation happened, through the same transaction, before the failure.
        expect(
          await executor
            .selectFrom("jobs")
            .select(["status", "error_code"])
            .where("workspace_id", "=", fixture.workspaceId)
            .where("id", "=", waiting.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ status: "cancelled", error_code: "review_kind_changed" });
        throw new Error("the settings save failed");
      },
    });
    await expect(
      failing.updateProjectSettings(fixture.repositoryId, {
        reviewKind: "diff",
      }),
    ).rejects.toThrow("the settings save failed");

    // Rolled back: the kind did not change, the waiting job was not cancelled, the running job stands.
    expect((await projects.get(fixture.repositoryId))?.settings).toMatchObject({
      reviewKind: "dynamic",
    });
    expect(await fixture.queue.get(waiting.id)).toMatchObject({
      status: "queued",
    });
    expect(await fixture.queue.get(running.id)).toMatchObject({
      status: "running",
    });

    // The restored waiting job makes progress too.
    const next = await fixture.queue.claimNext("runner-b", ["opencode"]);
    expect(next?.job.id).toBe(waiting.id);
    expect(
      await fixture.queue.complete(waiting.id, next!.leaseToken, {
        ok: true,
        result: {},
      }),
    ).toMatchObject({ status: "completed" });

    // The preserved running job can still be completed.
    const token = await fixture.tokenOf(running.id);
    expect(
      await fixture.queue.complete(running.id, token, { ok: true, result: {} }),
    ).toMatchObject({ status: "completed" });
  });
});
