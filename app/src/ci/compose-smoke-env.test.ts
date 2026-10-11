// Pins down that docker/smoke/compose.sh starts from a clean environment: every variable the compose
// files it uses read is unset before the script exports its own dummy settings, so a value in the
// caller's shell or in CI can never change what the smoke test runs against. The list is derived from
// the compose files (docker/smoke/lib.sh, unset_compose_variables), so a new variable cannot be
// forgotten. The Docker part of the script is proven by running it (make test-compose).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const lib = `${repoRoot}docker/smoke/lib.sh`;
// The files compose.sh hands to Docker Compose: the stack itself, the override of its last step and
// the Coolify file it validates.
const composeFiles = [
  "compose.yml",
  "docker/smoke/compose.fake-job.yml",
  "compose.coolify.yml",
];

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

/** Every variable a compose file interpolates, nested ones such as ${A:-${B:-x}} included. */
function variablesRead(): string[] {
  const names = new Set<string>();
  for (const file of composeFiles)
    for (const match of read(file).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g))
      names.add(match[1] as string);
  return [...names].sort();
}

describe("the compose smoke test environment", () => {
  // CR-77
  it("reads the variables that the old hand written list forgot", () => {
    expect(variablesRead()).toEqual(
      expect.arrayContaining([
        "BACKUP_TIME",
        "RUNNER_MEMORY_LIMIT",
        "LLM_MODEL",
        "LLM_MAX_TOKENS",
        "REVIEW_DEBOUNCE_SECONDS",
      ]),
    );
  });

  // CR-77
  it("unsets every variable the compose files read and leaves everything else alone", () => {
    const names = variablesRead();
    const leaked = Object.fromEntries(names.map((name) => [name, "leaked"]));

    const result = spawnSync(
      "bash",
      [
        "-c",
        `source "${lib}" && unset_compose_variables ${composeFiles
          .map((file) => `"${repoRoot}${file}"`)
          .join(" ")} && env`,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          NODE_ENV: "test",
          KEEP_ME: "kept",
          ...leaked,
        },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const remaining = new Set(
      result.stdout.split("\n").map((line) => line.split("=")[0]),
    );
    expect(names.filter((name) => remaining.has(name))).toEqual([]);
    expect(remaining.has("KEEP_ME")).toBe(true);
  });

  // CR-77
  it("lets compose.sh unset them before it exports its own settings", () => {
    const script = read("docker/smoke/compose.sh");
    const call = script.indexOf("unset_compose_variables");
    const firstExport = script.indexOf("\nexport ");

    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(firstExport);
    expect(script).toContain('"$workdir/compose.yml"');
    expect(script).toContain('"$here/compose.fake-job.yml"');
    expect(script).toContain('"$repo_root/compose.coolify.yml"');
  });
});
