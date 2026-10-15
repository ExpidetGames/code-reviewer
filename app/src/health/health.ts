// SPDX-License-Identifier: Apache-2.0

// The answer of GET /api/health: the app is up and can read its database. Kept minimal on purpose;
// the deployment ticket extends it. In serverless mode (`checkSchema`) it also says whether the
// database has every migration this version ships: the app never migrates there, so a deployment
// that went out ahead of `pnpm migrate` is visible here (503, code `SCHEMA_BEHIND`) instead of as a
// storm of failing requests.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { readSchemaStatus } from "../db/schema-status.ts";
import type { Database } from "../db/schema.ts";

export const HEALTH_ERROR_CODES = ["SCHEMA_BEHIND"] as const;
export type HealthErrorCode = (typeof HEALTH_ERROR_CODES)[number];

export type HealthReport =
  { status: "ok" } | { status: "error"; code?: HealthErrorCode };

type HealthOptions = {
  /** Serverless: fail while the database lacks a migration of this version. */
  checkSchema?: boolean;
  /** Replaces the shipped migrations; for tests. */
  provider?: MigrationProvider;
  log?: (line: string) => void;
};

// A schema that was complete stays complete: migrations only go forward, so one confirmation per
// connection is enough and the probe costs one small read from then on. A WeakSet keeps nothing alive.
const confirmedUpToDate = new WeakSet<object>();
const reportedBehind = new WeakSet<object>();

/** `getDb` is called inside the check: an app that never opened its database reports an error too. */
export async function checkHealth(
  getDb: () => Kysely<Database>,
  {
    checkSchema = false,
    provider,
    log = (line) => console.error(line),
  }: HealthOptions = {},
): Promise<HealthReport> {
  try {
    const db = getDb();
    if (checkSchema && !confirmedUpToDate.has(db)) {
      const status = await readSchemaStatus(db, provider);
      if (!status.upToDate) {
        if (!reportedBehind.has(db)) {
          reportedBehind.add(db);
          log(
            `[database] SCHEMA_BEHIND: ${String(status.pendingCount)} migration(s) of this version are not applied. ` +
              "Run `pnpm migrate` with DATABASE_URL_MIGRATE; this instance answers 503 on /api/health until then.",
          );
        }
        return { status: "error", code: "SCHEMA_BEHIND" };
      }
      confirmedUpToDate.add(db);
    }
    // Reads a table, not just `select 1`: a file without the schema is not a healthy database.
    await sql`select 1 from app_meta limit 1`.execute(db);
    return { status: "ok" };
  } catch {
    return { status: "error" };
  }
}
