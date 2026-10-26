// SPDX-License-Identifier: LicenseRef-Proprietary

// The landing identity is written and never read back by the app (#692): no page, route, log line or API answer carries it.
// A file outside this list that names one of the columns is a reader (or a writer) nobody decided on, so it fails here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");
const COLUMNS = /posthog_(distinct_id|session_id|captured_at)/;

/** The files that may name a column, with the reason. */
const ALLOWED = new Set([
  // The row type.
  "db/schema.ts",
  // The migration that adds the columns.
  "db/migrations/20261025140000_add_users_posthog_identity.ts",
  // The one writer.
  "landing-identity/store.ts",
  // The list of columns that migrations after an older one added (its tests compare rows without them).
  "test-support/columns-added-later.ts",
  // The program the sign-up journey runs to read the stored values from the Postgres database (the app shows them nowhere).
  "test-support/e2e-landing-identity-child.ts",
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)
      ? [path]
      : [];
  });
}

describe("the columns of the landing identity", () => {
  // #692-T07
  it("are named by the schema, the migration and the one writer only", () => {
    const naming = sourceFiles(SRC)
      .filter((file) => COLUMNS.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file))
      .sort();

    expect(naming).toEqual([...ALLOWED].sort());
  });
});
