// The synchronization that runs when the server starts. It must never stop the start: a platform
// that is down, or settings that are missing, are reported in the log and the app serves requests
// anyway. (Refusing to start without the GitHub App settings is a deployment concern.)
import "server-only";
import type { Kysely } from "kysely";
import { getDatabase } from "../../db/startup.ts";
import type { Database } from "../../db/schema.ts";
import { integrationRegistry, type IntegrationRegistry } from "../registry.ts";
import { createIntegrationSync, type SyncSummary } from "./service.ts";

export type StartupSyncOptions = {
  getDb?: () => Kysely<Database>;
  registry?: IntegrationRegistry;
  log?: (line: string) => void;
};

/** Runs the full sync once. Resolves with the summary, or null when it could not even begin; never rejects. */
export async function runStartupSync(
  options: StartupSyncOptions = {},
): Promise<SyncSummary | null> {
  const log = options.log ?? ((line: string) => console.info(line));
  try {
    const sync = createIntegrationSync({
      db: (options.getDb ?? getDatabase)(),
      registry: options.registry ?? integrationRegistry,
      log,
    });
    const summary = await sync.syncAll();
    const { repositories, integrations, errors } = summary;
    log(
      `[integrations] startup sync done: ${integrations.created} integrations created, ` +
        `${repositories.added} repositories added, ${repositories.reactivated} reactivated, ` +
        `${repositories.deactivated} deactivated, ${errors.length} errors`,
    );
    return summary;
  } catch {
    log("[integrations] startup sync could not run.");
    return null;
  }
}
