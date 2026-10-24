// SPDX-License-Identifier: LicenseRef-Proprietary

// Every producer of jobs (the GitHub webhook, a comment, the start button) must queue through
// `jobQueueFor` (src/jobs/shared.ts), because that is where the dispatch hook is attached (#326). A new
// producer that built its own `createJobQueue` would queue jobs that no Dispatcher is ever told about in
// webhook mode; this test fails for it, so the choice is made on purpose.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = join(import.meta.dirname, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === "test-support" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

const read = (path: string) => readFileSync(join(SOURCE, path), "utf8");

describe("the producers of jobs", () => {
  // #326-T09
  it("get their queue from jobQueueFor, the one place the dispatch hook is attached", () => {
    const builders = sourceFiles(SOURCE)
      .filter((path) => /\bcreateJobQueue\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SOURCE, path))
      .sort();

    // The definition, the shared factory, and the two hooks that only cancel waiting jobs.
    expect(builders).toEqual([
      "jobs/job-queue.ts",
      "jobs/project-hooks.ts",
      "jobs/review-settings-hooks.ts",
      "jobs/shared.ts",
    ]);
    expect(read("jobs/shared.ts")).toMatch(/onEnqueued/);
  });

  // #326-T09
  it("are the webhook, the comment intake and the start button, all on jobQueueFor", () => {
    expect(read("webhooks/shared.ts")).toMatch(/jobQueueFor\(/);
    expect(read("manual-reviews/shared.ts")).toMatch(/jobQueueFor\(/);
  });
});
