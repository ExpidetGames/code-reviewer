// SPDX-License-Identifier: Apache-2.0

// #434 (epic #420, docs/decisions/0005-providers-model-catalog-and-paddle-billing.md, decision C1): the managed model tiers
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

async function rewriteProjects(
  db: AnyDb,
  tiers: Map<string, Tier>,
  ids: EntryIds,
): Promise<void> {
  const projects = await sql<{
    id: string;
    workspace_id: string;
  }>`
    select p.id as id, r.workspace_id as workspace_id
    from projects p join repositories r on r.id = p.repository_id
  `.execute(db);
  for (const project of projects.rows) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const row = await sql<{ settings: string | null }>`
        select settings from projects where id = ${project.id}
      `.execute(db);
      const read = row.rows[0]?.settings;
      if (typeof read !== "string") break;
      const result = rewriteSettings(read, {
        workspaceTier: tiers.get(project.workspace_id),
        ids,
      });
      if (result.kind === "damaged") {
        console.warn(
          `[migration] model tiers: the settings of project ${project.id} cannot be read and were skipped.`,
        );
        break;
      }
      if (result.kind === "unchanged") break;
      const updated = await sql`
        update projects set settings = ${result.text}
        where id = ${project.id} and settings = ${read}
      `.execute(db);
      if (Number(updated.numAffectedRows ?? 0) > 0) break;
    }
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
