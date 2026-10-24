// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down that the tables created by our migrations are the tables Better Auth expects. Better
// Auth can compute the migration it would run for its configuration; after our migrations that plan
// must be empty. An upgrade of Better Auth, or a change of its configuration, that needs a new
// column fails here, and the fix is a new migration of ours, never a step run at start-up.
import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it } from "vitest";
import { createAuthHarness } from "../test-support/auth-harness.ts";

describe("the tables Better Auth needs", () => {
  it("are all created by our migrations, with nothing left for Better Auth to add", async () => {
    const harness = await createAuthHarness();

    const plan = await getMigrations(harness.auth.options, {
      throwOnUnsafe: false,
    });

    expect(plan.toBeCreated).toEqual([]);
    expect(plan.toBeAdded).toEqual([]);
    expect(plan.toBeAddedIndexes).toEqual([]);
    expect(plan.unsafeChanges).toEqual([]);
    expect(plan.schemaProblems).toEqual([]);
  });
});
