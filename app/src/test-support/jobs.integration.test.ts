// SPDX-License-Identifier: LicenseRef-Proprietary

// The job queue fixture with a supplied connection does not know the database URL: reading its
// `databaseUrl` must fail loudly instead of handing a child process an empty URL.
import { describe, expect, it } from "vitest";
import { createJobQueueFixture } from "./jobs.ts";
import { createTestDatabase } from "./test-database.ts";

describe("the job queue fixture", () => {
  // #105 (review: jobs.ts database path "")
  it("throws instead of handing out an empty database URL for a supplied connection", async () => {
    const { db } = await createTestDatabase();
    const fixture = await createJobQueueFixture({ database: db });

    expect(() => fixture.databaseUrl).toThrow(/no database URL/);
  });
});
