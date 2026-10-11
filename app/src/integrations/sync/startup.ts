// SPDX-License-Identifier: Apache-2.0

// The synchronization that runs when the server starts. It must never stop the start: a platform
// that is down, or settings that are missing, are reported in the log and the app serves requests
// anyway. (Refusing to start without the GitHub App settings is a deployment concern: see
// src/deploy/startup.ts, which asks the same loader.)
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import { getDatabase } from "../../db/startup.ts";
import { integrationRegistry, type IntegrationRegistry } from "../registry.ts";
import { createIntegrationSync, type SyncSummary } from "./service.ts";
import { getIntegrationSync } from "./shared.ts";

export type StartupSyncOptions = {
  /** Replaces the database and registry of the running server; for tests. */
  getDb?: () => Kysely<Database>;
  registry?: IntegrationRegistry;
  /** Receives every line with its level. Default: console.info and console.error. */
  log?: (line: string, level: "info" | "error") => void;
};

function defaultLog(line: string, level: "info" | "error"): void {
  if (level === "error") console.error(line);
  else console.info(line);
}

/** Runs the full sync once. Resolves with the summary, or null when it could not even begin; never rejects. */
export async function runStartupSync(
  options: StartupSyncOptions = {},
): Promise<SyncSummary | null> {
  const log = options.log ?? defaultLog;
  try {
    const sync =
      options.getDb === undefined && options.registry === undefined
        ? getIntegrationSync()
        : createIntegrationSync({
            db: (options.getDb ?? getDatabase)(),
            registry: options.registry ?? integrationRegistry,
            log: (line) => log(line, "error"),
          });
    const summary = await sync.syncAll();
    const { repositories, integrations, errors } = summary;
    log(
      `[integrations] startup sync done: ${integrations.created} integrations created, ` +
        `${repositories.added} repositories added, ${repositories.reactivated} reactivated, ` +
        `${repositories.deactivated} deactivated, ${errors.length} errors`,
      errors.length > 0 ? "error" : "info",
    );
    return summary;
  } catch {
    log("[integrations] startup sync could not run.", "error");
    return null;
  }
}
