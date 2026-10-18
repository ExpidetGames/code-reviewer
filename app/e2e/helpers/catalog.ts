// SPDX-License-Identifier: Apache-2.0

// Fills the model catalog of the app under test the way the admin portal will, through the app's real catalog service
// on its database file (src/test-support/e2e-catalog-child.ts). The journeys never write rows themselves.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const CHILD = resolve(process.cwd(), "src/test-support/e2e-catalog-child.ts");

export type CatalogSeed = {
  /** What members read; it may not contain the model id. */
  name: string;
  description?: string;
  /** The real model id: operator data that no member page may show. */
  modelId: string;
  kinds: Array<"diff" | "dynamic">;
  sortOrder?: number;
};

/** Creates and releases the entries; returns the id of each by its name. */
export async function seedCatalog(
  databasePath: string,
  entries: readonly CatalogSeed[],
): Promise<Record<string, string>> {
  const { stdout } = await run(
    process.execPath,
    [
      "--no-warnings",
      "--conditions=react-server",
      CHILD,
      "seed",
      resolve(process.cwd(), databasePath),
      JSON.stringify(entries),
    ],
    { cwd: process.cwd() },
  );
  const line = stdout.trim().split("\n").at(-1) ?? "{}";
  return (JSON.parse(line) as { names: Record<string, string> }).names;
}
