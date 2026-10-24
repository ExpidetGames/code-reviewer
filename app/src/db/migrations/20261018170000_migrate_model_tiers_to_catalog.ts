// SPDX-License-Identifier: LicenseRef-Proprietary

// #434 (epic #420, ADR 0005, decision C1): the managed model tiers
// become catalog entries, so that nothing changes for a workspace on the operator's key when the tiers are removed.
//
// 1. The instance setting `managed_model_tiers` (the model behind each tier and kind) becomes released catalog entries of
//    the default provider, named Low, Medium, High (or `<Tier> (Diff)` and `<Tier> (Dynamic)` when the two kinds use
//    different models), with the description the quality level had. The entries have ids that are a function of their
//    slug, so a second run finds them instead of making others.
// 2. The instance setting `catalog_defaults` gets the entries of the medium tier (the tier a project without a choice
//    had), for each kind that has no default yet.
// 3. The `modelTier` of a project (and of its workspace's review defaults, where the project has none and the tier is not
//    the default one) becomes `catalogEntryDiff` and `catalogEntryDynamic` in the project's settings, where it has none.
//
// It only adds. `managed_model_tiers`, the `modelTier` members and the usage records' `model_tier` stay as they are and
// are read by nothing; their removal is a later forward-only migration (a removal waits one release,
// docs/deployment-vercel.md, 5.6). No secret is read or written and nothing is decrypted, so it needs no `APP_SECRET`.
// A settings text that cannot be read is left alone and named by its id in the log (never by its content).
//
// Safe to run again: an entry that exists is not made again (the operator's changes to it stay), a default that is set
// stays, a selection that is set stays. A row is rewritten with an update that compares the text it read, and read
// again a few times if it changed meanwhile, so a settings save that lands between the read and the write is never
// overwritten. The migration runs in the one transaction of the start (../migrate.ts); the SQL is the same on SQLite and
// Postgres.
import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import {
  entryIdsOf,
  planDefaults,
  planEntries,
  readTierConfiguration,
  rewriteSettings,
  workspaceTierOf,
  type EntryIds,
  type Tier,
} from "./model-tiers-to-catalog.ts";
import { DEFAULT_LLM_PROVIDER } from "../../llm/providers/index.ts";
import { nameKeyOf } from "../../model-catalog/entries.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a migration must not depend on the current schema types.
type AnyDb = Kysely<any>;

/** How often a row that changed between the read and the write is read again. */
const ATTEMPTS = 3;

/** How many project ids the error of a migration that gave up names. */
const NAMED_PROJECTS = 20;

function parse(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The name an entry gets: the planned one, or with "(migrated)" when the operator already has an entry with the name. */
function freeName(base: string, taken: Set<string>): string {
  for (let attempt = 1; ; attempt += 1) {
    const name =
      attempt === 1
        ? base
        : `${base} (migrated${attempt === 2 ? "" : ` ${attempt - 1}`})`;
    if (!taken.has(nameKeyOf(name))) return name;
  }
}

async function addEntries(
  db: AnyDb,
  entries: ReturnType<typeof planEntries>,
  now: string,
): Promise<void> {
  const existing = await sql<{
    id: string;
    name_key: string;
    sort_order: number;
  }>`select id, name_key, sort_order from model_catalog_entries`.execute(db);
  const ids = new Set(existing.rows.map((row) => row.id));
  const names = new Set(existing.rows.map((row) => row.name_key));
  let sortOrder =
    existing.rows.length === 0
      ? 0
      : Math.max(...existing.rows.map((row) => Number(row.sort_order))) + 1;
  for (const entry of entries) {
    if (ids.has(entry.id)) continue;
    const name = freeName(entry.name, names);
    names.add(nameKeyOf(name));
    await db
      .insertInto("model_catalog_entries")
      .values({
        id: entry.id,
        name,
        name_key: nameKeyOf(name),
        description: entry.description,
        provider: DEFAULT_LLM_PROVIDER,
        model_id: entry.modelId,
        serves_diff: entry.kinds.includes("diff") ? 1 : 0,
        serves_dynamic: entry.kinds.includes("dynamic") ? 1 : 0,
        status: "released",
        sort_order: sortOrder,
        created_at: now,
        updated_at: now,
        updated_by: null,
      })
      .execute();
    sortOrder += 1;
  }
}

/** Sets the default of each kind that has none yet; a default the operator set stays. */
async function addDefaults(
  db: AnyDb,
  planned: { diff: string | null; dynamic: string | null },
  now: string,
): Promise<void> {
  if (planned.diff === null && planned.dynamic === null) return;
  const row = await sql<{ value: string }>`
    select value from instance_settings where key = 'catalog_defaults'
  `.execute(db);
  const stored = parse(row.rows[0]?.value);
  const current =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const kept = (kind: "diff" | "dynamic"): string | null => {
    const value = current[kind];
    return typeof value === "string" && value !== "" ? value : null;
  };
  const next = {
    diff: kept("diff") ?? planned.diff,
    dynamic: kept("dynamic") ?? planned.dynamic,
  };
  if (next.diff === kept("diff") && next.dynamic === kept("dynamic")) return;
  const value = JSON.stringify(next);
  await sql`
    insert into instance_settings (key, value, updated_by, updated_at)
    values ('catalog_defaults', ${value}, null, ${now})
    on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
  `.execute(db);
}

async function workspaceTiers(db: AnyDb): Promise<Map<string, Tier>> {
  const rows = await sql<{ workspace_id: string; value: string }>`
    select workspace_id, value from app_settings where key = 'review_defaults'
  `.execute(db);
  const tiers = new Map<string, Tier>();
  for (const row of rows.rows) {
    const found = workspaceTierOf(row.value);
    if (found.kind === "tier") tiers.set(row.workspace_id, found.tier);
    else if (found.kind === "damaged")
      console.warn(
        `[migration] model tiers: the review defaults of workspace ${row.workspace_id} cannot be read and were skipped.`,
      );
  }
  return tiers;
}

type ProjectRow = { id: string; workspace_id: string; settings: unknown };

/** A settings text to write, and the text it was made from. */
export type Rewrite = { id: string; read: string; text: string };

/** How many projects one statement writes (three parameters each, far below the limit of either engine). */
const CHUNK = 500;

function valuesOf(rows: readonly Rewrite[]) {
  return sql.join(
    rows.map((row) => sql`(${row.id}, ${row.read}, ${row.text})`),
  );
}

/**
 * Writes the settings of many projects with one statement per chunk. A row is written only if it still holds the text
 * it was read as, so a settings save that landed in between is never overwritten. Answers the ids that were written.
 */
export async function writeIfUnchanged(
  db: AnyDb,
  rewrites: readonly Rewrite[],
): Promise<Set<string>> {
  const written = new Set<string>();
  for (let from = 0; from < rewrites.length; from += CHUNK) {
    const chunk = rewrites.slice(from, from + CHUNK);
    const updated = await sql<{ id: string }>`
      with changes (id, read, written) as (values ${valuesOf(chunk)})
      update projects set settings = changes.written
      from changes
      where projects.id = changes.id and projects.settings = changes.read
      returning projects.id as id
    `.execute(db);
    for (const row of updated.rows) written.add(row.id);
  }
  return written;
}

function gaveUp(ids: readonly string[]): Error {
  const named = ids.slice(0, NAMED_PROJECTS).join(", ");
  const more =
    ids.length > NAMED_PROJECTS
      ? ` and ${ids.length - NAMED_PROJECTS} more`
      : "";
  return new Error(
    `model tiers: ${ids.length} project${ids.length === 1 ? "" : "s"} (${named}${more}) changed while the migration ` +
      `wrote them, ${ATTEMPTS} times in a row. Nothing was applied. Run the deploy again; if this repeats, stop the ` +
      `instances of the previous release first.`,
  );
}

async function rewriteProjects(
  db: AnyDb,
  tiers: Map<string, Tier>,
  ids: EntryIds,
): Promise<void> {
  // Every project in one read; the settings text comes with it. Damaged ones are named once, by id.
  let pending = (
    await sql<ProjectRow>`
      select p.id as id, r.workspace_id as workspace_id, p.settings as settings
      from projects p join repositories r on r.id = p.repository_id
      order by p.id
    `.execute(db)
  ).rows;
  for (
    let attempt = 0;
    attempt < ATTEMPTS && pending.length > 0;
    attempt += 1
  ) {
    const rewrites: Rewrite[] = [];
    for (const project of pending) {
      if (typeof project.settings !== "string") continue;
      const result = rewriteSettings(project.settings, {
        workspaceTier: tiers.get(project.workspace_id),
        ids,
      });
      if (result.kind === "damaged") {
        if (attempt === 0)
          console.warn(
            `[migration] model tiers: the settings of project ${project.id} cannot be read and were skipped.`,
          );
        continue;
      }
      if (result.kind === "changed")
        rewrites.push({
          id: project.id,
          read: project.settings,
          text: result.text,
        });
    }
    const written = await writeIfUnchanged(db, rewrites);
    // A row that changed meanwhile is read again, and rewritten from what it holds now.
    const missed = rewrites.filter((rewrite) => !written.has(rewrite.id));
    if (missed.length === 0) return;
    // Giving up would leave the project on its old tier, which runs on the default entry: a silent model change.
    // Failing rolls the whole migration back, and a rerun starts from the old state.
    if (attempt === ATTEMPTS - 1) throw gaveUp(missed.map((row) => row.id));
    const workspaceOf = new Map(
      pending.map((project) => [project.id, project.workspace_id]),
    );
    const current = await sql<{ id: string; settings: unknown }>`
      select id, settings from projects
      where id in (${sql.join(missed.map((rewrite) => rewrite.id))})
    `.execute(db);
    pending = current.rows.map((row) => ({
      id: row.id,
      workspace_id: workspaceOf.get(row.id) ?? "",
      settings: row.settings,
    }));
  }
}

export const migration: Migration = {
  async up(db: AnyDb): Promise<void> {
    const stored = await sql<{ value: string }>`
      select value from instance_settings where key = 'managed_model_tiers'
    `.execute(db);
    const entries = planEntries(
      readTierConfiguration(parse(stored.rows[0]?.value)),
    );
    // No model was configured: nothing can be an entry, and no project has anything to point at.
    if (entries.length === 0) return;

    const now = new Date().toISOString();
    await addEntries(db, entries, now);
    await addDefaults(db, planDefaults(entries), now);
    await rewriteProjects(db, await workspaceTiers(db), entryIdsOf(entries));
  },
};
