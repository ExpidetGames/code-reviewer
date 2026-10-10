// Pins down the structure of the CI workflow (.github/workflows/ci.yml) so that a refactor cannot
// quietly drop a check, swallow a failure, widen permissions or unpin an action. It reads the
// file as YAML; how GitHub actually runs it is verified by the CI runs themselves.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflowSource = readFileSync(
  `${repoRoot}.github/workflows/ci.yml`,
  "utf8",
);

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
} & Record<string, unknown>;
type Job = {
  name?: string;
  needs?: string | string[];
  if?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  defaults?: { run?: { "working-directory"?: string } };
  steps?: Step[];
} & Record<string, unknown>;
type Workflow = {
  on: {
    pull_request?: { branches?: string[] };
    push?: { branches?: string[] };
  } & Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: string | boolean };
  jobs: Record<string, Job>;
};

const workflow = parse(workflowSource) as Workflow;
const jobs = Object.entries(workflow.jobs);

function steps(job: Job): Step[] {
  return job.steps ?? [];
}

function runCommands(job: Job): string[] {
  return steps(job).flatMap((step) => (step.run ? [step.run] : []));
}

function allRunCommands(): string[] {
  return jobs.flatMap(([, job]) => runCommands(job));
}

function allUses(): string[] {
  return jobs.flatMap(([, job]) =>
    steps(job).flatMap((step) => (step.uses ? [step.uses] : [])),
  );
}

function jobNamed(id: string): Job {
  const job = workflow.jobs[id];
  if (!job) throw new Error(`workflow has no job "${id}"`);
  return job;
}

describe("CI workflow triggers and jobs", () => {
  // CR-16-T01
  it("runs on pull requests into development, main and epic branches and on pushes to development and main", () => {
    expect(workflow.on.pull_request?.branches).toEqual([
      "development",
      "main",
      "CR-*",
    ]);
    expect(workflow.on.push?.branches).toEqual(["development", "main"]);
  });

  // CR-16-T01
  it("checks formatting, lint, types, unit tests and the production build of the app", () => {
    const commands = runCommands(jobNamed("app-fast")).join("\n");

    expect(commands).toContain("pnpm format:check");
    expect(commands).toContain("pnpm lint");
    expect(commands).toContain("pnpm typecheck");
    expect(commands).toContain("pnpm test");
    expect(commands).toContain("pnpm build");
  });

  // CR-16-T01
  it("checks lint, formatting, types and the unit, integration and contract tests of the runner", () => {
    const commands = runCommands(jobNamed("runner-fast")).join("\n");

    expect(commands).toContain("uv run ruff check .");
    expect(commands).toContain("uv run ruff format --check .");
    expect(commands).toContain("uv run pyright");
    expect(commands).toContain("uv run pytest -m unit");
    expect(commands).toContain('uv run pytest -m "integration or contract"');
  });

  it("runs the browser smoke tests against the production build with the system libraries installed", () => {
    const commands = runCommands(jobNamed("e2e")).join("\n");

    expect(commands).toContain(
      "pnpm exec playwright install --with-deps chromium",
    );
    expect(commands).toContain("pnpm test:e2e");
  });

  it("lints the workflow files with actionlint", () => {
    const commands = runCommands(jobNamed("actionlint")).join("\n");

    expect(commands).toContain("actionlint");
    expect(
      readFileSync(`${repoRoot}.github/actionlint.yaml`, "utf8"),
    ).toContain("self-hosted-runner");
  });
});

describe("CI workflow aggregate check", () => {
  // CR-16-T02
  it("provides one final job that waits for every other job and always runs", () => {
    const aggregate = jobNamed("ci-passed");
    const others = Object.keys(workflow.jobs).filter(
      (id) => id !== "ci-passed",
    );

    expect([...(aggregate.needs as string[])].sort()).toEqual(
      [...others].sort(),
    );
    expect(aggregate.if).toBe("${{ always() }}");
  });

  // CR-16-T09
  it("fails the aggregate job on failed or cancelled jobs and accepts skipped ones", () => {
    const aggregate = jobNamed("ci-passed");
    const failStep = steps(aggregate).find((step) =>
      step.run?.includes("exit 1"),
    );

    expect(failStep?.if).toContain("contains(needs.*.result, 'failure')");
    expect(failStep?.if).toContain("contains(needs.*.result, 'cancelled')");
    expect(failStep?.if).not.toContain("skipped");
  });
});

describe("CI workflow failure handling", () => {
  // CR-16-T03
  it("never lets a job or a step continue on error", () => {
    const flags: string[] = [];
    for (const [id, job] of jobs) {
      if (job["continue-on-error"] !== undefined) flags.push(id);
      for (const step of steps(job)) {
        if (step["continue-on-error"] !== undefined)
          flags.push(`${id}/${step.name ?? step.uses}`);
      }
    }

    expect(flags).toEqual([]);
    expect(workflowSource).not.toMatch(/continue-on-error/);
  });

  // CR-16-T03
  it("never swallows a failing command in a run step", () => {
    const swallowing = allRunCommands().filter((command) =>
      /\|\|\s*(true\b|:(\s|$)|exit\s+0\b)|\bset\s+\+e\b/.test(command),
    );

    expect(swallowing).toEqual([]);
  });
});

describe("CI workflow security", () => {
  // CR-16-T05
  it("grants the token read access to the repository contents only", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const [id, job] of jobs) {
      for (const [scope, level] of Object.entries(job.permissions ?? {})) {
        expect(["read", "none"], `${id} permission ${scope}`).toContain(level);
      }
    }
  });

  // CR-16-T05
  it("uses no repository secrets and no privileged pull request trigger", () => {
    expect(workflowSource).not.toMatch(/secrets\./);
    expect(Object.keys(workflow.on)).not.toContain("pull_request_target");
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push"]);
  });

  // CR-16-T06
  it("pins every action to a major version or a commit hash and never to a moving branch", () => {
    const uses = allUses();
    const pinned =
      /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@(v\d+(\.\d+){0,2}|[0-9a-f]{40})(\s|$)/;

    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action, action).toMatch(pinned);
      expect(action).not.toMatch(/@(main|master|latest)\b/);
    }
  });
});

describe("CI workflow installation and runtimes", () => {
  // CR-16-T07
  it("installs the app from its lockfile and the runner from uv.lock", () => {
    const appCommands = ["app-fast", "e2e"].flatMap((id) =>
      runCommands(jobNamed(id)),
    );
    const runnerCommands = runCommands(jobNamed("runner-fast"));

    expect(appCommands.join("\n")).toContain("pnpm install --frozen-lockfile");
    expect(runnerCommands.join("\n")).toContain("uv sync --locked");
    for (const command of allRunCommands()) {
      expect(command).not.toMatch(/pnpm install(?!.*--frozen-lockfile)/);
      expect(command).not.toMatch(/uv sync(?!.*--locked)/);
    }
  });

  // CR-16-T07
  it("takes the Node version from .nvmrc and the Python version from the runner project", () => {
    const setupNodeSteps = jobs.flatMap(([, job]) =>
      steps(job).filter((step) => step.uses?.startsWith("actions/setup-node@")),
    );

    expect(setupNodeSteps.length).toBeGreaterThan(0);
    for (const step of setupNodeSteps) {
      expect(step.with?.["node-version-file"]).toBe(".nvmrc");
      expect(step.with).not.toHaveProperty("node-version");
    }
    expect(workflowSource).not.toMatch(/\bnode-version:/);
    expect(workflowSource).not.toMatch(/\bpython-version:/);
    expect(jobNamed("runner-fast").defaults?.run?.["working-directory"]).toBe(
      "runner",
    );
    expect(readFileSync(`${repoRoot}.nvmrc`, "utf8").trim()).toMatch(/^\d+/);
    expect(
      readFileSync(`${repoRoot}runner/.python-version`, "utf8").trim(),
    ).toMatch(/^3\.\d+/);
  });

  // CR-16-T07
  it("limits the run time of every job", () => {
    for (const [id, job] of jobs) {
      expect(job["timeout-minutes"], `${id} timeout`).toBeGreaterThan(0);
      expect(job["timeout-minutes"], `${id} timeout`).toBeLessThanOrEqual(30);
    }
  });
});

describe("CI workflow concurrency", () => {
  // CR-16-T08
  it("cancels a superseded run for a pull request but never a run for a push", () => {
    const cancel = workflow.concurrency?.["cancel-in-progress"];

    expect(workflow.concurrency?.group).toContain("github.ref");
    expect(typeof cancel).toBe("string");
    expect(cancel).toBe("${{ github.event_name == 'pull_request' }}");
  });
});
