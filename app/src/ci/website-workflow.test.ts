// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the workflow of the code-review.com landing page (.github/workflows/website.yml, #696): a lightweight check of
// website/ (its own pnpm project, deployed by Cloudflare, not by a workflow) that runs next to the heavy CI of ci.yml and
// shares nothing with it. It reads the file as YAML; that GitHub accepts a run is verified by the run itself.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const source = readFileSync(`${repoRoot}.github/workflows/website.yml`, "utf8");

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
} & Record<string, unknown>;
type Job = {
  "timeout-minutes"?: number;
  defaults?: { run?: { "working-directory"?: string } };
  permissions?: Record<string, string>;
  steps: Step[];
};
type Workflow = {
  on: {
    pull_request?: { branches?: string[]; paths?: string[] };
    push?: { branches?: string[]; paths?: string[] };
  } & Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

const workflow = parse(source) as Workflow;
const job = workflow.jobs.verify as Job;

describe("the website workflow", () => {
  // #696
  it("runs for pull requests into development and main and for pushes to them, only when website/ or this file changes", () => {
    const paths = ["website/**", ".github/workflows/website.yml"];

    expect(workflow.on.pull_request?.branches).toEqual(["development", "main"]);
    expect(workflow.on.push?.branches).toEqual(["development", "main"]);
    expect(workflow.on.pull_request?.paths).toEqual(paths);
    expect(workflow.on.push?.paths).toEqual(paths);
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push"]);
  });

  // #696
  it("has the read-only token, a timeout, and no secret and no deployment", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(15);
    expect(source).not.toMatch(/secrets\./);
    expect(source).not.toMatch(/wrangler deploy|^\s+environment:/m);
  });

  // #696
  it("installs from the lockfile of website/ and runs pnpm verify there, with the versions website/ pins", () => {
    const runs = job.steps.flatMap((step) =>
      step.run ? [step.run.trim()] : [],
    );
    const pnpm = job.steps.find((step) =>
      step.uses?.startsWith("pnpm/action-setup@"),
    );
    const node = job.steps.find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );

    expect(job.defaults?.run?.["working-directory"]).toBe("website");
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
  it("is not part of ci.yml, so the required check 'All checks passed?' never waits for it", () => {
    const ci = readFileSync(`${repoRoot}.github/workflows/ci.yml`, "utf8");
    const aggregate = (parse(ci) as Workflow).jobs["ci-passed"] as Job & {
      needs: string[];
    };

    expect(aggregate.needs).not.toContain("verify");
    expect(aggregate.needs).not.toContain("website");
  });
});
