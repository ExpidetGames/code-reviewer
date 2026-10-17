// SPDX-License-Identifier: Apache-2.0

// Pins down the structure of the CI workflow (.github/workflows/ci.yml) so that a refactor cannot
// quietly drop a check, swallow a failure, widen permissions or unpin an action. It reads the
// file as YAML; how GitHub actually runs it is verified by the CI runs themselves.
import { existsSync, readFileSync } from "node:fs";
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
  outputs?: Record<string, string>;
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

// Every `uses:` of a step: the actions of other repositories. A local action (`./.github/actions/<name>`, a
// composite action of this repository) is part of the commit under test and cannot be pinned.
function allUses(): string[] {
  return jobs.flatMap(([, job]) =>
    steps(job).flatMap((step) =>
      step.uses && !step.uses.startsWith("./") ? [step.uses] : [],
    ),
  );
}

function localUses(): string[] {
  return jobs.flatMap(([, job]) =>
    steps(job).flatMap((step) =>
      step.uses?.startsWith("./") ? [step.uses] : [],
    ),
  );
}

function jobNamed(id: string): Job {
  const job = workflow.jobs[id];
  if (!job) throw new Error(`workflow has no job "${id}"`);
  return job;
}

describe("CI workflow triggers and jobs", () => {
  // CR-16-T01, trigger changed by #129
  it("runs on pull requests into development and main and on pushes to development and main", () => {
    expect(workflow.on.pull_request?.branches).toEqual(["development", "main"]);
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

  // #105-PG-04
  it("runs the database integration tests against a Postgres service container as well as SQLite", () => {
    const job = jobNamed("app-fast");
    const services = job.services as
      Record<string, { image?: string }> | undefined;
    const integration = steps(job).find((step) => step.run === "pnpm test:int");
    const environment = integration?.env as Record<string, string> | undefined;

    expect(services?.postgres?.image).toMatch(/^postgres:/);
    expect(environment?.TEST_DATABASE_URL).toMatch(/^postgres:\/\//);
  });

  // #319-T06
  it("runs the unit suite a second time in serverless mode, so the two runtime modes cannot drift", () => {
    const job = jobNamed("app-serverless");
    const unit = steps(job).find((step) => step.run === "pnpm test");
    const environment = unit?.env as Record<string, string> | undefined;

    expect(environment?.APP_RUNTIME).toBe("serverless");
    expect(String(job.if)).toContain("needs.changes.outputs.app == 'true'");
    expect(jobNamed("ci-passed").needs).toContain("app-serverless");
    // Nothing here may be able to reach a database: the suite is the unit one.
    expect(job.services).toBeUndefined();
    expect(commandLines(job)).not.toContain("pnpm test:int");
  });

  // CR-16-T01
  it("checks lint, formatting, types and the unit, integration and contract tests of the runner", () => {
    const lines = commandLines(jobNamed("runner-fast"));

    for (const command of [
      "uv run ruff check . ../fakes",
      "uv run ruff format --check . ../fakes",
      "uv run pyright",
      "uv run pytest -m unit",
      'uv run pytest -m "integration or contract"',
    ]) {
      expect(lines, command).toContain(command);
    }
  });

  // #124
  it("lints and type-checks the Python under fakes/ with the runner's tools, in make verify and in CI", () => {
    const makefile = readFileSync(`${repoRoot}Makefile`, "utf8");
    const pyproject = readFileSync(`${repoRoot}runner/pyproject.toml`, "utf8");

    // CI and make verify run the same commands (`$(RUNNER) run` is `uv run` inside runner/).
    expect(makefile).toContain("$(RUNNER) run ruff check . ../fakes\n");
    expect(makefile).toContain(
      "$(RUNNER) run ruff format --check . ../fakes\n",
    );
    // Pyright takes its files from the pyproject include, for both entry points.
    const include = /\[tool\.pyright\][^[]*?include = \[([^\]]*)\]/.exec(
      pyproject,
    );
    expect(include?.[1]).toContain('"../fakes"');
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

  // CR-47 (the journey with the real runner)
  it("installs the runner and the tiktoken encoding before the browser journeys, from the lockfile and the cache", () => {
    const job = jobNamed("e2e");
    const names = steps(job).map((step) => step.name ?? step.uses ?? "");
    const install = steps(job).find((step) => step.run === "uv sync --locked");
    const prime = steps(job).find((step) =>
      step.run?.includes("scripts/prime_tiktoken_cache.py"),
    );
    const firstJourney = names.findIndex((name) =>
      name.startsWith("Run the smoke journeys"),
    );

    expect(install?.["working-directory"]).toBe("runner");
    expect(prime?.["working-directory"]).toBe("runner");
    const position = (prefix: string) =>
      names.findIndex((name) => name.startsWith(prefix));
    // uv before it is used, the cache restored before the script that fills it, both before the
    // journeys.
    expect(position("astral-sh/setup-uv@")).toBeGreaterThanOrEqual(0);
    expect(position("astral-sh/setup-uv@")).toBeLessThan(
      position("Install the runner"),
    );
    expect(position("Restore the tiktoken encoding")).toBeGreaterThanOrEqual(0);
    expect(position("Restore the tiktoken encoding")).toBeLessThan(
      position("Prime the tiktoken cache"),
    );
    expect(position("Install the runner")).toBeLessThan(firstJourney);
    expect(position("Prime the tiktoken cache")).toBeLessThan(firstJourney);
    expect(
      steps(job).some(
        (step) =>
          step.uses?.startsWith("actions/cache@") &&
          step.with?.path === "/tmp/data-gym-cache",
      ),
    ).toBe(true);
  });

  // CR-47 (the journey with the real runner)
  it("runs the browser journeys for runner changes too, because one of them runs the real runner", () => {
    const condition = String(jobNamed("e2e").if);

    expect(condition).toContain("needs.changes.outputs.app == 'true'");
    expect(condition).toContain("needs.changes.outputs.runner == 'true'");
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

describe("CI compose job", () => {
  // CR-37 (compose smoke test)
  it("builds both images without pushing and smoke tests the stack against them", () => {
    const job = jobNamed("compose");
    const builds = steps(job).filter((step) =>
      step.uses?.startsWith("docker/build-push-action@"),
    );

    expect(builds.map((step) => step.with?.file).sort()).toEqual([
      "app/Dockerfile",
      "runner/Dockerfile",
    ]);
    for (const build of builds) {
      expect(build.with?.context).toBe(".");
      expect(build.with?.load).toBe(true);
      expect(build.with?.push).toBe(false);
    }
    expect(commandLines(job)).toContain(
      "docker/smoke/compose.sh code-reviewer-app:ci code-reviewer-runner:ci",
    );
  });

  // #106-IM-20
  it("also starts the image it built on the database and the environment of the previous release", () => {
    expect(commandLines(jobNamed("compose"))).toContain(
      "docker/smoke/upgrade.sh code-reviewer-app:ci",
    );
  });

  // CR-37 (compose smoke test)
  it("runs on pull requests that touch the app or the runner, and on every pull request into main", () => {
    const condition = jobNamed("compose").if ?? "";

    expect(condition).toContain("github.event_name == 'pull_request'");
    expect(condition).toContain("github.base_ref == 'main'");
    expect(condition).toContain("needs.changes.outputs.app == 'true'");
    expect(condition).toContain("needs.changes.outputs.runner == 'true'");
  });
});

describe("CI contract types check", () => {
  // #318-T02
  it("checks the generated contract types in the app job, after the typecheck", () => {
    const lines = commandLines(jobNamed("app-fast"));

    expect(lines).toContain("pnpm contracts:check");
    expect(lines.indexOf("pnpm contracts:check")).toBeGreaterThan(
      lines.indexOf("pnpm typecheck"),
    );
  });

  // #318-T02
  it("is part of make verify, so the check can be run before opening a pull request", () => {
    const makefile = readFileSync(`${repoRoot}Makefile`, "utf8");

    expect(makefile).toMatch(/^verify: .*\bcheck-contracts\b/m);
    expect(makefile).toMatch(
      /^check-contracts:\n\t\$\(APP\) contracts:check$/m,
    );
    expect(makefile).toMatch(
      /^generate-contracts:\n\t\$\(APP\) contracts:generate$/m,
    );
  });
});

describe("CI license job", () => {
  // #118-T01
  it("installs both parts from their lockfiles and runs the dependency license check", () => {
    const job = jobNamed("licenses");
    const lines = commandLines(job);

    expect(lines).toContain("pnpm install --frozen-lockfile");
    expect(lines).toContain("uv sync --locked");
    expect(lines).toContain("pnpm licenses:check");
    // Installing comes first: the check reads the metadata of what is installed.
    expect(lines.indexOf("pnpm licenses:check")).toBeGreaterThan(
      lines.indexOf("uv sync --locked"),
    );
    expect(lines.indexOf("pnpm licenses:check")).toBeGreaterThan(
      lines.indexOf("pnpm install --frozen-lockfile"),
    );
    expect(
      steps(job).find((step) => step.run === "uv sync --locked")?.[
        "working-directory"
      ],
    ).toBe("runner");
  });

  // #118-T01
  it("runs for code changes of either part and for every pull request into main and push", () => {
    const condition = String(jobNamed("licenses").if);

    expect(condition).toContain("github.event_name == 'push'");
    expect(condition).toContain("github.base_ref == 'main'");
    expect(condition).toContain("needs.changes.outputs.app == 'true'");
    expect(condition).toContain("needs.changes.outputs.runner == 'true'");
  });

  // #118-T01, #118-T04
  it("also checks the SPDX headers and the tests of the license policy, because the app tests that hold them are skipped for a runner-only pull request", () => {
    const lines = commandLines(jobNamed("licenses"));

    expect(lines).toContain("pnpm spdx:check");
    expect(lines).toContain(
      "pnpm exec vitest run --project unit src/ci/license-check",
    );
  });

  // #118-T01
  it("runs for a change that only touches THIRD_PARTY_LICENSES.md, which the Markdown exclusions of the app and runner filters skip", () => {
    const filterStep = steps(jobNamed("changes")).find(
      (step) => step.id === "filter",
    );
    const filters = parse(String(filterStep?.with?.filters)) as Record<
      string,
      string[]
    >;

    expect(filters.licenses).toEqual(["THIRD_PARTY_LICENSES.md"]);
    expect(jobNamed("changes").outputs).toHaveProperty("licenses");
    expect(String(jobNamed("licenses").if)).toContain(
      "needs.changes.outputs.licenses == 'true'",
    );
  });

  // #118-T01
  it("is a required part of the aggregate check, so a red license check blocks the merge", () => {
    expect(jobNamed("ci-passed").needs).toContain("licenses");
  });

  // #118-T01
  it("is part of make verify, so the check can be run before opening a pull request", () => {
    const makefile = readFileSync(`${repoRoot}Makefile`, "utf8");

    expect(makefile).toMatch(/^verify: .*\bcheck-licenses\b/m);
    expect(makefile).toMatch(/^check-licenses:\n\t\$\(APP\) licenses:check$/m);
  });
});

describe("CI Dispatcher job", () => {
  // #327 (CI wiring)
  it("checks formatting, lint, types and the unit and integration tests of the Dispatcher from its own lockfile", () => {
    const job = jobNamed("dispatcher-fast");
    const lines = commandLines(job);

    expect(job.defaults?.run?.["working-directory"]).toBe("dispatcher");
    for (const command of [
      "pnpm install --frozen-lockfile",
      "pnpm format:check",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm test:int",
    ]) {
      expect(lines, command).toContain(command);
    }
    expect(lines.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(
      lines.indexOf("pnpm test"),
    );
    expect(
      steps(job).find((step) => step.uses?.startsWith("pnpm/action-setup@"))
        ?.with?.package_json_file,
    ).toBe("dispatcher/package.json");
    expect(
      steps(job).find((step) => step.uses?.startsWith("actions/setup-node@"))
        ?.with?.["cache-dependency-path"],
    ).toBe("dispatcher/pnpm-lock.yaml");
  });

  // #327 (CI wiring)
  it("runs for Dispatcher changes, for every pull request into main and for pushes, and is part of the aggregate check", () => {
    const condition = String(jobNamed("dispatcher-fast").if);

    expect(condition).toContain("github.event_name == 'push'");
    expect(condition).toContain("github.base_ref == 'main'");
    expect(condition).toContain("needs.changes.outputs.dispatcher == 'true'");
    expect(jobNamed("dispatcher-fast").needs).toBe("changes");
    expect(jobNamed("ci-passed").needs).toContain("dispatcher-fast");
    expect(jobNamed("changes").outputs).toHaveProperty("dispatcher");
  });

  // #327 (CI wiring)
  it("installs the Dispatcher's dependencies in the license job and runs it for Dispatcher changes", () => {
    const job = jobNamed("licenses");
    const install = steps(job).find(
      (step) => step.name === "Install the dispatcher dependencies",
    );

    expect(install?.["working-directory"]).toBe("dispatcher");
    expect(install?.run).toBe("pnpm install --frozen-lockfile");
    expect(steps(job).indexOf(install as Step)).toBeLessThan(
      steps(job).findIndex((step) => step.run === "pnpm licenses:check"),
    );
    expect(String(job.if)).toContain(
      "needs.changes.outputs.dispatcher == 'true'",
    );
  });

  // #327 (CI wiring)
  it("is wired into every make target that covers a part, and into make verify through them", () => {
    const makefile = readFileSync(`${repoRoot}Makefile`, "utf8");

    expect(makefile).toMatch(/^lint: .*\blint-dispatcher\b/m);
    expect(makefile).toMatch(/^typecheck: .*\btypecheck-dispatcher\b/m);
    expect(makefile).toMatch(/^test-unit: .*\btest-unit-dispatcher\b/m);
    expect(makefile).toMatch(/^verify: lint typecheck /m);
    expect(makefile).toContain("$(DISPATCHER) test:int\n");
    expect(makefile).toContain("$(DISPATCHER) install --frozen-lockfile\n");
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
      "licenses",
      "compose",
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

  // #327 (CI wiring)
  it("sends a Dispatcher change, and a change to the contracts or the fakes it reads, to the Dispatcher job, and an app-only or runner-only change not", () => {
    for (const file of [
      "dispatcher/src/app.ts",
      "dispatcher/README.md",
      "contracts/dispatch-webhook.v1.json",
      "fakes/dispatcher-app/server.ts",
      "Makefile",
    ])
      expect(touched("dispatcher", file), file).toBe(true);
    for (const file of [
      "app/src/db/index.ts",
      "runner/src/code_reviewer_runner/cli.py",
      "README.md",
    ])
      expect(touched("dispatcher", file), file).toBe(false);
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

  // #412-T02
  it("calls only local actions that are in the repository", () => {
    for (const action of localUses())
      expect(
        existsSync(`${repoRoot}${action.slice(2)}/action.yml`),
        action,
      ).toBe(true);
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
  it("calls a reusable workflow only from the engine job, the one job exempt from its own time limit", () => {
    expect(
      jobs.filter(([, job]) => job.uses).map(([id, job]) => [id, job.uses]),
    ).toEqual([["engine", "./.github/workflows/engine.yml"]]);
  });

  // CR-16-T07
  it("limits the run time of every job", () => {
    // Only the job that calls the engine workflow is exempt: a job that calls a reusable workflow
    // cannot have its own limit, and the called workflow has one (engine-workflow.test.ts). Any
    // other job still needs a limit of its own.
    const exempt = (job: Job) => job.uses === "./.github/workflows/engine.yml";
    for (const [id, job] of jobs.filter(([, job]) => !exempt(job))) {
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
