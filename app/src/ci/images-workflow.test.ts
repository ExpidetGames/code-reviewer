// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how the container images are built: the image jobs of the CI workflow
// (.github/workflows/ci.yml) only build and smoke test, and no workflow publishes an image (#677).
// It reads the files as YAML; how GitHub runs them is verified by the workflow runs themselves.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
} & Record<string, unknown>;
type Job = {
  name?: string;
  needs?: string | string[];
  if?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  steps?: Step[];
} & Record<string, unknown>;
type Workflow = {
  on: {
    pull_request?: { branches?: string[] };
    push?: { branches?: string[] };
  } & Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: string | boolean };
  env?: Record<string, string>;
  jobs: Record<string, Job>;
};

function load(file: string): { source: string; workflow: Workflow } {
  const source = readFileSync(`${repoRoot}.github/workflows/${file}`, "utf8");
  return { source, workflow: parse(source) as Workflow };
}

const ci = load("ci.yml");

function steps(job: Job): Step[] {
  return job.steps ?? [];
}

function jobNamed(workflow: Workflow, id: string): Job {
  const job = workflow.jobs[id];
  if (!job) throw new Error(`workflow has no job "${id}"`);
  return job;
}

function commandLines(job: Job): string[] {
  return steps(job).flatMap((step) =>
    (step.run ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
}

function buildSteps(job: Job): Step[] {
  return steps(job).filter((step) =>
    step.uses?.startsWith("docker/build-push-action@"),
  );
}

const IMAGES = [
  {
    job: "image-app",
    context: "app",
    dockerfile: "app/Dockerfile",
    smoke: "docker/smoke/app.sh",
  },
  {
    job: "image-runner",
    context: "runner",
    dockerfile: "runner/Dockerfile",
    smoke: "docker/smoke/runner.sh",
  },
] as const;

describe("CI image jobs", () => {
  // CR-17-T01
  it.each(IMAGES)(
    "builds the $context image on pull requests, loads it into the local daemon and does not push",
    ({ job, dockerfile }) => {
      const builds = buildSteps(jobNamed(ci.workflow, job));

      expect(builds).toHaveLength(1);
      // The build context is the repository root, because the images carry the license files of
      // the root (#118-T03).
      expect(builds[0]?.with?.context).toBe(".");
      expect(builds[0]?.with?.file).toBe(dockerfile);
      expect(builds[0]?.with?.load).toBe(true);
      expect(builds[0]?.with?.push).toBe(false);
    },
  );

  // CR-17-T01
  it("builds the images on pull requests only, because nothing is published from a push", () => {
    for (const { job } of IMAGES) {
      const condition = jobNamed(ci.workflow, job).if ?? "";

      expect(condition, job).toContain("github.event_name == 'pull_request'");
    }
  });

  // CR-17-T01
  it("skips an image when the path filter says nothing it is built from changed, except for pull requests into main", () => {
    expect(jobNamed(ci.workflow, "image-app").if).toContain(
      "needs.changes.outputs.app == 'true'",
    );
    expect(jobNamed(ci.workflow, "image-runner").if).toContain(
      "needs.changes.outputs.runner == 'true'",
    );
    for (const { job } of IMAGES) {
      expect(jobNamed(ci.workflow, job).if, job).toContain(
        "github.base_ref == 'main'",
      );
    }
  });

  // CR-17-T01
  it.each(IMAGES)(
    "runs the smoke test of the $context image against the image it just built",
    ({ job, smoke }) => {
      const lines = commandLines(jobNamed(ci.workflow, job));
      const build = buildSteps(jobNamed(ci.workflow, job))[0];
      const tags = String(build?.with?.tags);

      expect(tags).toMatch(/^code-reviewer-(app|runner):ci$/);
      expect(lines).toContain(`${smoke} ${tags}`);
    },
  );

  // CR-17-T03
  it("gives the image jobs no right beyond reading the repository and never logs in to a registry", () => {
    for (const { job } of IMAGES) {
      const current = jobNamed(ci.workflow, job);
      const uses = steps(current).flatMap((step) =>
        step.uses ? [step.uses] : [],
      );

      expect(current.permissions, job).toBeUndefined();
      expect(
        uses.some((action) => action.startsWith("docker/login-action@")),
        job,
      ).toBe(false);
      expect(commandLines(current).join("\n"), job).not.toMatch(
        /docker\s+(push|login)/,
      );
    }
  });

  it("lets the aggregate check wait for both image jobs", () => {
    const needs = jobNamed(ci.workflow, "ci-passed").needs as string[];

    expect(needs).toContain("image-app");
    expect(needs).toContain("image-runner");
  });
});

describe("no image is published", () => {
  // #677: the source is visible but not licensed, and a public image would let anybody run the
  // service. The hosted deployment builds what it runs from the repository (deploy-production.yml
  // and golden-snapshot.yml), so nothing needs a registry.
  const workflowFiles = readdirSync(`${repoRoot}.github/workflows`).filter(
    (file) => file.endsWith(".yml"),
  );

  it("has no publish workflow", () => {
    expect(workflowFiles).not.toContain("publish-images.yml");
  });

  it.each(workflowFiles)(
    "%s never logs in to a registry, never pushes an image and never asks for the right to write packages",
    (file) => {
      const { source } = load(file);
      // Comments may explain why; only the instructions count.
      const code = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");

      expect(code).not.toMatch(/docker\/login-action@/);
      expect(code).not.toMatch(/docker\s+(push|login)/);
      expect(code).not.toMatch(/packages:\s*write/);
      expect(code).not.toMatch(/ghcr\.io\/itegro-gmbh/i);
      expect(code).not.toMatch(/\bpush:\s*true\b/);
    },
  );
});

describe("the actions of the image jobs", () => {
  it("pins the third-party image actions of the CI workflow to a commit hash too", () => {
    const uses = ["image-app", "image-runner"].flatMap((id) =>
      steps(jobNamed(ci.workflow, id)).flatMap((step) =>
        step.uses?.startsWith("docker/") ? [step.uses] : [],
      ),
    );

    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action, action).toMatch(/@[0-9a-f]{40}(\s|$)/);
    }
  });
});
