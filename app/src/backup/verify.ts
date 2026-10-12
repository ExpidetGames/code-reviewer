// SPDX-License-Identifier: Apache-2.0

// Checks a SQLite file with `PRAGMA integrity_check`, the same check for a fresh backup and for a
// backup that is about to be restored.
import BetterSqlite3 from "better-sqlite3";
import { describeError, errorCode } from "./errors.ts";

/** Null when the file is a sound SQLite database, otherwise a short description of the problem. */
export function integrityProblem(path: string): string | null {
  let sqlite: BetterSqlite3.Database | undefined;
  try {
    sqlite = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
    const rows = sqlite.pragma("integrity_check") as Array<{
      integrity_check: string;
    }>;
    if (rows.length === 1 && rows[0]?.integrity_check === "ok") return null;
    // The first lines are enough to see what is wrong; a damaged file can produce thousands.
    return rows
      .slice(0, 3)
      .map((row) => row.integrity_check)
      .join("; ");
  } catch (error) {
    return `${errorCode(error) ?? "error"}: ${describeError(error)}`;
  } finally {
    sqlite?.close();
  }
}
