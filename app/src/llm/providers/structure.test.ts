// SPDX-License-Identifier: Apache-2.0

// #423-T06: adding a provider means adding an adapter. The one real provider is named only inside its own
// adapter folder; every other source file reads it from the registry. The scan reads the real source files,
// so a new mention in application code fails here and in `make verify`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listSourceFiles } from "../../ci/spdx-headers/source-files.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const PROVIDER_NAME = /openrouter/i;

/** The adapter itself: the only place that may know the provider. */
const ADAPTER_FOLDER = "app/src/llm/providers/openrouter/";

/**
 * Files that may name the provider although they are not the adapter, each with the reason. Keep it short:
 * a mention that is only a convenience belongs behind the registry (`label`, `defaultProvider`).
 */
const ALLOWED: Readonly<Record<string, string>> = {
  "app/src/llm/providers/index.ts":
    "the registry lists its adapters (descriptors, client-safe)",
  "app/src/llm/providers/server.ts":
    "the registry lists its adapters (with their network calls, server only)",
  "app/src/contracts/runner-api.ts":
    "generated from the runner API contract, whose `llm.provider` is still the enum of one value (the runner seam is the next issue)",
  "app/src/contracts/worker-api.ts":
    "generated from the Worker API contract, same enum",
  "app/src/runner-api/contract.ts":
    "the runner API contract's `llm.provider` literal (the runner seam is the next issue)",
  "app/src/review-settings/runner-settings.ts":
    "a comment that names PR-Agent's own key variable (the runner side of the provider, the next issue)",
};

function isApplicationSource(path: string): boolean {
  if (!path.startsWith("app/src/")) return false;
  if (/\.test\.tsx?$/.test(path)) return false;
  if (path.startsWith("app/src/test-support/")) return false;
  // A migration is history: it must keep describing what was true when it ran.
  if (path.startsWith("app/src/db/migrations/")) return false;
  return !path.startsWith(ADAPTER_FOLDER);
}

describe("the provider is named only inside its adapter", () => {
  const files = listSourceFiles(repoRoot)
    .filter(isApplicationSource)
    .map((path) => ({
      path,
      mentions: PROVIDER_NAME.test(readFileSync(`${repoRoot}${path}`, "utf8")),
    }));

  // #423-T06
  it("keeps the name out of every source file outside the adapter, except the listed ones", () => {
    const offenders = files
      .filter((file) => file.mentions && !(file.path in ALLOWED))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  // #423-T06
  it("lists no exception that no longer needs one", () => {
    const stale = Object.keys(ALLOWED).filter(
      (path) => !files.some((file) => file.path === path && file.mentions),
    );
    expect(stale).toEqual([]);
  });
});
