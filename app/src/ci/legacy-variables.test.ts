// SPDX-License-Identifier: LicenseRef-Proprietary

// Proves that no runtime source file of the app reads a legacy environment variable. The GitHub App and the LLM
// key live in the database (entered in the admin portal); nothing may read `GITHUB_APP_*`, `LLM_PROVIDER` /
// `LLM_API_KEY` or `ALLOWED_GITHUB_*` from the environment again. The scan looks
// at tracked files, so a file that reads the variables and is not committed yet is not caught until
// it is added; that is the same trade-off as the tracked-secrets scan (src/ci/tracked-secrets.test.ts).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** The variables that no runtime file may read from the environment. */
const LEGACY_VARIABLES = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "ALLOWED_GITHUB_LOGINS",
  "ALLOWED_GITHUB_ORG",
  "LLM_PROVIDER",
  "LLM_API_KEY",
] as const;

/**
 * The runtime files that may still read a legacy variable, and why:
 * - `integrations/providers/github-app/config.ts` is the shared loader; the running server feeds it
 *   from the database.
 * - `runner-api/redact.ts` masks a legacy `LLM_API_KEY` that may still sit in the environment of a
 *   running instance.
 */
const RUNTIME_ALLOWED = [
  "app/src/integrations/providers/github-app/config.ts",
  "app/src/runner-api/redact.ts",
];

function isRuntimeSource(path: string): boolean {
  if (!path.startsWith("app/src/")) return false;
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return false;
  if (path.includes(".test.") || path.includes(".integration.test."))
    return false;
  if (path.startsWith("app/src/test-support/")) return false;
  return !RUNTIME_ALLOWED.some((allowed) => path.startsWith(allowed));
}

function runtimeSourceFiles(): { path: string; content: string }[] {
  const listing = execFileSync("git", ["ls-files", "-z", "app/src"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const files: { path: string; content: string }[] = [];
  for (const path of listing.split("\0")) {
    if (path === "" || !isRuntimeSource(path)) continue;
    try {
      files.push({ path, content: readFileSync(`${repoRoot}${path}`, "utf8") });
    } catch {
      continue; // listed by git but deleted in the working tree
    }
  }
  return files;
}

// A read of `NAME` through the environment: `env.NAME` / `process.env.NAME`, the optional chaining
// forms `env?.NAME` / `process.env?.NAME`, `env["NAME"]` / `env?.["NAME"]`, a destructured
// `{ NAME } = env` / `= process.env`, or the provider loader's `value(env, "NAME")`. A bare mention
// (a comment, UI copy) does not match.
function reads(files: { path: string; content: string }[]): string[] {
  const hits: string[] = [];
  for (const { path, content } of files) {
    for (const name of LEGACY_VARIABLES) {
      const access = [
        String.raw`\b(?:process\.)?env\s*\.\s*${name}\b`,
        String.raw`\b(?:process\.)?env\s*\?\s*\.\s*${name}\b`,
        String.raw`\benv\s*\[\s*["']${name}["']\s*\]`,
        String.raw`\benv\s*\?\s*\.\s*\[\s*["']${name}["']\s*\]`,
        String.raw`\bvalue\s*\(\s*env\s*,\s*["']${name}["']\s*\)`,
        String.raw`\{[^}]*\b${name}\b[^}]*\}\s*=\s*(?:process\.)?env\b`,
      ].join("|");
      if (new RegExp(access).test(content)) hits.push(`${path}: ${name}`);
    }
  }
  return hits;
}

describe("the runtime source of the app", () => {
  // #159-T02
  it("reads no legacy environment variable", () => {
    const files = runtimeSourceFiles();

    expect(files.length).toBeGreaterThan(100);
    expect(files.map((file) => file.path)).toContain(
      "app/src/config-status/status.ts",
    );
    expect(reads(files)).toEqual([]);
  });

  // #159-T02
  it("would be caught if a runtime file read a legacy variable again", () => {
    const planted = [
      { path: "app/src/llm/config.ts", content: "const k = env.LLM_API_KEY;" },
      {
        path: "app/src/integrations/registry.ts",
        content: 'value(env, "GITHUB_APP_SLUG");',
      },
      {
        path: "app/src/config-status/status.ts",
        content: 'const org = env["ALLOWED_GITHUB_ORG"];',
      },
      {
        path: "app/src/llm/config.ts",
        content: "const { LLM_API_KEY } = process.env;",
      },
      {
        path: "app/src/llm/status.ts",
        content: "const id = process.env?.GITHUB_APP_ID;",
      },
    ];

    expect(reads(planted)).toEqual([
      "app/src/llm/config.ts: LLM_API_KEY",
      "app/src/integrations/registry.ts: GITHUB_APP_SLUG",
      "app/src/config-status/status.ts: ALLOWED_GITHUB_ORG",
      "app/src/llm/config.ts: LLM_API_KEY",
      "app/src/llm/status.ts: GITHUB_APP_ID",
    ]);
  });

  // #159-T02 (the one documented exception: a legacy LLM_API_KEY may still sit in the environment of
  // a running instance and redact.ts masks it, so the scan skips that file on purpose)
  it("keeps the masking of a legacy LLM_API_KEY in runner-api/redact.ts as an explicit exception", () => {
    expect(isRuntimeSource("app/src/runner-api/redact.ts")).toBe(false);
    expect(isRuntimeSource("app/src/llm/config.ts")).toBe(true);
  });

  // #159-T02
  it("ignores a mere mention of a legacy variable, in a comment or in copy", () => {
    const mentioned = [
      {
        path: "app/src/admin/ui/import-notice.tsx",
        content: "GITHUB_OAUTH_CLIENT_ID is not imported",
      },
      {
        path: "app/src/llm/config.ts",
        content: "// LLM_PROVIDER, LLM_API_KEY",
      },
      {
        path: "app/src/llm/config.ts",
        content: "const providers = LLM_PROVIDERS;",
      },
    ];

    expect(reads(mentioned)).toEqual([]);
  });
});
