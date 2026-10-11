// Pins down how the container images are built and published: the image jobs of the CI workflow
// (.github/workflows/ci.yml) only build and smoke test, and the publish workflow
// (.github/workflows/publish-images.yml) is the only place that holds the right to push to GHCR.
// It reads both files as YAML; how GitHub runs them is verified by the workflow runs themselves.
import { readFileSync } from "node:fs";
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
const publish = load("publish-images.yml");

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
  it("builds the images on pull requests only, because the publish workflow builds them on pushes", () => {
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

describe("Publish workflow triggers", () => {
  // CR-17-T02
  it("runs only for pushes to development and main, never for pull requests", () => {
    expect(Object.keys(publish.workflow.on)).toEqual(["push"]);
    expect(publish.workflow.on.push?.branches).toEqual(["development", "main"]);
  });

  // CR-17-T02
  it("pushes both images from one job after both were built and smoke tested", () => {
    const publishJob = jobNamed(publish.workflow, "publish");
    const lines = commandLines(publishJob);
    const indexOf = (text: string) =>
      lines.findIndex((line) => line.startsWith(text));

    expect(Object.keys(publish.workflow.jobs)).toEqual(["publish"]);
    expect(buildSteps(publishJob).map((step) => step.with?.file)).toEqual([
      "app/Dockerfile",
      "runner/Dockerfile",
    ]);
    for (const build of buildSteps(publishJob)) {
      expect(build.with?.context).toBe(".");
    }
    for (const { smoke } of IMAGES) {
      expect(indexOf(smoke), smoke).toBeGreaterThanOrEqual(0);
    }
    expect(indexOf("docker push")).toBeGreaterThan(
      indexOf("docker/smoke/runner.sh"),
    );
    // Commit tags of both images first, the floating tags (development, latest) last.
    expect(lines.filter((line) => line.startsWith("docker push"))).toEqual([
      'docker push "$APP_IMAGE:$SHA_TAG"',
      'docker push "$RUNNER_IMAGE:$SHA_TAG"',
      'docker push "$APP_IMAGE:$CHANNEL_TAG"',
      'docker push "$RUNNER_IMAGE:$CHANNEL_TAG"',
    ]);
  });

  // CR-17-T10
  it("builds and smoke tests before it logs in, so a failing build can never reach the registry", () => {
    const publishJob = jobNamed(publish.workflow, "publish");
    const all = steps(publishJob);
    const login = all.findIndex((step) =>
      step.uses?.startsWith("docker/login-action@"),
    );
    const lastSmoke = all.findIndex((step) =>
      step.run?.includes("docker/smoke/runner.sh"),
    );
    const firstPush = all.findIndex((step) =>
      step.run?.includes("docker push"),
    );

    expect(lastSmoke).toBeGreaterThanOrEqual(0);
    expect(login).toBeGreaterThan(lastSmoke);
    expect(firstPush).toBeGreaterThan(login);
  });

  // CR-17-T02
  it("only publishes from the project repository", () => {
    expect(jobNamed(publish.workflow, "publish").if).toContain(
      "github.repository == 'ExpidetGames/code-reviewer'",
    );
  });

  // CR-17-T02
  it("never cancels a running publish and runs the publishes of one branch one at a time", () => {
    expect(publish.workflow.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(publish.workflow.concurrency?.group).toContain("github.ref");
  });

  it("limits the run time of the publish job", () => {
    const minutes = jobNamed(publish.workflow, "publish")["timeout-minutes"];

    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThanOrEqual(30);
  });
});

describe("Publish workflow tags and names", () => {
  const publishJob = jobNamed(publish.workflow, "publish");
  const tagStep = steps(publishJob).find((step) => step.id === "tags");

  // CR-17-T02
  it("names the images after the project in the GHCR namespace of the organization", () => {
    expect(publish.workflow.env).toMatchObject({
      APP_IMAGE: "ghcr.io/expidetgames/code-reviewer-app",
      RUNNER_IMAGE: "ghcr.io/expidetgames/code-reviewer-runner",
    });
  });

  // CR-17-T02
  it("tags every image with the short commit hash, and development or latest by branch", () => {
    const script = tagStep?.run ?? "";

    expect(script).toContain("sha-${GITHUB_SHA::7}");
    expect(script).toMatch(/main\)\s*channel=latest/);
    expect(script).toMatch(/development\)\s*channel=development/);
    // Any other branch must stop the run instead of publishing an unexpected tag.
    expect(script).toMatch(/\*\)[\s\S]*exit 1/);
  });

  // CR-17-T02
  it("applies both tags to both images and labels the image with the commit", () => {
    for (const build of buildSteps(publishJob)) {
      const tags = String(build.with?.tags);

      expect(tags).toContain("steps.tags.outputs.sha_tag");
      expect(tags).toContain("steps.tags.outputs.channel_tag");
      expect(String(build.with?.labels)).toContain(
        "org.opencontainers.image.revision=${{ github.sha }}",
      );
      expect(build.with?.load).toBe(true);
      expect(build.with?.push).toBe(false);
    }
  });
});

describe("Publish workflow permissions", () => {
  // CR-17-T03
  it("grants the workflow read access to the contents and nothing else by default", () => {
    expect(publish.workflow.permissions).toEqual({ contents: "read" });
  });

  // CR-17-T03
  it("grants the right to write packages to the publishing job only", () => {
    const withWrite = Object.entries(publish.workflow.jobs).filter(
      ([, job]) => job.permissions?.packages === "write",
    );

    expect(withWrite.map(([id]) => id)).toEqual(["publish"]);
    expect(jobNamed(publish.workflow, "publish").permissions).toEqual({
      contents: "read",
      packages: "write",
    });
    expect(ci.source).not.toMatch(/packages:\s*write/);
  });

  // CR-17-T03
  it("logs in to GHCR with the token of the workflow run and no other secret", () => {
    const login = steps(jobNamed(publish.workflow, "publish")).find((step) =>
      step.uses?.startsWith("docker/login-action@"),
    );
    const secretReferences = publish.source.match(/secrets\.[A-Za-z0-9_]+/g);

    expect(login?.with).toMatchObject({
      registry: "ghcr.io",
      username: "${{ github.actor }}",
      password: "${{ secrets.GITHUB_TOKEN }}",
    });
    expect(secretReferences).toEqual(["secrets.GITHUB_TOKEN"]);
    expect(ci.source).not.toMatch(/secrets\./);
  });

  // CR-17-T03
  it("uses no privileged pull request trigger and does not persist git credentials", () => {
    const checkout = steps(jobNamed(publish.workflow, "publish")).find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );

    expect(Object.keys(publish.workflow.on)).not.toContain(
      "pull_request_target",
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  // CR-17-T03
  it("pins every action that is not maintained by GitHub to a commit hash and the rest to a major version", () => {
    const uses = Object.values(publish.workflow.jobs).flatMap((job) =>
      steps(job).flatMap((step) => (step.uses ? [step.uses] : [])),
    );

    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      if (action.startsWith("actions/")) {
        expect(action, action).toMatch(/@v\d+(\.\d+){0,2}$/);
        continue;
      }
      expect(action, action).toMatch(/@[0-9a-f]{40}(\s|$)/);
    }
  });

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
