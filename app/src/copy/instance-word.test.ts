// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the wording of #675: no page, text, mail, notice or error message of the app says "instance". Where the
// managed key or the billing is meant it says "billed via code-review.com" or "code-review.com key"; elsewhere it
// names the server, the operator or the admin. The scan reads the real source files of the app (every string,
// template and JSX text outside the tests), so a new sentence with the word fails here. The few texts that keep it
// are log lines and command lines for whoever runs the server, each listed with its reason.
//
// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listSourceFiles } from "../ci/spdx-headers/source-files.ts";
import {
  findInstanceWord,
  saysInstance,
  withoutInstanceExceptions,
  type InstanceWordException,
} from "./instance-word-scan.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const EXCEPTIONS: readonly InstanceWordException[] = [
  {
    path: "app/src/auth/password-reset-request.ts",
    text: "PASSWORD_RESET_MAIL_LIMITED",
    reason: "a log line with a stable code",
  },
  {
    path: "app/src/setup/gate-proxy.ts",
    text: "SETUP_STATE_UNAVAILABLE",
    reason: "a log line with a stable code",
  },
  {
    path: "app/src/setup/setup-code-cli.ts",
    text: "there is no setup code to make",
    reason: "the output of a command on the server, read by whoever runs it",
  },
  {
    path: "app/src/setup/start.ts",
    text: "is not set up yet. Open it in a browser",
    reason: "the start-up log line that prints the setup code",
  },
  {
    path: "app/src/legacy-import/import.ts",
    text: "is not set up yet: finish the short setup",
    reason: "the log line of the import of the old database",
  },
  {
    path: "app/src/legacy-import/startup.ts",
    text: "Set up the instance in the browser",
    reason: "the start-up log line of the import of the old database",
  },
  {
    path: "app/src/health/health.ts",
    text: "this instance answers 503",
    reason: "the log line of a failed health check",
  },
  {
    path: "app/src/db/migrate.ts",
    text: "Is another instance still starting up",
    reason: "the error of the migration command on the server",
  },
  {
    path: "app/src/db/config.ts",
    text: "a serverless instance does not have",
    reason: "the start-up error about the database configuration",
  },
  {
    path: "app/src/crypto/app-secret.ts",
    text: "master key of the instance",
    reason: "the start-up error about a missing environment variable",
  },
  {
    path: "app/src/secrets/names.ts",
    text: "is already a secret name of the instance",
    reason: "a programming error thrown while the secret registry is built",
  },
];

function isScanned(path: string): boolean {
  return (
    path.startsWith("app/src/") &&
    /\.tsx?$/.test(path) &&
    !/\.test\.tsx?$/.test(path) &&
    !path.startsWith("app/src/test-support/") &&
    // A migration is history and runs on the server; what it prints is read by whoever runs it.
    !path.startsWith("app/src/db/migrations/")
  );
}

describe("the word instance", () => {
  // #675-T04
  it("is in no text of the app outside the listed log lines", () => {
    const findings = listSourceFiles(repoRoot)
      .filter(isScanned)
      .flatMap((path) =>
        findInstanceWord(path, readFileSync(`${repoRoot}${path}`, "utf8")),
      );

    expect(withoutInstanceExceptions(findings, EXCEPTIONS)).toEqual([]);
  });

  // #675-T04
  it("finds the word in a string, a template and a JSX text, but not in a comment or an import", () => {
    const content = [
      `// About the instance.`,
      `import { x } from "./instance-settings.ts";`,
      `export const a = "This instance is closed";`,
      "export const b = `Hello ${name}, welcome to this Instance`;",
      `export const C = () => <p>Ask the admin of the instance</p>;`,
    ].join("\n");

    expect(findInstanceWord("app/src/x.tsx", content)).toEqual([
      { path: "app/src/x.tsx", line: 3, text: "This instance is closed" },
      {
        path: "app/src/x.tsx",
        line: 4,
        text: ", welcome to this Instance",
      },
      {
        path: "app/src/x.tsx",
        line: 5,
        text: "Ask the admin of the instance",
      },
    ]);
  });

  // #675-T04
  it("does not count the technical tokens that contain the word", () => {
    for (const token of [
      "instance_settings",
      "is_instance_admin",
      "/instance-portal/runs",
      "/api/instance-portal/billing/workspaces/[id]",
      "select value from instance_settings where key = 'x'",
      "__instance_default__",
      "instance",
    ])
      expect(saysInstance(token)).toBe(false);
    for (const prose of ["Instance", "Instances", "on this instance."])
      expect(saysInstance(prose)).toBe(true);
  });
});
