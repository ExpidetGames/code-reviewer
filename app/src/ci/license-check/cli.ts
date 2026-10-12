// SPDX-License-Identifier: Apache-2.0

// The dependency license check. Run from app/ (pnpm and uv installed, see `make install`):
//
//   node src/ci/license-check/cli.ts          (or: pnpm licenses:check, make check-licenses)
//
// It lists the installed packages of the app (pnpm) and the runner (uv) with their licenses, reads
// pnpm-lock.yaml and uv.lock, and judges everything against license-policy.json at the repository
// root. Exit code 0 when every license is allowed, 1 for a violation or when the data could not be
// collected. Everything it reads is local metadata: no network.
//
// Node runs this file as it is (TypeScript types are stripped): relative imports with the .ts
// extension and no TypeScript-only runtime syntax.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkLicenses,
  describeViolation,
  findStalePolicyEntries,
} from "./check.ts";
import { collectAll, type Collected } from "./collect.ts";
import { parsePolicy, type Policy } from "./policy.ts";

type Dependencies = {
  policy: Policy;
  collect: () => Collected;
  out: (line: string) => void;
  err: (line: string) => void;
};

export function runCli({ policy, collect, out, err }: Dependencies): number {
  let data: Collected;
  try {
    data = collect();
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const result = checkLicenses({ policy, ...data });
  const violations = [
    ...result.violations,
    ...findStalePolicyEntries(policy, data.locked),
  ];
  if (violations.length > 0) {
    err(`${violations.length} license problem(s):`);
    for (const violation of violations)
      err(`  ${describeViolation(violation)}`);
    err(
      "A new license needs a decision: allow it in license-policy.json and THIRD_PARTY_LICENSES.md, or choose another dependency.",
    );
    return 1;
  }
  out(
    `Licenses ok: ${result.checked.npm} npm and ${result.checked.python} python packages installed, ` +
      `${data.locked.length} in the lockfiles.`,
  );
  return 0;
}

// Runs only when started as the program, not when a test imports `runCli`.
if (import.meta.main) {
  const repoRoot = fileURLToPath(
    new URL("../../../../", import.meta.url),
  ).replace(/\/$/, "");
  const policy = parsePolicy(
    JSON.parse(readFileSync(`${repoRoot}/license-policy.json`, "utf8")),
  );
  process.exitCode = runCli({
    policy,
    collect: () => collectAll(repoRoot),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
