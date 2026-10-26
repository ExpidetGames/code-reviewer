// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the health answer: ok while the database can be read, an error when it cannot, and an
// error (not a crash) when the app never opened its database.
import { describe, expect, it } from "vitest";
import {
  createEmptyTestDatabase,
  createTestDatabase,
} from "../test-support/test-database.ts";
import { checkHealth } from "./health.ts";

describe("the health check", () => {
  it("reports ok when the database can be read", async () => {
    const { db } = await createTestDatabase();

    expect(await checkHealth(() => db)).toEqual({ status: "ok" });
  });

  it("reports an error when the database has no schema", async () => {
    const { db } = await createEmptyTestDatabase();

    expect(await checkHealth(() => db)).toEqual({ status: "error" });
  });

  it("reports an error when the database was never opened", async () => {
    const report = await checkHealth(() => {
      throw new Error("The database is not initialized");
    });

    expect(report).toEqual({ status: "error" });
  });
});
