// SPDX-License-Identifier: Apache-2.0

// The job queue fixture with a supplied (Postgres) database has no file to open: reading its
// `databasePath` must fail loudly instead of handing a child process an empty path.
import { describe, expect, it } from "vitest";
import { createJobQueueFixture } from "./jobs.ts";
import { createTestDatabase } from "./test-database.ts";

describe("the job queue fixture", () => {
  // #105 (review: jobs.ts databasePath "")
  it("throws instead of handing out an empty database path for a supplied database", async () => {
    const { db } = await createTestDatabase();
    const fixture = await createJobQueueFixture({ database: db });

    expect(() => fixture.databasePath).toThrow(/no database file path/);
  });
});
