// Pins down the structure of the engine workflow (.github/workflows/engine.yml), the one definition
// of the engine suite job that ci.yml and nightly.yml call: what it runs, that the suite runs
// without network, that it is read-only, without secrets, time limited and pinned. It reads the
// file as YAML; how GitHub runs it is verified by the CI runs themselves.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const source = readFileSync(`${repoRoot}.github/workflows/engine.yml`, "utf8");
const script = readFileSync(
  `${repoRoot}runner/scripts/run_engine_offline.sh`,
  "utf8",
);

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Job = {
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  defaults?: { run?: { "working-directory"?: string } };
  steps?: Step[];
};
type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

const workflow = parse(source) as Workflow;
const engine = workflow.jobs.engine as Job;
const steps = engine.steps ?? [];

function commandLines(): string[] {
  return steps
    .flatMap((step) => (step.run ? step.run.split("\n") : []))
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

describe("engine workflow", () => {
  // CR-41-T15
  it("is only started by other workflows", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_call"]);
  });

  // CR-41-T15
  it("installs from the lockfile and runs the suite with the marker through the offline script", () => {
    const lines = commandLines();

    expect(lines).toContain("uv sync --locked");
    expect(lines).toContain("scripts/run_engine_offline.sh");
    expect(lines.indexOf("uv sync --locked")).toBeLessThan(
      lines.indexOf("scripts/run_engine_offline.sh"),
    );
    expect(engine.defaults?.run?.["working-directory"]).toBe("runner");
  });

  // CR-41-T15
  it("runs pytest -m engine inside a network namespace after the tiktoken cache was filled", () => {
    expect(script).toContain("scripts/prime_tiktoken_cache.py");
    expect(script.indexOf("scripts/prime_tiktoken_cache.py")).toBeLessThan(
      script.indexOf("unshare --net"),
    );
    expect(script).toContain("pytest -m engine");
    expect(script).toContain("ip link set lo up");
    // The suite does not run as root, and the namespace is proven to have no way out.
    expect(script).toContain("setpriv --reuid");
    expect(script).toContain("is not isolated");
  });

  // CR-41-T15
  it("caches the tiktoken encoding", () => {
    const cache = steps.find((step) => step.uses?.startsWith("actions/cache@"));

    expect(cache?.with?.path).toBe("/tmp/data-gym-cache");
    expect(String(cache?.with?.key)).toContain("o200k_base");
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
    const uses = steps.filter((step) => step.uses);
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
});
