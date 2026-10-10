// Pins down the structure of the nightly workflow (.github/workflows/nightly.yml): it runs the
// engine suite on a schedule with the same safeguards as the CI workflow (read-only token, no
// secrets, pinned actions and uv, a time limit). It reads the file as YAML; that GitHub triggers
// the schedule is not testable here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const source = readFileSync(`${repoRoot}.github/workflows/nightly.yml`, "utf8");

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Job = {
  if?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  defaults?: { run?: { "working-directory"?: string } };
  steps?: Step[];
};
type Workflow = {
  on: { schedule?: { cron?: string }[]; workflow_dispatch?: unknown } & Record<
    string,
    unknown
  >;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

const workflow = parse(source) as Workflow;
const engine = workflow.jobs.engine;

function commandLines(job: Job): string[] {
  return (job.steps ?? [])
    .flatMap((step) => (step.run ? step.run.split("\n") : []))
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

describe("nightly workflow", () => {
  // CR-41-T15
  it("runs the engine suite on a schedule and on demand, and on nothing else", () => {
    expect(workflow.on.schedule?.length).toBe(1);
    expect(workflow.on.schedule?.[0]?.cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(Object.keys(workflow.on).sort()).toEqual([
      "schedule",
      "workflow_dispatch",
    ]);
  });

  // CR-41-T15
  it("runs pytest with the engine marker after it has primed the tiktoken cache", () => {
    const lines = commandLines(engine);

    expect(lines).toContain("uv run pytest -m engine");
    expect(
      lines.indexOf("uv run python scripts/prime_tiktoken_cache.py"),
    ).toBeGreaterThanOrEqual(0);
    expect(
      lines.indexOf("uv run python scripts/prime_tiktoken_cache.py"),
    ).toBeLessThan(lines.indexOf("uv run pytest -m engine"));
    expect(engine.defaults?.run?.["working-directory"]).toBe("runner");
  });

  // CR-41-T15
  it("grants the token read access to the contents only and uses no secrets", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(engine.permissions).toBeUndefined();
    expect(source).not.toMatch(/secrets\./);
    expect(source).not.toMatch(/continue-on-error/);
  });

  // CR-41-T15
  it("limits the run time and pins the uv version and every third party action", () => {
    expect(engine["timeout-minutes"]).toBeGreaterThan(0);
    expect(engine["timeout-minutes"]).toBeLessThanOrEqual(30);
    const uses = (engine.steps ?? []).flatMap((step) =>
      step.uses ? [step] : [],
    );
    for (const step of uses) {
      const action = String(step.uses);
      expect(action).toMatch(/@(v\d+(\.\d+){0,2}|[0-9a-f]{40})(\s|$)/);
      if (!action.startsWith("actions/"))
        expect(action).toMatch(/@[0-9a-f]{40}$/);
    }
    const setupUv = uses.find((step) =>
      step.uses?.startsWith("astral-sh/setup-uv@"),
    );
    expect(setupUv?.with?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // CR-41-T15
  it("does not run in forks", () => {
    expect(engine.if).toContain(
      "github.repository == 'ExpidetGames/code-reviewer'",
    );
  });
});
