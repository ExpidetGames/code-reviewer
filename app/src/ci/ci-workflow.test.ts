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
  uses?: string;
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

// Every command line of every run step, trimmed, so a test can match a whole command instead of
// a substring ("pnpm test" must not be satisfied by "pnpm test:int").
function commandLines(job: Job): string[] {
  return runCommands(job).flatMap((command) =>
    command
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
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
    const lines = commandLines(jobNamed("app-fast"));

    for (const command of [
      "pnpm format:check",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm build",
    ]) {
      expect(lines, command).toContain(command);
    }
  });

  // CR-16-T01
  it("checks lint, formatting, types and the unit, integration and contract tests of the runner", () => {
    const lines = commandLines(jobNamed("runner-fast"));

    for (const command of [
      "uv run ruff check .",
      "uv run ruff format --check .",
      "uv run pyright",
      "uv run pytest -m unit",
      'uv run pytest -m "integration or contract"',
    ]) {
      expect(lines, command).toContain(command);
    }
  });

  // CR-41-T15
  it("runs the engine suite through the shared engine workflow in its own job", () => {
    const job = jobNamed("engine");

    expect(job.needs).toBe("changes");
    expect(job.uses).toBe("./.github/workflows/engine.yml");
    expect(job.steps).toBeUndefined();
  });

  // CR-41-T15
  it("runs the engine job for pull requests that change the runner and for pull requests into main, never for pushes or app-only changes", () => {
    const condition = String(jobNamed("engine").if);

    expect(condition).toContain("github.event_name == 'pull_request'");
    expect(condition).toContain("github.base_ref == 'main'");
    expect(condition).toContain("needs.changes.outputs.runner == 'true'");
    expect(condition).not.toContain("needs.changes.outputs.app");
    expect(condition).not.toContain("github.event_name == 'push'");
  });

  // CR-41-T15
  it("keeps the engine job read-only and without secrets", () => {
    const job = jobNamed("engine");

    expect(job.permissions).toEqual({ contents: "read" });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(job).not.toHaveProperty("secrets");
  });

  // CR-16-T01
  it("runs the browser smoke tests against the production build with the system libraries installed", () => {
    const lines = commandLines(jobNamed("e2e"));

    expect(lines).toContain(
      "pnpm exec playwright install --with-deps chromium",
    );
    expect(lines).toContain("pnpm test:e2e --grep @smoke --grep-invert @flaky");
    expect(lines).toContain("pnpm test:e2e --grep-invert @flaky");
  });

  // CR-16-T01
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

  // CR-16-T04
  it("fails the aggregate job when any job failed or was cancelled", () => {
    const failStep = steps(jobNamed("ci-passed")).find((step) =>
      step.run?.includes("exit 1"),
    );

    expect(failStep?.if).toContain("contains(needs.*.result, 'failure')");
    expect(failStep?.if).toContain("contains(needs.*.result, 'cancelled')");
  });

  // CR-16-T09
  it("does not fail the aggregate job on skipped jobs", () => {
    const failStep = steps(jobNamed("ci-passed")).find((step) =>
      step.run?.includes("exit 1"),
    );

    expect(failStep?.if).not.toContain("skipped");
  });

  // CR-41-T15
  it("waits for the engine job, blocks on its failure and accepts it skipped", () => {
    const aggregate = jobNamed("ci-passed");
    const failStep = steps(aggregate).find((step) =>
      step.run?.includes("exit 1"),
    );

    expect(aggregate.needs).toContain("engine");
    expect(failStep?.if).toContain("contains(needs.*.result, 'failure')");
    expect(failStep?.if).not.toContain("skipped");
  });

  // CR-16-T04
  it("runs the app, runner, browser and workflow jobs independently so one red job stops no other", () => {
    for (const id of [
      "app-fast",
      "runner-fast",
      "engine",
      "e2e",
      "actionlint",
    ]) {
      expect(jobNamed(id).needs, id).toBe("changes");
    }
  });
});

describe("CI workflow path filter", () => {
  const filterStep = steps(jobNamed("changes")).find(
    (step) => step.id === "filter",
  );
  const filters = parse(String(filterStep?.with?.filters)) as Record<
    string,
    string[]
  >;

  // dorny/paths-filter with predicate-quantifier "every": a changed file counts for a filter when
  // it matches every pattern, so "**" plus negations reads "anything except ...". Globs are
  // translated by hand because the action matches dotfiles and node:path does not.
  function matches(pattern: string, file: string): boolean {
    const negated = pattern.startsWith("!");
    const source = (negated ? pattern.slice(1) : pattern)
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "\u0000")
      .replace(/\*\*/g, "\u0001")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, "(?:.*/)?")
      .replace(/\u0001/g, ".*");
    return new RegExp(`^${source}$`).test(file) !== negated;
  }

  function touched(filter: string, file: string): boolean {
    return (filters[filter] ?? []).every((pattern) => matches(pattern, file));
  }

  // CR-16-T09
  it("skips both sides for a change to a Markdown file at the top level", () => {
    expect(touched("app", "README.md")).toBe(false);
    expect(touched("runner", "README.md")).toBe(false);
  });

  // CR-16-T09
  it("keeps Markdown inside app in the app filter because Prettier checks it", () => {
    expect(touched("app", "app/AGENTS.md")).toBe(true);
    expect(touched("runner", "app/AGENTS.md")).toBe(false);
  });

  // CR-16-T09
  it("sends a runner-only change to the runner side only", () => {
    expect(touched("runner", "runner/src/code_reviewer_runner/cli.py")).toBe(
      true,
    );
    expect(touched("app", "runner/src/code_reviewer_runner/cli.py")).toBe(
      false,
    );
    expect(touched("runner", "runner/docs/notes.md")).toBe(false);
  });

  // CR-16-T09
  it("sends a change to a shared file to both sides", () => {
    for (const file of [
      ".nvmrc",
      "Makefile",
      ".github/workflows/ci.yml",
      "fakes/github/server.ts",
    ]) {
      expect(touched("app", file), `app ${file}`).toBe(true);
      expect(touched("runner", file), `runner ${file}`).toBe(true);
    }
  });

  // CR-16-T09
  it("lints the workflow files when anything under .github changes", () => {
    expect(filters.workflows).toEqual([".github/**"]);
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

  // CR-16-T06
  it("pins every action that is not maintained by GitHub to a commit hash", () => {
    const thirdParty = allUses().filter(
      (action) => !action.startsWith("actions/"),
    );

    expect(thirdParty.length).toBeGreaterThan(0);
    for (const action of thirdParty) {
      expect(action, action).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  // CR-16-T06
  it("pins every Docker image started by a run step to an image digest", () => {
    const dockerLines = allRunCommands()
      .flatMap((command) => command.split("\n"))
      .filter((line) => /\bdocker\s+(run|pull|create)\b/.test(line));

    expect(dockerLines.length).toBeGreaterThan(0);
    for (const line of dockerLines) {
      expect(line, line).toMatch(/\S+@sha256:[0-9a-f]{64}/);
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
  });

  // CR-16-T07
  it("pins the uv version used by the runner job", () => {
    const setupUv = steps(jobNamed("runner-fast")).find((step) =>
      step.uses?.startsWith("astral-sh/setup-uv@"),
    );

    expect(setupUv?.with?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // CR-16-T07
  it("limits the run time of every job", () => {
    // A job that calls a reusable workflow cannot have its own limit; the called workflow has one
    // (engine-workflow.test.ts).
    for (const [id, job] of jobs.filter(([, job]) => !job.uses)) {
      expect(job["timeout-minutes"], `${id} timeout`).toBeGreaterThan(0);
      expect(job["timeout-minutes"], `${id} timeout`).toBeLessThanOrEqual(30);
    }
  });
});

describe("CI workflow concurrency", () => {
  // CR-16-T08
  it("cancels a superseded run for a pull request", () => {
    const cancel = workflow.concurrency?.["cancel-in-progress"];

    expect(workflow.concurrency?.group).toContain("github.ref");
    expect(cancel).toBe("${{ github.event_name == 'pull_request' }}");
  });

  // CR-16-T08
  it("gives every pushed commit its own concurrency group so no push run is cancelled or replaced", () => {
    const group = String(workflow.concurrency?.group);

    expect(group).toContain("github.event_name == 'push' && github.sha");
    expect(group).toContain("|| github.ref");
  });
});
