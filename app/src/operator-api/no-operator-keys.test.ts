// SPDX-License-Identifier: Apache-2.0

// The operator API has no way to the operator's LLM keys (#427, and #276 before it): whoever holds its token must not
// hold the keys. Behavior is pinned in integration-tests/http/operator-api.integration.test.ts; this finds the file
// that would give it one: no source file of the API or of its route files may reach the encrypted secret store of the
// instance, the operator key service, or the assembly that builds them.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
});
