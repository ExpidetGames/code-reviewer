// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the model_catalog_entries table: the operator's list of the models that workspaces on the operator's key
// may use (#425, src/model-catalog/README.md). Instance level: the table is configuration, not customer data, and no
// workspace owns an entry. The service above this module holds the rules (names, status moves, the check against the
// provider); this one stores, reads and guards what only the database can keep true on several app instances: a name is
// unique whatever its case, a status moves only from the status the caller saw, and a draft is the only entry deleted.
//
// Two reads are written for the privacy of the model. `listMemberEntries` returns the columns a member may see and the
// label of the model provider (#675); the provider id and the model id are read only to make that label and do not leave it. `countProjectsUsing` answers one number per entry for the operator's
// "used by" and for the confirmation of a change of model, and returns no row, project or workspace.
import "server-only";
import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { formatTimestamp, tryDecodeJson } from "../codecs.ts";
import { errorCode } from "../errors.ts";
import {
  CATALOG_KINDS,
  isCatalogStatus,
  type CatalogDefaults,
  type CatalogEntry,
  type CatalogStatus,
} from "../../model-catalog/entries.ts";
import type { MemberCatalogEntry } from "../../model-catalog/member.ts";
import { providerLabelOf } from "../../model-catalog/provider-label.ts";
import type { ProjectReviewKind } from "../../review-settings/settings.ts";
import { readEntitlements } from "../../workspaces/entitlements-validation.ts";
import type { Database, ModelCatalogEntriesTable } from "../schema.ts";

/** The names of the project settings that hold a catalog entry id, one per kind (written by the review settings, #430; ADR 0005, 2.7). A test pins them to `PROJECT_CATALOG_FIELDS`. */
export const CATALOG_SELECTION_KEYS = [
  "catalogEntryDiff",
  "catalogEntryDynamic",
] as const;

/** Thrown by `insert` and `update` when another entry has the same name, whatever the case. */
export class CatalogNameTakenError extends Error {
  constructor(options?: ErrorOptions) {
    super("Another catalog entry has this name.", options);
    this.name = "CatalogNameTakenError";
  }
}

/** What a new entry is made of; it starts as a draft. `nameKey` is `nameKeyOf(name)`. */
export type NewCatalogEntry = {
  name: string;
  nameKey: string;
  description: string | null;
  provider: string;
  modelId: string;
  kinds: readonly ProjectReviewKind[];
  sortOrder: number;
};

export type CatalogPatch = Partial<NewCatalogEntry>;

export type CatalogRepository = {
  /** Every entry, by sort order and then by name. */
  list(): Promise<CatalogEntry[]>;
  get(id: string): Promise<CatalogEntry | undefined>;
  /** Inserts a draft. Rejects with `CatalogNameTakenError` when the name is taken; the database refuses no kind. */
  insert(
    input: NewCatalogEntry,
    updatedBy: string | null,
  ): Promise<CatalogEntry>;
  /**
   * Changes the given fields and records who and when. Undefined when there is no such entry, or when
   * `expectedUpdatedAt` is given and the entry was changed since (the caller's check no longer holds).
   */
  update(
    id: string,
    patch: CatalogPatch,
    updatedBy: string | null,
    expectedUpdatedAt?: string,
  ): Promise<CatalogEntry | undefined>;
  /** Moves the status from `from` to `to` in one guarded statement; undefined when it was not `from` (or was changed since). */
  setStatus(
    id: string,
    from: CatalogStatus,
    to: CatalogStatus,
    updatedBy: string | null,
    expectedUpdatedAt?: string,
  ): Promise<CatalogEntry | undefined>;
  /**
   * Puts the entries at the places of their position in `ids` (sort order 0, 1, 2, ...) in one transaction, writing only
   * the entries that move. False, and nothing written, when `ids` is not exactly the set of entries (one is missing,
   * unknown or repeated): the caller saw a list that is not the catalog any more.
   */
  reorder(ids: readonly string[], updatedBy: string | null): Promise<boolean>;
  /** Deletes the entry when it is a draft; false for any other status and for an id that is not there. */
  deleteDraft(id: string): Promise<boolean>;
  /** What a member may see: the released and the retired entries, with no provider and no model id. */
  listMemberEntries(): Promise<MemberCatalogEntry[]>;
  /** The model id of every entry of every status, once each: the ids that must never reach a member. */
  allModelIds(): Promise<string[]>;
  /**
   * How many projects, of any workspace, use each entry: the projects whose settings select it for a kind, and, for a
   * project in a workspace on the operator's key that has chosen no entry for the kind it runs, the entry of `defaults`
   * for that kind (ADR 0005, 2.7). A project counts once per entry. One pass over the projects; numbers only, keyed by
   * entry id (an entry nobody uses is absent).
   */
  countProjectsUsing(
    defaults: CatalogDefaults,
  ): Promise<ReadonlyMap<string, number>>;
};

type Row = Selectable<ModelCatalogEntriesTable>;
type MemberRow = Pick<
  Row,
  | "id"
  | "name"
  | "description"
  | "provider"
  | "model_id"
  | "serves_diff"
  | "serves_dynamic"
  | "status"
  | "sort_order"
>;

function kindsOf(row: Pick<Row, "serves_diff" | "serves_dynamic">) {
  return CATALOG_KINDS.filter((kind) =>
    kind === "diff" ? row.serves_diff === 1 : row.serves_dynamic === 1,
  );
}

function statusOf(row: Pick<Row, "id" | "status">): CatalogStatus {
  if (!isCatalogStatus(row.status))
    throw new Error(`Catalog entry ${row.id} has an unknown status.`);
  return row.status;
}

function toEntry(row: Row): CatalogEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    provider: row.provider,
    modelId: row.model_id,
    kinds: kindsOf(row),
    status: statusOf(row),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function toMember(row: MemberRow): MemberCatalogEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    providerLabel: providerLabelOf({
      provider: row.provider,
      modelId: row.model_id,
    }),
    kinds: kindsOf(row),
    status: statusOf(row),
    sortOrder: row.sort_order,
  };
}

/** SQLite names the constraint kind, Postgres answers SQLSTATE 23505. */
function isUniqueViolation(cause: unknown): boolean {
  const code = errorCode(cause);
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "23505";
}

/** The setting of a project that names its entry, per kind. */
const SELECTION_KEY: Record<ProjectReviewKind, string> = {
  diff: CATALOG_SELECTION_KEYS[0],
  dynamic: CATALOG_SELECTION_KEYS[1],
};

/** The settings of a project read as an object; anything else (damaged text, a list) is no settings. */
function settingsOf(text: string): Record<string, unknown> {
  const decoded = tryDecodeJson<unknown>(text);
  if (
    !decoded.ok ||
    typeof decoded.value !== "object" ||
    decoded.value === null
  )
    return {};
  return decoded.value as Record<string, unknown>;
}

/** The entries one project uses: the ones it selects, and the default of the kind it runs when it chose none for it. */
function entriesUsedBy(
  settings: Record<string, unknown>,
  managed: boolean,
  defaults: CatalogDefaults,
): Set<string> {
  const used = new Set<string>();
  for (const key of CATALOG_SELECTION_KEYS) {
    const chosen = settings[key];
    if (typeof chosen === "string") used.add(chosen);
  }
  // The kind a project runs is its own setting, Diff until it says otherwise (review-settings/effective.ts).
  const kind: ProjectReviewKind =
    settings.reviewKind === "dynamic" ? "dynamic" : "diff";
  const fallback = defaults[kind];
  if (
    managed &&
    fallback !== null &&
    typeof settings[SELECTION_KEY[kind]] !== "string"
  )
    used.add(fallback);
  return used;
}

export function createCatalogRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
  newId: () => string = () => `mce_${randomUUID().replaceAll("-", "")}`,
): CatalogRepository {
  async function get(id: string): Promise<CatalogEntry | undefined> {
    const row = await db
      .selectFrom("model_catalog_entries")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined ? undefined : toEntry(row);
  }

  /** The columns a patch sets, with the author and the time. */
  function columnsOf(patch: CatalogPatch, updatedBy: string | null) {
    return {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.nameKey === undefined ? {} : { name_key: patch.nameKey }),
      ...(patch.description === undefined
        ? {}
        : { description: patch.description }),
      ...(patch.provider === undefined ? {} : { provider: patch.provider }),
      ...(patch.modelId === undefined ? {} : { model_id: patch.modelId }),
      ...(patch.kinds === undefined
        ? {}
        : {
            serves_diff: patch.kinds.includes("diff") ? 1 : 0,
            serves_dynamic: patch.kinds.includes("dynamic") ? 1 : 0,
          }),
      ...(patch.sortOrder === undefined ? {} : { sort_order: patch.sortOrder }),
      updated_by: updatedBy,
      updated_at: formatTimestamp(now()),
    };
  }

  async function write(
    id: string,
    set: ReturnType<typeof columnsOf> & { status?: CatalogStatus },
    guard: { status?: CatalogStatus; updatedAt?: string },
  ): Promise<CatalogEntry | undefined> {
    try {
      let query = db
        .updateTable("model_catalog_entries")
        .set(set)
        .where("id", "=", id);
      if (guard.status !== undefined)
        query = query.where("status", "=", guard.status);
      if (guard.updatedAt !== undefined)
        query = query.where("updated_at", "=", guard.updatedAt);
      const row = await query.returningAll().executeTakeFirst();
      return row === undefined ? undefined : toEntry(row);
    } catch (cause) {
      if (isUniqueViolation(cause)) throw new CatalogNameTakenError({ cause });
      throw cause;
    }
  }

  return {
    async list() {
      const rows = await db
        .selectFrom("model_catalog_entries")
        .selectAll()
        .orderBy("sort_order")
        .orderBy("name_key")
        .execute();
      return rows.map(toEntry);
    },

    get,

    async insert(input, updatedBy) {
      const timestamp = formatTimestamp(now());
      const row: Row = {
        id: newId(),
        name: input.name,
        name_key: input.nameKey,
        description: input.description,
        provider: input.provider,
        model_id: input.modelId,
        serves_diff: input.kinds.includes("diff") ? 1 : 0,
        serves_dynamic: input.kinds.includes("dynamic") ? 1 : 0,
        status: "draft",
        sort_order: input.sortOrder,
        created_at: timestamp,
        updated_at: timestamp,
        updated_by: updatedBy,
      };
      try {
        await db.insertInto("model_catalog_entries").values(row).execute();
      } catch (cause) {
        if (isUniqueViolation(cause))
          throw new CatalogNameTakenError({ cause });
        throw cause;
      }
      return toEntry(row);
    },

    update(id, patch, updatedBy, expectedUpdatedAt) {
      return write(id, columnsOf(patch, updatedBy), {
        ...(expectedUpdatedAt === undefined
          ? {}
          : { updatedAt: expectedUpdatedAt }),
      });
    },

    setStatus(id, from, to, updatedBy, expectedUpdatedAt) {
      return write(
        id,
        { ...columnsOf({}, updatedBy), status: to },
        {
          status: from,
          ...(expectedUpdatedAt === undefined
            ? {}
            : { updatedAt: expectedUpdatedAt }),
        },
      );
    },

    async reorder(ids, updatedBy) {
      const run = async (trx: Kysely<Database>): Promise<boolean> => {
        const rows = await trx
          .selectFrom("model_catalog_entries")
          .select(["id", "sort_order"])
          .execute();
        const current = new Map(rows.map((row) => [row.id, row.sort_order]));
        if (
          current.size !== ids.length ||
          new Set(ids).size !== ids.length ||
          !ids.every((id) => current.has(id))
        )
          return false;
        const timestamp = formatTimestamp(now());
        for (const [position, id] of ids.entries()) {
          if (current.get(id) === position) continue;
          await trx
            .updateTable("model_catalog_entries")
            .set({
              sort_order: position,
              updated_by: updatedBy,
              updated_at: timestamp,
            })
            .where("id", "=", id)
            .execute();
        }
        return true;
      };
      return db.isTransaction ? run(db) : db.transaction().execute(run);
    },

    async deleteDraft(id) {
      const result = await db
        .deleteFrom("model_catalog_entries")
        .where("id", "=", id)
        .where("status", "=", "draft")
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },

    async listMemberEntries() {
      const rows = await db
        .selectFrom("model_catalog_entries")
        .select([
          "id",
          "name",
          "description",
          "provider",
          "model_id",
          "serves_diff",
          "serves_dynamic",
          "status",
          "sort_order",
        ])
        .where("status", "in", ["released", "retired"])
        .orderBy("sort_order")
        .orderBy("name_key")
        .execute();
      return rows.map(toMember);
    },

    async allModelIds() {
      const rows = await db
        .selectFrom("model_catalog_entries")
        .select("model_id")
        .distinct()
        .execute();
      return rows.map((row) => row.model_id);
    },

    async countProjectsUsing(defaults) {
      // One pass: the settings of every project with the key mode of its workspace's row. A workspace without a row has
      // the default of the instance, which is read once. Only the counts leave this function.
      const rows = await db
        .selectFrom("projects")
        .innerJoin("repositories", "repositories.id", "projects.repository_id")
        .leftJoin(
          "workspace_entitlements",
          "workspace_entitlements.workspace_id",
          "repositories.workspace_id",
        )
        .select([
          "repositories.workspace_id as workspace_id",
          "projects.settings as settings",
          "workspace_entitlements.key_mode as key_mode",
        ])
        .execute();
      // The workspace defaults (#676): a project that sets no kind or entry of its own follows them.
      const defaultsRows = await db
        .selectFrom("app_settings")
        .select(["workspace_id", "value"])
        .where("key", "=", "review_defaults")
        .execute();
      const workspaceDefaults = new Map(
        defaultsRows.map((row) => [row.workspace_id, settingsOf(row.value)]),
      );
      const stored = await db
        .selectFrom("instance_settings")
        .select("value")
        .where("key", "=", "default_entitlements")
        .executeTakeFirst();
      const instanceDefault =
        stored === undefined ? undefined : tryDecodeJson<unknown>(stored.value);
      const instanceManaged =
        instanceDefault?.ok === true &&
        readEntitlements(instanceDefault.value)?.keyMode === "managed";

      const counts = new Map<string, number>();
      for (const row of rows) {
        const managed =
          row.key_mode === null ? instanceManaged : row.key_mode === "managed";
        const own = settingsOf(row.settings);
        const inherited = workspaceDefaults.get(row.workspace_id) ?? {};
        const effective: Record<string, unknown> = {};
        for (const key of ["reviewKind", ...CATALOG_SELECTION_KEYS])
          if (own[key] !== undefined) effective[key] = own[key];
          else if (inherited[key] !== undefined)
            effective[key] = inherited[key];
        for (const id of entriesUsedBy(effective, managed, defaults))
          counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return counts;
    },
  };
}
