// SPDX-License-Identifier: Apache-2.0

// #434-T10: the managed model tiers are gone (ADR 0005, decision C1). A model is chosen as a catalog entry, and nothing
// reads the old tier data any more. This scan keeps it that way: no source file of the repository mentions a tier
// identifier, except the files that exist because old data exists (the migration that turned it into entries, the
// usage records that were written under the tiers, and the copy that explains such a run). The old data itself is
// deleted by a later migration, which removes the last entries of this list.
//
// The names are built from parts, so that this file does not carry them itself.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listSourceFiles } from "./spdx-headers/source-files.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const TERMS = [
  ["model", "Tier"],
  ["Model", "Tier"],
  ["MODEL", "_TIER"],
  ["managed", "_model_tiers"],
  ["model", "-tiers"],
  ["model", "_tier"],
  ["managed", "_tier_"],
  ["tier", "Availability"],
  ["Tier", "Availability"],
  ["TIER", "_NAME_PATTERN"],
].map((parts) => parts.join(""));

/** Where an old tier may still be named, and why. A path ending in `/` is a folder. */
const ALLOWED: ReadonlyArray<{ path: string; why: string }> = [
  {
    path: "app/src/ci/model-tiers-removed.test.ts",
    why: "this scan: the paths of its own list name the files",
  },
  {
    path: "app/src/db/migrations/index.ts",
    why: "registers the migration by its file name",
  },
  {
    path: "app/src/db/migrations/20261018160000_migrate_model_tiers_to_catalog.ts",
    why: "the migration that turns the old data into catalog entries",
  },
  {
    path: "app/src/db/migrations/model-tiers-to-catalog.ts",
    why: "its pure mapper, with the shape of the old data",
  },
  {
    path: "app/src/db/migrations/model-tiers-to-catalog.test.ts",
    why: "the mapper's test",
  },
  {
    path: "app/src/db/migrations/migrate-model-tiers-to-catalog.integration.test.ts",
    why: "the migration's test, on both engines",
  },
  {
    path: "app/integration-tests/http/model-tiers-migration-claim.integration.test.ts",
    why: "the differential test of the claim after the migration",
  },
  {
    path: "app/src/db/migrations/20261014150000_create_usage_records.ts",
    why: "a shipped migration is never edited: it made the column",
  },
  {
    path: "app/src/db/migrations/20261018090000_add_usage_record_catalog_entry.ts",
    why: "a shipped migration is never edited",
  },
  {
    path: "app/src/db/migrations/add-usage-record-catalog-entry.integration.test.ts",
    why: "the test of that shipped migration",
  },
  {
    path: "app/src/db/schema.ts",
    why: "the usage records keep their column for the runs that were written under a tier",
  },
  {
    path: "app/src/db/repositories/usage-records-repository.ts",
    why: "reads that column; nothing writes it",
  },
  {
    path: "app/src/db/repositories/usage-records-repository.integration.test.ts",
    why: "reads of old usage rows",
  },
  {
    path: "app/src/db/repositories/runs-repository.ts",
    why: "a run that was written under a tier still shows no cost",
  },
  {
    path: "app/src/runs/runs-service.integration.test.ts",
    why: "the Runs view of an old row",
  },
  {
    path: "app/src/db/migrations/create-model-catalog-entries.integration.test.ts",
    why: "the test of a shipped migration: it leaves the old operator setting alone",
  },
  {
    path: "app/integration-tests/http/operator-api-model-tiers-removed.integration.test.ts",
    why: "the removed operator route (its path is the subject of the test)",
  },
  {
    path: "app/integration-tests/http/plan-route-file.integration.test.ts",
    why: "the plan page of a workspace whose usage rows were written under a tier",
  },
  {
    path: "app/src/copy/model-choice.test.ts",
    why: "the copy scan still covers the sentence of the code an old run ended with",
  },
  {
    path: "app/src/runs/error-copy.test.ts",
    why: "the copy of the code an old run ended with",
  },
  {
    path: "app/src/runs/error-copy.ts",
    why: "the copy of the code an old run ended with",
  },
  {
    path: "app/src/operator-api/contract.ts",
    why: "the usage feed names a tier for an old row (the contract only grows)",
  },
  {
    path: "app/src/operator-api/usage-views.ts",
    why: "the usage feed names a tier for an old row",
  },
  {
    path: "app/src/operator-api/usage-views.test.ts",
    why: "the usage feed of an old row",
  },
  {
    path: "app/src/test-support/usage-seed.ts",
    why: "seeds old usage rows",
  },
  {
    path: "app/e2e/helpers/operator-api.ts",
    why: "the type of a usage item of the feed",
  },
  {
    path: "app/integration-tests/http/operator-api-usage.integration.test.ts",
    why: "the usage feed of an old row",
  },
  {
    path: "app/integration-tests/http/runner-api-usage.integration.test.ts",
    why: "the usage record of a run, old and new",
  },
  {
    path: "app/integration-tests/http/runner-api-selection.integration.test.ts",
    why: "a new managed run records no tier",
  },
  {
    path: "app/integration-tests/compatibility/operator-api-contract.integration.test.ts",
    why: "the contract of the usage feed",
  },
  {
    path: "app/src/usage/usage-summary.integration.test.ts",
    why: "usage of old rows",
  },
  {
    path: "app/e2e/operator/limited-workspace.e2e.ts",
    why: "the usage feed of the journey carries the nullable field",
  },
];

function allowed(path: string): boolean {
  return ALLOWED.some((entry) =>
    entry.path.endsWith("/")
      ? path.startsWith(entry.path)
      : path === entry.path,
  );
}

describe("the managed model tiers are gone", () => {
  // #434-T10
  it("names no tier identifier in any source file outside the list of files that exist for the old data", () => {
    const found: string[] = [];
    for (const path of listSourceFiles(repoRoot)) {
      if (allowed(path)) continue;
      const content = readFileSync(`${repoRoot}${path}`, "utf8");
      const term = TERMS.find((candidate) => content.includes(candidate));
      if (term !== undefined) found.push(`${path} mentions ${term}`);
    }
    expect(found).toEqual([]);
  });

  // #434-T10
  it("keeps the list honest: every file on it still exists and still names a tier", () => {
    const stale: string[] = [];
    for (const { path } of ALLOWED) {
      let content = "";
      try {
        content = readFileSync(`${repoRoot}${path}`, "utf8");
      } catch {
        stale.push(`${path} does not exist`);
        continue;
      }
      if (!TERMS.some((term) => content.includes(term)))
        stale.push(`${path} names no tier any more`);
    }
    expect(stale).toEqual([]);
  });
});
