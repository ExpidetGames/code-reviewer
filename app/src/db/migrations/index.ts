// The ordered list of migrations. Kysely runs them in the alphabetical order of these keys, so
// every key starts with a four digit sequence number. A migration that has run is never edited: add
// a new one instead. Registered statically (not read from the disk) so it works in a Next.js bundle.
import type { Migration, MigrationProvider } from "kysely/migration";
import { migration as createAppMeta } from "./0001_create_app_meta.ts";

const migrations: Record<string, Migration> = {
  "0001_create_app_meta": createAppMeta,
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
