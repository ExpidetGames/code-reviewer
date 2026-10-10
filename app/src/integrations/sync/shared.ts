// The one sync service of the running server. The start-up sync, the webhook route and the button all
// use it. It is kept on `globalThis` for the same reason as the database connection and the lock:
// Next.js loads `instrumentation.ts` and the route handlers as separate module graphs, so a plain
// module level variable would give each of them its own copy.
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import { getDatabase } from "../../db/startup.ts";
import { integrationRegistry } from "../registry.ts";
import { coalesceSyncAll } from "./coalesce.ts";
import {
  createIntegrationSync,
  type IntegrationSyncService,
} from "./service.ts";

const SHARED_SERVICE = Symbol.for("code-reviewer.integration-sync");
type Held = { db: Kysely<Database>; service: IntegrationSyncService };
type GlobalWithService = typeof globalThis & { [SHARED_SERVICE]?: Held };

/** The process-wide sync service for the database connection opened at start. */
export function getIntegrationSync(): IntegrationSyncService {
  const holder = globalThis as GlobalWithService;
  const db = getDatabase();
  // A connection that was replaced (a reload in `next dev`) gets a service of its own.
  if (holder[SHARED_SERVICE]?.db !== db)
    holder[SHARED_SERVICE] = {
      db,
      // Overlapping full syncs (the button in two tabs, the start-up sync) share one run.
      service: coalesceSyncAll(
        createIntegrationSync({ db, registry: integrationRegistry }),
      ),
    };
  return holder[SHARED_SERVICE].service;
}
