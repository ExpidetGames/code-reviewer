// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { isTransientDatabaseError } from "./errors.ts";

describe("which database errors are worth another try", () => {
  // #499-T15
  it.each([
    ["40001", "a serialization failure"],
    ["40P01", "a deadlock"],
    ["55P03", "a lock that could not be taken"],
    ["57014", "a statement that timed out or was cancelled"],
    ["53300", "too many connections"],
    ["08006", "a connection that failed"],
    ["SQLITE_BUSY", "a busy SQLite database"],
    ["SQLITE_BUSY_SNAPSHOT", "a busy SQLite snapshot"],
    ["SQLITE_LOCKED", "a locked SQLite table"],
  ])("takes %s (%s) as transient", (code) => {
    expect(
      isTransientDatabaseError(Object.assign(new Error("x"), { code })),
    ).toBe(true);
  });

  // #499-T15
  it.each([
    ["42P01", "a table that does not exist"],
    ["42703", "a column that does not exist"],
    ["22P02", "a value of the wrong shape"],
    ["23505", "a unique violation"],
    ["SQLITE_ERROR", "a SQLite error in the statement"],
    ["SQLITE_CONSTRAINT", "a violated constraint"],
  ])("takes %s (%s) as deterministic", (code) => {
    expect(
      isTransientDatabaseError(Object.assign(new Error("x"), { code })),
    ).toBe(false);
  });

  // #499-T15
  it("takes an error without a code, a plain error and a non-error as deterministic", () => {
    expect(isTransientDatabaseError(new TypeError("not a number"))).toBe(false);
    expect(isTransientDatabaseError(undefined)).toBe(false);
    expect(isTransientDatabaseError("40P01")).toBe(false);
  });
});
