// SPDX-License-Identifier: LicenseRef-Proprietary

// #203: the `/ask`, `/improve` and `/describe` commands were removed; only `/review` remains. This
// data migration makes an existing database match that product:
//
//   1. Every job that is still waiting (`queued`) with a removed command is cancelled with the stable
//      code `command_removed`. Its id, command, args, actor, attempts, dedupe/comment records and any
//      result are kept; only the status, the error code, the timestamps and any residual lease/holder
//      data change. A waiting removed command is never rewritten into a review.
//   2. Every explicitly stored `allowedCommands` array (the global/workspace review defaults in
//      `app_settings` and the overrides in `projects.settings`) is intersected with `["review"]`. An
//      explicit empty result stays empty (`["ask"]` becomes `[]`, never `["review"]`), and every
//      other JSON field is untouched.
//
// A job that is already `running` is left alone: it may finish under its current fenced lease. If it
// is released or loses its lease later, the queue cancels it as a removed command instead of
// requeueing it (src/db/repositories/runner-jobs-repository.ts).
//
// The whole migration runs in the one transaction of the start (../migrate.ts): a failure rolls it
// back and stops the start, and a restart repeats it harmlessly (the update matches nothing once it
// ran).
import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { formatTimestamp } from "../codecs.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a migration must not depend on the current schema types.
type AnyDb = Kysely<any>;

/** The commands that still exist; the same set the product executes after #203. */
const SUPPORTED_COMMANDS = ["review"] as const;
/** The commands this migration cancels in the queue. */
const REMOVED_COMMANDS_SQL = sql`('improve', 'describe', 'ask')`;

/** Parses stored JSON; `undefined` when the text is not valid JSON (leave it alone). */
function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The stored `allowedCommands` of a settings object, intersected with the commands that still exist
 * (order kept, duplicates dropped, non-string entries dropped). `undefined` when the object has no
 * `allowedCommands` field or it is not an array: then nothing changes.
 */
function normalizedCommands(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    if (!(SUPPORTED_COMMANDS as readonly string[]).includes(entry)) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

/** The settings object with its `allowedCommands` intersected; `changed` is false when nothing moves. */
function normalizeSettings(raw: unknown): { changed: boolean; value: unknown } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { changed: false, value: raw };
  const object = raw as Record<string, unknown>;
  if (!Object.hasOwn(object, "allowedCommands"))
    return { changed: false, value: raw };
  const normalized = normalizedCommands(object.allowedCommands);
  if (normalized === undefined) return { changed: false, value: raw };
  const current = object.allowedCommands as unknown[];
  if (
    current.length === normalized.length &&
    current.every((entry, index) => entry === normalized[index])
  )
    return { changed: false, value: raw };
  return { changed: true, value: { ...object, allowedCommands: normalized } };
}

export const migration: Migration = {
  async up(db: AnyDb): Promise<void> {
    const timestamp = formatTimestamp(new Date());

    // 1. Cancel every waiting removed command. Running and finished jobs are not touched.
    await sql`
      update jobs
      set status = 'cancelled',
          error_code = 'command_removed',
          runner_id = null,
          lease_token = null,
          claimed_at = null,
          heartbeat_at = null,
          lease_expires_at = null,
          finished_at = ${timestamp},
          updated_at = ${timestamp}
      where status = 'queued'
        and command in ${REMOVED_COMMANDS_SQL}
    `.execute(db);

    // 2a. The global/workspace review defaults live in one `app_settings` row per workspace.
    const appSettings = await sql<{
      workspace_id: string;
      key: string;
      value: string;
    }>`select workspace_id, key, value from app_settings`.execute(db);
    for (const row of appSettings.rows) {
      const parsed = parseJson(row.value);
      if (parsed === undefined) continue;
      const normalized = normalizeSettings(parsed);
      if (!normalized.changed) continue;
      await sql`
        update app_settings
        set value = ${JSON.stringify(normalized.value)}
        where workspace_id = ${row.workspace_id} and key = ${row.key}
      `.execute(db);
    }

    // 2b. A project's overrides live in `projects.settings`.
    const projects = await sql<{
      id: string;
      settings: string | null;
    }>`select id, settings from projects`.execute(db);
    for (const row of projects.rows) {
      if (row.settings === null) continue;
      const parsed = parseJson(row.settings);
      if (parsed === undefined) continue;
      const normalized = normalizeSettings(parsed);
      if (!normalized.changed) continue;
      await sql`
        update projects
        set settings = ${JSON.stringify(normalized.value)}
        where id = ${row.id}
      `.execute(db);
    }
  },
};
