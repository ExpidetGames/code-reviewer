// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down tools/factory-bootstrap/factory-bootstrap.sh (#732): the tool that lists what the second App needs and,
// only when the owner runs it with --out, generates its random secrets into a new file only the owner can read. It
// must never print or trace a secret, never read a file (no .env*), never overwrite, and never write into a git
// checkout. The script runs for real in a temporary directory; no network, no platform.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readText, repoRoot } from "./workflow-support.ts";

const SCRIPT = `${repoRoot}tools/factory-bootstrap/factory-bootstrap.sh`;
const GENERATED = [
  "APP_SECRET",
  "RUNNER_TOKEN",
  "CRON_SECRET",
  "RUNNER_WEBHOOK_SECRET",
  "DISPATCHER_OPERATOR_TOKEN",
];

const directories: string[] = [];
const scratch = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "cr-bootstrap-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

type Run = { status: number; stdout: string; stderr: string };
function run(
  args: string[],
  options: {
    cwd: string;
    shellArgs?: string[];
    env?: Record<string, string>;
  },
): Run {
  const result = spawnSync(
    "bash",
    [...(options.shellArgs ?? []), SCRIPT, ...args],
    {
      cwd: options.cwd,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: options.cwd,
        ...options.env,
      } as unknown as NodeJS.ProcessEnv,
    },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function valuesOf(file: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const at = line.indexOf("=");
    values.set(line.slice(0, at), line.slice(at + 1));
  }
  return values;
}

describe("the bootstrap tool without --out", () => {
  // #732-T08
  it("prints every entry and the Vercel checklist, generates nothing and writes no file", () => {
    const cwd = scratch();
    const result = run([], { cwd });

    expect(result.status).toBe(0);
    for (const key of [
      ...GENERATED,
      "DATABASE_URL",
      "DATABASE_URL_MIGRATE_FACTORY",
      "BETTER_AUTH_URL",
      "VERCEL_FACTORY_PROJECT_ID",
      "VERCEL_FACTORY_AUTOMATION_BYPASS_SECRET",
      "DISPATCHER_APP_FACTORY_TOKEN",
      "DISPATCHER_APP_FACTORY_SIGNING_SECRET",
      "DISPATCHER_APPS",
    ])
      expect(result.stdout, key).toContain(key);
    expect(result.stdout).toContain("${prod.app-factory.RUNNER_TOKEN}");
    expect(result.stdout).toContain("FACTORY_ENABLED");
    expect(result.stdout).toContain("Root directory: app");
    expect(readdirSync(cwd)).toEqual([]);
    // No value that could be a secret.
    expect(result.stdout + result.stderr).not.toMatch(/[0-9a-f]{32,}/);
    expect(result.stdout).toContain("Nothing was generated");
  });

  // #732-T08
  it("is the same, and still prints nothing secret, under xtrace", () => {
    const cwd = scratch();
    const result = run([], { cwd, shellArgs: ["-x"] });

    expect(result.status).toBe(0);
    expect(readdirSync(cwd)).toEqual([]);
    expect(result.stdout + result.stderr).not.toMatch(/[0-9a-f]{32,}/);
  });

  // #732-T08
  it("refuses arguments it does not know", () => {
    const cwd = scratch();
    for (const args of [["--write"], ["--out"], ["--out", "a", "b"]]) {
      const result = run(args, { cwd });
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr).toContain("usage:");
    }
    expect(readdirSync(cwd)).toEqual([]);
  });
});

describe("the bootstrap tool with --out", () => {
  // #732-T08
  it("writes the five secrets to a new file that only the owner can read, all different and long enough", () => {
    const cwd = scratch();
    const out = join(cwd, "factory-secrets.txt");
    const result = run(["--out", out], { cwd });

    expect(result.status).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const values = valuesOf(out);
    expect([...values.keys()]).toEqual(GENERATED);
    const all = [...values.values()];
    expect(new Set(all).size).toBe(5);
    for (const [name, value] of values) {
      expect(value.length, name).toBeGreaterThanOrEqual(32);
      expect(value, name).not.toMatch(/\s/);
    }
    // 64 hex characters for the tokens and the signing secret; base64 of 32 bytes for the master key.
    for (const name of GENERATED.filter((n) => n !== "APP_SECRET"))
      expect(values.get(name), name).toMatch(/^[0-9a-f]{64}$/);
    expect(values.get("APP_SECRET")).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    // Two runs never give the same value.
    const second = join(cwd, "second.txt");
    expect(run(["--out", second], { cwd }).status).toBe(0);
    for (const [name, value] of valuesOf(second))
      expect(value, name).not.toBe(values.get(name));
    expect(readdirSync(cwd).sort()).toEqual([
      "factory-secrets.txt",
      "second.txt",
    ]);
  });

  // #732-T08
  it.each([
    ["normally", []],
    ["under xtrace", ["-x"]],
    ["under xtrace and verbose", ["-xv"]],
  ])("never prints, traces or echoes a value, %s", (_name, shellArgs) => {
    const cwd = scratch();
    const out = join(cwd, "secrets.txt");
    const result = run(["--out", out], { cwd, shellArgs });

    expect(result.status).toBe(0);
    for (const value of valuesOf(out).values()) {
      expect(result.stdout).not.toContain(value);
      expect(result.stderr).not.toContain(value);
    }
    expect(result.stdout).toContain("mode 0600");
  });

  // #732-T08
  it("never prints a value when the shell is made to trace through its environment either", () => {
    const cwd = scratch();
    const out = join(cwd, "secrets.txt");
    const result = run(["--out", out], {
      cwd,
      env: { SHELLOPTS: "xtrace", PS4: "+ " },
    });

    expect(result.status).toBe(0);
    for (const value of valuesOf(out).values()) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  });

  // #732-T08
  it("refuses an existing file and leaves it as it was", () => {
    const cwd = scratch();
    const out = join(cwd, "secrets.txt");
    writeFileSync(out, "mine\n");
    const result = run(["--out", out], { cwd });

    expect(result.status).toBe(1);
    expect(readFileSync(out, "utf8")).toBe("mine\n");
    expect(result.stderr).toContain("Refusing to overwrite");
  });

  // #732-T08
  it.each([".env", ".env.local", ".env.production"])(
    "refuses a file called %s",
    (name) => {
      const cwd = scratch();
      const result = run(["--out", join(cwd, name)], { cwd });

      expect(result.status).toBe(1);
      expect(readdirSync(cwd)).toEqual([]);
    },
  );

  // #732-T08
  it("refuses a path inside a git checkout, so that a secret can never be committed, and a directory that does not exist", () => {
    const cwd = scratch();
    expect(
      spawnSync("git", ["init", "--quiet", cwd], { encoding: "utf8" }).status,
    ).toBe(0);
    const inside = run(["--out", join(cwd, "secrets.txt")], { cwd });
    expect(inside.status).toBe(1);
    expect(readdirSync(cwd)).toEqual([".git"]);

    const missing = run(["--out", join(cwd, "nowhere", "secrets.txt")], {
      cwd,
    });
    expect(missing.status).toBe(1);
  });

  // #732-T08
  it("reads no file: an .env* file next to it, with a marker in it, is never touched or echoed", () => {
    const cwd = scratch();
    const outside = scratch();
    writeFileSync(join(cwd, ".env"), "MARKER_SECRET=do-not-read-0123456789\n");
    mkdirSync(join(cwd, "sub"));
    const result = run(["--out", join(outside, "secrets.txt")], { cwd });

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("do-not-read");
    expect(readFileSync(join(outside, "secrets.txt"), "utf8")).not.toContain(
      "do-not-read",
    );
  });
});

describe("the text of the bootstrap script", () => {
  const whole = readText("tools/factory-bootstrap/factory-bootstrap.sh");
  // The code without its comments and without the text it prints.
  const text = whole
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  // #732-T08
  it("switches xtrace off first, before anything else runs", () => {
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    expect(lines[0]).toBe("{ set +x; } 2> /dev/null");
    expect(lines[1]).toBe("set -euo pipefail");
    expect(lines[2]).toBe("umask 077");
  });

  // #732-T08
  it("hands a value to nothing but the built-in printf and the shell's own assignments", () => {
    const uses = text
      .split("\n")
      .filter((line) => /\$\{?value\}?|\$\{?seen\}?/.test(line))
      .map((line) => line.trim());
    for (const line of uses)
      expect(line, line).toMatch(
        /^(printf '%s=%s\\n' "\$\{name\}" "\$\{value\}" >> "\$\{out\}"|\*" \$\{value\} "\*\)|seen="\$\{seen\} \$\{value\}"|case " \$\{seen\} " in)$/,
      );
    expect(text).not.toMatch(/\becho\b[^\n]*\$\{?value/);
    expect(text).not.toMatch(
      /\beval\b|^\s*source\s|^\s*\. |\bcat\b|\bopenssl\b|\bcurl\b/m,
    );
    expect(text).not.toMatch(/\.env\b(?!\*)/);
  });
});
