// SPDX-License-Identifier: Apache-2.0

// Rules that hold for every GitHub Actions file of the repository, the hosted deployment pipeline (#403) first:
// every third-party action is pinned to a commit, nothing runs on `pull_request_target`, and the Infisical sign-in
// is read from secrets only (this repository is public: a variable is world-readable) and only in the
// environment `production`.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  allActionFiles,
  isInfisicalLoad,
  type CompositeAction,
  type Job,
  type Workflow,
} from "./workflow-support.ts";

const files = allActionFiles();

/** Every `uses:` of a workflow or a composite action, with the file it is in. */
function usesOf(path: string, text: string): string[] {
  const document = parse(text) as Workflow | CompositeAction;
  const steps =
    "jobs" in document
      ? Object.values(document.jobs).flatMap((job) => job.steps ?? [])
      : document.runs.steps;
  const jobCalls =
    "jobs" in document
      ? Object.values(document.jobs).flatMap((job) =>
          job.uses === undefined ? [] : [job.uses],
        )
      : [];
  return [
    ...steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
    ...jobCalls,
  ].map((uses) => {
    expect(uses, path).toBeTruthy();
    return uses;
  });
}

describe("the GitHub Actions files", () => {
  it("find the workflows and the composite actions", () => {
    const paths = files.map(([path]) => path);
    expect(paths).toContain(".github/workflows/ci.yml");
    expect(paths).toContain(".github/workflows/deploy-production.yml");
    expect(paths).toContain(".github/actions/infisical-ci-secrets/action.yml");
  });

  // #403-T04
  it("pin every third-party action to a full commit SHA, and the first-party ones to a version", () => {
    for (const [path, text] of files)
      for (const uses of usesOf(path, text)) {
        if (uses.startsWith("./")) continue;
        if (uses.startsWith("actions/")) {
          expect(uses, `${path}: ${uses}`).toMatch(/^actions\/[\w-]+@v\d+$/);
          continue;
        }
        expect(uses, `${path}: ${uses}`).toMatch(/@[0-9a-f]{40}$/);
      }
  });

  // #403-T05
  it("never run on pull_request_target", () => {
    for (const [path, text] of files) {
      if (!path.includes("/workflows/")) continue;
      const workflow = parse(text) as Workflow;
      expect(Object.keys(workflow.on), path).not.toContain(
        "pull_request_target",
      );
    }
  });

  // #403-T06
  it("read the Infisical sign-in from secrets only, never from a variable", () => {
    for (const [path, text] of files) {
      expect(text, path).not.toMatch(/vars\.INFISICAL/);
      for (const match of text.matchAll(/secrets\.(INFISICAL_\w+)/g))
        expect(
          [
            "INFISICAL_CLIENT_ID",
            "INFISICAL_CLIENT_SECRET",
            "INFISICAL_DOMAIN",
            "INFISICAL_PROJECT_SLUG",
          ],
          path,
        ).toContain(match[1]);
    }
  });

  // #403-T06
  it("sign in to Infisical only in a job of the environment production, with all four values from secrets", () => {
    let loads = 0;
    for (const [path, text] of files) {
      if (!path.includes("/workflows/")) continue;
      const workflow = parse(text) as Workflow;
      for (const [name, job] of Object.entries(workflow.jobs) as Array<
        [string, Job]
      >) {
        for (const step of job.steps ?? []) {
          if (!isInfisicalLoad(step)) continue;
          loads += 1;
          expect(job.environment, `${path}: ${name}`).toBe("production");
          expect(step.with?.["client-id"]).toBe(
            "${{ secrets.INFISICAL_CLIENT_ID }}",
          );
          expect(step.with?.["client-secret"]).toBe(
            "${{ secrets.INFISICAL_CLIENT_SECRET }}",
          );
          expect(step.with?.domain).toBe("${{ secrets.INFISICAL_DOMAIN }}");
          expect(step.with?.["project-slug"]).toBe(
            "${{ secrets.INFISICAL_PROJECT_SLUG }}",
          );
        }
        // Nothing else uses the environment: it is the one that holds the sign-in.
        if (job.environment !== undefined)
          expect(job.environment, `${path}: ${name}`).toBe("production");
      }
    }
    expect(loads).toBeGreaterThanOrEqual(6);
  });

  // #403-T06
  it("keep the Vercel and Infisical values out of command lines and of the shell text", () => {
    for (const [path, text] of files) {
      if (!path.includes("/workflows/")) continue;
      const workflow = parse(text) as Workflow;
      for (const job of Object.values(workflow.jobs))
        for (const step of job.steps ?? []) {
          const run = step.run ?? "";
          expect(run, `${path}: ${step.name}`).not.toContain("${{");
          expect(run, `${path}: ${step.name}`).not.toMatch(
            /--token|set -x|--debug|xtrace/,
          );
        }
    }
  });
});
