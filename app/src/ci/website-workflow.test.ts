// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how CI checks the landing page (website/, #696): the job `website` of ci.yml (its own pnpm project, deployed by
// Cloudflare, not by a workflow) and how it takes part in the required check. It reads the file as YAML; that GitHub
// accepts a run is verified by the run itself.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readText, readWorkflow, repoRoot } from "./workflow-support.ts";

const workflow = readWorkflow("ci.yml");
const job = workflow.jobs.website;
if (!job) throw new Error("ci.yml has no website job");
const steps = job.steps ?? [];
const aggregate = workflow.jobs["ci-passed"];
const filter = (workflow.jobs.changes?.steps ?? []).find(
  (step) => step.id === "filter",
);

describe("the website job of ci.yml", () => {
  // #696
  it("has its own path output for website/**, which the job and nothing else of the website decides on", () => {
    expect(workflow.jobs.changes?.outputs).toHaveProperty("website");
    expect(String(filter?.with?.filters)).toMatch(
      /website:\n\s+- 'website\/\*\*'/,
    );
    expect(job.needs).toBe("changes");
    expect(job.if).toBe(
      "${{ github.event_name == 'push' || github.base_ref == 'main' || needs.changes.outputs.website == 'true' }}",
    );
  });

  // #696
  it("is part of the required check, so a failing website build blocks the merge", () => {
    expect(aggregate?.needs).toContain("website");
    expect(String(aggregate?.if)).toBe("${{ always() }}");
  });

  // #696
  it("has the read-only token, a timeout, and no secret and no deployment", () => {
    const source = readText(".github/workflows/ci.yml");
    const text = JSON.stringify(job);

    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(15);
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/wrangler deploy|environment/);
    expect(source).not.toMatch(/wrangler deploy/);
  });

  // #696
  it("installs from the lockfile of website/ and runs pnpm verify there, with the versions website/ pins", () => {
    const runs = steps.flatMap((step) => (step.run ? [step.run.trim()] : []));
    const pnpm = steps.find((step) =>
      step.uses?.startsWith("pnpm/action-setup@"),
    );
    const node = steps.find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );

    expect(job["defaults"]).toEqual({
      run: { "working-directory": "website" },
    });
    expect(runs).toEqual(["pnpm install --frozen-lockfile", "pnpm verify"]);
    expect(pnpm?.with?.package_json_file).toBe("website/package.json");
    expect(node?.with?.["node-version-file"]).toBe("website/.nvmrc");
    expect(node?.with?.["cache-dependency-path"]).toBe(
      "website/pnpm-lock.yaml",
    );
    expect(existsSync(`${repoRoot}website/pnpm-lock.yaml`)).toBe(true);
    expect(existsSync(`${repoRoot}website/.nvmrc`)).toBe(true);
  });

  // #696
  it("checks out the full history, which the sitemap takes the change dates of the pages from", () => {
    const checkout = steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );

    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  // #696
  it("has no workflow file of its own any more, so a website change does not run twice", () => {
    expect(existsSync(`${repoRoot}.github/workflows/website.yml`)).toBe(false);
  });
});
