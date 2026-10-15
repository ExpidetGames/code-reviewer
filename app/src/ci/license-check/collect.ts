// SPDX-License-Identifier: Apache-2.0

// Gathers the data the license check judges: the installed packages with their licenses (pnpm and
// uv print them from the metadata they installed, no network) and the packages of the two
// lockfiles. The parsers are pure functions; `collectAll` is the only part that starts processes.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { InstalledPackage, LockedPackage } from "./check.ts";
import { pythonLicenseExpression } from "./python-license.ts";

export const COLLECT_ERRORS = [
  "PNPM_LICENSES_UNREADABLE",
  "PNPM_LOCK_UNREADABLE",
  "UV_LOCK_UNREADABLE",
  "PYTHON_LICENSES_UNREADABLE",
] as const;

function unreadable(
  code: (typeof COLLECT_ERRORS)[number],
  detail: string,
): never {
  throw new Error(`${code}: ${detail}`);
}

const pnpmLicenses = z.record(
  z.string(),
  z.array(z.object({ name: z.string(), versions: z.array(z.string()) })),
);

/** The output of `pnpm licenses list --json`: licenses, each with the packages that carry it. */
export function parsePnpmLicenses(output: string): InstalledPackage[] {
  let json: unknown;
  try {
    json = JSON.parse(output);
  } catch {
    return unreadable("PNPM_LICENSES_UNREADABLE", "not JSON");
  }
  const parsed = pnpmLicenses.safeParse(json);
  if (!parsed.success) {
    return unreadable("PNPM_LICENSES_UNREADABLE", "unexpected shape");
  }
  const packages = Object.entries(parsed.data).flatMap(([license, entries]) =>
    entries.flatMap((entry) =>
      entry.versions.map((version) => ({
        ecosystem: "npm" as const,
        name: entry.name,
        version,
        license,
      })),
    ),
  );
  if (packages.length === 0) {
    return unreadable("PNPM_LICENSES_UNREADABLE", "no packages listed");
  }
  return packages;
}

/** The `packages:` section of pnpm-lock.yaml (lockfile version 9): keys are `name@version`. */
export function parsePnpmLock(text: string): LockedPackage[] {
  const lock = parse(text) as { packages?: Record<string, unknown> } | null;
  const keys = Object.keys(lock?.packages ?? {});
  if (keys.length === 0) {
    return unreadable("PNPM_LOCK_UNREADABLE", "no packages section");
  }
  return keys.map((key) => {
    const at = key.lastIndexOf("@");
    if (at <= 0)
      return unreadable("PNPM_LOCK_UNREADABLE", `package key ${key}`);
    return {
      ecosystem: "npm" as const,
      name: key.slice(0, at),
      version: key.slice(at + 1),
    };
  });
}

/** The `[[package]]` tables of uv.lock; name and version are their first two keys. */
export function parseUvLock(text: string): LockedPackage[] {
  const packages = [
    ...text.matchAll(
      /^\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/gm,
    ),
  ].map((match) => ({
    ecosystem: "python" as const,
    name: match[1] ?? "",
    version: match[2] ?? "",
  }));
  if (packages.length === 0) {
    return unreadable("UV_LOCK_UNREADABLE", "no package tables");
  }
  return packages;
}

const pythonMetadata = z.array(
  z.object({
    name: z.string(),
    version: z.string(),
    expression: z.string().nullable(),
    license: z.string().nullable(),
    classifiers: z.array(z.string()),
  }),
);

/** The output of runner/scripts/list_licenses.py. */
export function parsePythonInstalled(output: string): InstalledPackage[] {
  let json: unknown;
  try {
    json = JSON.parse(output);
  } catch {
    return unreadable("PYTHON_LICENSES_UNREADABLE", "not JSON");
  }
  const parsed = pythonMetadata.safeParse(json);
  if (!parsed.success) {
    return unreadable("PYTHON_LICENSES_UNREADABLE", "unexpected shape");
  }
  if (parsed.data.length === 0) {
    return unreadable("PYTHON_LICENSES_UNREADABLE", "no packages listed");
  }
  return parsed.data.map((metadata) => ({
    ecosystem: "python" as const,
    name: metadata.name,
    version: metadata.version,
    license: pythonLicenseExpression(metadata),
  }));
}

export type Collected = {
  installed: InstalledPackage[];
  locked: LockedPackage[];
};

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

// `--no-sync`: uv must not touch the environment, which could install packages (and so use the
// network) when it is stale. The check judges what is installed; `uv sync --locked` (make install,
// the CI job) is what installs it. `--locked` still fails when uv.lock is out of date.
export const UV_LICENSES_ARGS = [
  "run",
  "--locked",
  "--no-sync",
  "python",
  "scripts/list_licenses.py",
];

/** Starts pnpm and uv; both need their dependencies installed (`make install`). */
export function collectAll(repoRoot: string): Collected {
  const appDir = `${repoRoot}/app`;
  const dispatcherDir = `${repoRoot}/dispatcher`;
  const runnerDir = `${repoRoot}/runner`;
  return {
    installed: [
      ...parsePnpmLicenses(run("pnpm", ["licenses", "list", "--json"], appDir)),
      ...parsePnpmLicenses(
        run("pnpm", ["licenses", "list", "--json"], dispatcherDir),
      ),
      ...parsePythonInstalled(run("uv", UV_LICENSES_ARGS, runnerDir)),
    ],
    locked: [
      ...parsePnpmLock(readFileSync(`${appDir}/pnpm-lock.yaml`, "utf8")),
      ...parsePnpmLock(readFileSync(`${dispatcherDir}/pnpm-lock.yaml`, "utf8")),
      ...parseUvLock(readFileSync(`${runnerDir}/uv.lock`, "utf8")),
    ],
  };
}
