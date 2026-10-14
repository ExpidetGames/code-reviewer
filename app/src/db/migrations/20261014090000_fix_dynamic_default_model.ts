// SPDX-License-Identifier: Apache-2.0

// #262: the default Dynamic Review model was spelled `deepseek-v4.1-flash`, but the name is sent as it
// is to OpenRouter, which serves `deepseek/deepseek-v4.1-flash`. A project (or the workspace review
// defaults) that saved the old default as an explicit `dynamicModel` would fail its first Dynamic run
// at the provider, so every stored `dynamicModel` of exactly the old name becomes the OpenRouter id.
// Any other model, every other field and every other setting stay as they are.
//
// Forward-only. Each row is rewritten with an update that also compares the stored text with the
// text this migration read, so a settings save that lands between the read and the write is never
// overwritten (the row is simply not touched). Running the same body again finds no row with the old
// name and changes nothing. A row whose JSON cannot be read, or is not an object, is left alone. The
// migration runs in the one transaction of the start (../migrate.ts).
import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a migration must not depend on the current schema types.
type AnyDb = Kysely<any>;

const OLD_MODEL = "deepseek-v4.1-flash";
const NEW_MODEL = "deepseek/deepseek-v4.1-flash";

/** The new JSON text of a stored settings object, or `undefined` when nothing has to change. */
export function rewritten(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return undefined;
  const object = parsed as Record<string, unknown>;
  if (object.dynamicModel !== OLD_MODEL) return undefined;
  return JSON.stringify({ ...object, dynamicModel: NEW_MODEL });
}

/** Rewrites one `app_settings` value if it still holds `read`; false when it changed meanwhile. */
export async function updateDefaultsIfUnchanged(
  db: AnyDb,
  row: { workspaceId: string; key: string },
  read: string,
  next: string,
): Promise<boolean> {
  const result = await sql`
    update app_settings
    set value = ${next}
    where workspace_id = ${row.workspaceId} and key = ${row.key} and value = ${read}
  `.execute(db);
  return Number(result.numAffectedRows ?? 0) > 0;
}

/** Rewrites one project's settings if they still hold `read`; false when they changed meanwhile. */
export async function updateProjectIfUnchanged(
  db: AnyDb,
  id: string,
  read: string,
  next: string,
): Promise<boolean> {
  const result = await sql`
    update projects set settings = ${next} where id = ${id} and settings = ${read}
  `.execute(db);
  return Number(result.numAffectedRows ?? 0) > 0;
}

export const migration: Migration = {
  async up(db: AnyDb): Promise<void> {
    // The workspace review defaults live in one `app_settings` row per workspace.
    const appSettings = await sql<{
      workspace_id: string;
      key: string;
      value: string;
    }>`select workspace_id, key, value from app_settings`.execute(db);
    for (const row of appSettings.rows) {
      const next = rewritten(row.value);
      if (next === undefined) continue;
      await updateDefaultsIfUnchanged(
        db,
        { workspaceId: row.workspace_id, key: row.key },
        row.value,
        next,
      );
    }

    // A project's overrides live in `projects.settings`.
    const projects = await sql<{
      id: string;
      settings: string | null;
    }>`select id, settings from projects`.execute(db);
    for (const row of projects.rows) {
      const next = rewritten(row.settings);
      if (next === undefined || row.settings === null) continue;
      await updateProjectIfUnchanged(db, row.id, row.settings, next);
    }
  },
};
