// SPDX-License-Identifier: LicenseRef-Proprietary

// The operator API has no way to the operator's LLM keys (#427, and #276 before it): whoever holds its token must not
// hold the keys. Behavior is pinned in integration-tests/http/operator-api.integration.test.ts; this finds the file
// that would give it one: no source file of the API or of its route files may reach the encrypted secret store of the
// instance, the operator key service, or the assembly that builds them, neither directly nor through the modules it
// imports (a source scan has a limit: only the static imports and the `@/` alias are followed, a computed path is
// not; the behavior test above is the guard for that).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_DIRECTORY } from "../test-support/routes.ts";

const SRC = join(APP_DIRECTORY, "..");

function sourcesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourcesBelow(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [path]
      : [];
  });
}

const FILES = [
  ...sourcesBelow(join(SRC, "operator-api")),
  ...sourcesBelow(join(APP_DIRECTORY, "api", "operator")),
];

// What reaches a key of the operator: the secret store, the services that wrap it, the assembly of a workspace's LLM
// access (its wiring in src/llm/shared.ts also serves the public model metadata, which the API may use), the key test
// of the portal and the names the keys are stored under.
const FORBIDDEN = [
  /secrets\/(store|shared|names)/,
  /llm\/(operator-key|assemble|operator-key-test)/,
  /\b(getWorkspaceLlm|getLlmKeyTester|createWorkspaceLlm)\b/,
  /admin\/(service|shared)/,
  /\bOPERATOR_KEY\b/,
  /operator_llm_key/,
  /\boperatorKey\(/,
];

// Modules that wire the keys into something else, such as the runner API's masking (`currentKeysFor`): importing
// one of them, however far down the chain, gives the file that imports it a way to the keys. Matched against the
// path of a module below src.
const FORBIDDEN_MODULES = [
  /^secrets\/(store|shared|names)\./,
  /^llm\/(operator-key|assemble|operator-key-test|shared)\./,
  /^runner-api\//,
  /^admin\/(service|shared)\./,
];

// Modules the API uses on purpose and that are not followed any further: the bearer-token check and the logger of the
// runner API (leaf modules), and the wiring of the public model metadata, which sits next to the key services in
// src/llm/shared.ts. What the API imports from it is checked by name above (`getWorkspaceLlm` and the like).
const ALLOWED_MODULES = [
  "runner-api/logger.ts",
  "runner-api/token-auth.ts",
  "llm/shared.ts",
];

const inSrc = (file: string) => file.slice(SRC.length + 1);

const IMPORT =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+|@\/[^"']+)\1/g;

/** The source file an import of `from` names, or undefined for a package or a file that is not there. */
function resolveImport(from: string, specifier: string): string | undefined {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(from), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(
    (candidate) => /\.(ts|tsx)$/.test(candidate) && existsSync(candidate),
  );
}

/** Every file reached from `file` by static imports, as the first chain that reaches it. */
function importClosure(file: string): Map<string, string[]> {
  const chains = new Map<string, string[]>([[file, [file]]]);
  const queue = [file];
  for (const current of queue) {
    const text = readFileSync(current, "utf8");
    for (const match of text.matchAll(IMPORT)) {
      const target = resolveImport(current, match[2] ?? "");
      if (target === undefined || chains.has(target)) continue;
      if (ALLOWED_MODULES.includes(inSrc(target))) continue;
      chains.set(target, [...(chains.get(current) ?? []), target]);
      queue.push(target);
    }
  }
  return chains;
}

describe("the operator API", () => {
  // #427-T03
  it("has source files at all, so the scan below looks at something", () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  // #427-T03
  it("imports nothing that reaches an operator LLM key", () => {
    const reaching = FILES.flatMap((file) =>
      FORBIDDEN.filter((pattern) =>
        pattern.test(readFileSync(file, "utf8")),
      ).map((pattern) => `${file}: ${String(pattern)}`),
    );

    expect(reaching).toEqual([]);
  });

  // #427-T03
  it("reaches no module that wires the keys, however many imports away", () => {
    const reaching = FILES.flatMap((file) =>
      [...importClosure(file)].flatMap(([target, chain]) =>
        FORBIDDEN_MODULES.some((pattern) => pattern.test(inSrc(target)))
          ? [chain.map(inSrc).join(" -> ")]
          : [],
      ),
    );

    expect(reaching).toEqual([]);
  });

  // #427-T03
  it("finds a module two imports away, so the scan above is not blind", () => {
    const closure = importClosure(join(SRC, "operator-api", "shared.ts"));

    const longest = Math.max(...[...closure.values()].map((c) => c.length));
    expect(longest).toBeGreaterThanOrEqual(3);
  });
});
