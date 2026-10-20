// SPDX-License-Identifier: Apache-2.0

// Nothing of the catalog prices is served to a workspace (#549, Epic #489, principle 2 of #420): a member never sees a raw
// provider price, a provider name or a model id of the catalog. Only the admin portal's own routes and pages, the service
// and the database layer may use the module; a route under a workspace or the operator API importing it would fail here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");
/** Where `model-prices` may be imported from, relative to `src/`. */
const ALLOWED = [
  "model-prices/",
  "app/api/instance-portal/catalog-models/",
  "app/(app)/instance-portal/",
  // The screens of the admin portal that show the catalog (#554).
  "admin/catalog-models/",
  "db/",
  "models-dev/",
  "test-support/",
];

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("who imports the catalog prices", () => {
  // #549-T08
  it("is the admin portal only, never a workspace route, a page of a workspace or the operator API", () => {
    const offenders = sources(SRC)
      .map((path) => relative(SRC, path))
      .filter((path) => !ALLOWED.some((prefix) => path.startsWith(prefix)))
      .filter((path) =>
        /model-prices\//.test(readFileSync(join(SRC, path), "utf8")),
      );

    expect(offenders).toEqual([]);
  });
});
