// SPDX-License-Identifier: LicenseRef-Proprietary

// A deployment without the `dynamic-review` capability has no Dynamic option (#731): a save of a project or of the workspace
// defaults that names the Dynamic kind is refused as a value that is no kind, and nothing is stored. Diff saves are untouched.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-support/test-database.ts";
import { setupReviewSettings } from "../test-support/review-settings-harness.ts";
import { ReviewSettingsError } from "./errors.ts";

const DIFF_ONLY = (kind: string) => kind === "diff";

async function start(kindAllowed?: (kind: "diff" | "dynamic") => boolean) {
  const { db } = await createTestDatabase();
  const app = await setupReviewSettings(db, {
    ...(kindAllowed === undefined ? {} : { kindAllowed }),
  });
  await app.projects.activate(app.first.id);
  return app;
}

async function issuesOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ReviewSettingsError) return error.issues;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

describe("saving settings in a deployment without dynamic-review", () => {
  // #731-T05
  it("refuses the Dynamic kind on a project and stores nothing", async () => {
    const app = await start(DIFF_ONLY);

    expect(
      await issuesOf(
        app.service.updateProjectSettings(app.first.id, {
          reviewKind: "dynamic",
        }),
      ),
    ).toEqual([{ field: "reviewKind", code: "INVALID_FORMAT" }]);
    expect((await app.projects.get(app.first.id))?.settings).toEqual({});
  });

  // #731-T05
  it("refuses the Dynamic kind in the workspace defaults and stores nothing", async () => {
    const app = await start(DIFF_ONLY);

    expect(
      await issuesOf(
        app.service.updateGlobalSettings(
          { reviewKind: "dynamic", maxFindings: 9 },
          "ada",
        ),
      ),
    ).toEqual([{ field: "reviewKind", code: "INVALID_FORMAT" }]);
    expect(await app.appSettings.get("review_defaults")).toBeUndefined();
  });

  // #731-T05
  it("still saves the Diff kind and the Diff settings", async () => {
    const app = await start(DIFF_ONLY);

    const saved = await app.service.updateProjectSettings(app.first.id, {
      reviewKind: "diff",
      maxFindings: 4,
    });

    expect(saved.dynamic.effective.reviewKind).toBe("diff");
    await app.service.updateGlobalSettings({ maxFindings: 9 }, "ada");
  });

  // #731-T01
  it("accepts the Dynamic kind where the capability exists, as before", async () => {
    const app = await start();

    const saved = await app.service.updateProjectSettings(app.first.id, {
      reviewKind: "dynamic",
    });

    expect(saved.dynamic.effective.reviewKind).toBe("dynamic");
  });
});
