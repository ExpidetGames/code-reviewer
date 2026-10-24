// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down that docker/smoke/compose.sh starts from a clean environment: every variable the compose
// files it uses read is unset before the script exports its own dummy settings, so a value in the
// caller's shell or in CI can never change what the smoke test runs against. The list is derived from
// the compose files (docker/smoke/lib.sh, unset_compose_variables), so a new variable cannot be
// forgotten. The Docker part of the script is proven by running it (make test-compose).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Every variable a compose file interpolates, nested ones such as ${A:-${B:-x}} and the short form
 * $A included. `$$` is an escaped dollar sign and interpolates nothing.
 */
function variablesRead(): string[] {
  const names = new Set<string>();
  for (const file of composeFiles)
    for (const match of read(file)
      .replaceAll("$$", "")
      .matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g))
      names.add(match[1] as string);
  return [...names].sort();
}

type Outcome = { status: number | null; stdout: string; stderr: string };

/**
 * Runs `unset_compose_variables` in a real bash on compose files made from `contents` (or on the
 * paths in `paths`), with `env` as the caller's environment and `options` as `set` options, then
 * prints the environment that is left.
 */
function unsetIn(
  contents: string[],
  env: Record<string, string>,
  { options = "", paths }: { options?: string; paths?: string[] } = {},
): Outcome {
  const directory = mkdtempSync(join(tmpdir(), "compose-env-"));
  try {
    const files = contents.map((text, index) => {
      const file = join(directory, `compose-${String(index)}.yml`);
      writeFileSync(file, text);
      return file;
    });
    const arguments_ = (paths ?? files).map((file) => `"${file}"`).join(" ");
    return spawnSync(
      "bash",
      [
        "-c",
        `${options} source "${lib}" && unset_compose_variables ${arguments_} && env`,
      ],
      {
        env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env },
        encoding: "utf8",
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function remainingNames(outcome: Outcome): Set<string> {
  return new Set(outcome.stdout.split("\n").map((line) => line.split("=")[0]));
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

  // CR-77
  it("fails when a compose file is missing instead of unsetting nothing", () => {
    const outcome = unsetIn(
      [],
      { FOO: "kept" },
      { paths: ["/nowhere/compose.yml"] },
    );

    expect(outcome.status).not.toBe(0);
    expect(outcome.stderr).toContain("/nowhere/compose.yml");
  });

  // CR-77
  it("fails when no compose file is given at all", () => {
    expect(unsetIn([], {}, { paths: [] }).status).not.toBe(0);
  });

  // CR-77
  it("does not unset a variable behind an escaped dollar sign", () => {
    const outcome = unsetIn(
      ["command: echo $${HOME} $$${GONE}\nimage: ${IMAGE:-x}\n"],
      { HOME: "/home/me", GONE: "x", IMAGE: "y" },
    );

    expect(outcome.status, outcome.stderr).toBe(0);
    const remaining = remainingNames(outcome);
    expect(remaining.has("HOME")).toBe(true);
    expect(remaining.has("GONE")).toBe(false);
    expect(remaining.has("IMAGE")).toBe(false);
  });

  // CR-77
  it("unsets the short form $NAME as well", () => {
    const outcome = unsetIn(["image: $SHORT\nname: ${BRACED}\n"], {
      SHORT: "x",
      BRACED: "y",
    });

    expect(outcome.status, outcome.stderr).toBe(0);
    const remaining = remainingNames(outcome);
    expect(remaining.has("SHORT")).toBe(false);
    expect(remaining.has("BRACED")).toBe(false);
  });

  // CR-77
  it("does not abort a script that runs with set -e when a variable is read only", () => {
    const outcome = unsetIn(
      ["user: ${UID}\nimage: ${IMAGE}\n"],
      { IMAGE: "y" },
      {
        options: "set -euo pipefail;",
      },
    );

    expect(outcome.status, outcome.stderr).toBe(0);
    expect(remainingNames(outcome).has("IMAGE")).toBe(false);
  });

  // CR-77
  it("succeeds on a compose file that reads no variable", () => {
    const outcome = unsetIn(
      ["image: fixed\n"],
      { KEEP: "kept" },
      {
        options: "set -euo pipefail;",
      },
    );

    expect(outcome.status, outcome.stderr).toBe(0);
    expect(remainingNames(outcome).has("KEEP")).toBe(true);
  });

  // CR-77
  it("also unsets the variables of Docker Compose itself that could change the stack", () => {
    const script = read("docker/smoke/compose.sh");

    for (const name of [
      "COMPOSE_FILE",
      "COMPOSE_PROFILES",
      "COMPOSE_ENV_FILES",
    ])
      expect(script).toMatch(new RegExp(`unset [^\\n]*\\b${name}\\b`));
  });
});
