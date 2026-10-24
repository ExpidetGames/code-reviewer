// SPDX-License-Identifier: LicenseRef-Proprietary

// The import on the running server: called from src/instrumentation.ts after the migrations. It wires the
// import (import.ts) to the server's database, the master key and GitHub, and turns its outcome into the log
// lines an operator reads: what was imported, what was not, which old variables are ignored from now on (names
// only), and, when the import fails, one readable line and the end of the start. Nothing logged holds a value.
import "server-only";
import { symmetricDecrypt } from "better-auth/crypto";
import type { Kysely } from "kysely";
import { loadAuthConfig } from "../auth/config.ts";
import { checkOrgMembership } from "../auth/github-org.ts";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import type { Database } from "../db/schema.ts";
import { setLegacyVariables } from "./environment.ts";
import {
  importExistingInstallation,
  type ImportDependencies,
  type ImportLog,
  type ImportOutcome,
} from "./import.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The one line that says the old variables count for nothing. Names only. */
export function ignoredVariablesLine(
  names: readonly string[],
  context: "imported" | "fresh",
): string {
  return context === "imported"
    ? `[import] LEGACY_VARIABLES_IGNORED: ${names.join(", ")} ${names.length === 1 ? "is" : "are"} ignored from now on: what they held was imported once, and the admin portal and the workspace settings are where it is changed. You can remove ${names.length === 1 ? "it" : "them"} from the environment.`
    : `[import] LEGACY_VARIABLES_IGNORED: this is a new installation, so ${names.join(", ")} ${names.length === 1 ? "is" : "are"} ignored. Set up the instance in the browser with the setup code below; the GitHub App and the LLM key are entered there. You can remove ${names.length === 1 ? "it" : "them"} from the environment.`;
}

export type ImportOnStartOptions = {
  db: Kysely<Database>;
  env?: Env;
  log?: ImportLog & { error(message: string): void };
  exit?: (code: number) => void;
  /** Replaces the wiring to GitHub and Better Auth; for tests. */
  overrides?: Partial<
    Pick<ImportDependencies, "decryptToken" | "checkMembership" | "afterStep">
  >;
};

/** Removes every secret of the environment from a text, so a message that quotes one cannot leak it. */
function redact(text: string, env: Env): string {
  let redacted = text;
  for (const name of [
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_WEBHOOK_SECRET",
    "GITHUB_OAUTH_CLIENT_SECRET",
    "LLM_API_KEY",
    "APP_SECRET",
    "BETTER_AUTH_SECRET",
    "RUNNER_TOKEN",
  ]) {
    const value = (env[name] ?? "").trim();
    if (value.length >= 8) redacted = redacted.split(value).join("[secret]");
  }
  return redacted;
}

export async function importOnStart({
  db,
  env = process.env,
  log = {
    info: console.info,
    warn: console.warn,
    error: console.error,
  },
  exit = (code) => process.exit(code),
  overrides = {},
}: ImportOnStartOptions): Promise<ImportOutcome | null> {
  const resolved = resolveAppSecret(env);
  // The server does not start without the master key (src/auth/startup.ts).
  if (!resolved.ok) throw new Error(resolved.problem);
  const secret = resolved.secret;
  const apiBaseUrl = loadAuthConfig(env).github.apiBaseUrl;

  let outcome: ImportOutcome;
  try {
    outcome = await importExistingInstallation({
      db,
      env,
      appSecret: secret,
      // Better Auth stored the token encrypted with the master key (`encryptOAuthTokens`); the same key reads it.
      decryptToken: (stored) =>
        symmetricDecrypt({
          key: {
            keys: new Map([[0, secret]]),
            currentVersion: 0,
            legacySecret: secret,
          },
          data: stored,
        }),
      checkMembership: (accessToken, org) =>
        checkOrgMembership({
          apiBaseUrl,
          org,
          accessToken,
          timeoutMs: 5000,
          log: () => undefined,
        }),
      log,
      ...overrides,
    });
  } catch (error) {
    const detail = redact(
      error instanceof Error ? error.message : String(error),
      env,
    );
    log.error(
      `[import] IMPORT_FAILED: the import of this installation failed and nothing was imported (the database is as the migrations left it, and the backup taken at the start of this update is in the backup directory). ${detail} Fix the cause and start again: the import then runs from the beginning.`,
    );
    exit(1);
    return null;
  }

  const names = setLegacyVariables(env);
  if (names.length > 0) {
    const imported = outcome.kind === "imported" || outcome.importedBefore;
    log.info(ignoredVariablesLine(names, imported ? "imported" : "fresh"));
  }
  return outcome;
}
