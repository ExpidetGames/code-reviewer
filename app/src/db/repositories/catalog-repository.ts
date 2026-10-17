// SPDX-License-Identifier: Apache-2.0

// Access to the model_catalog_entries table: the operator's list of the models that workspaces on the operator's key
// may use (#425, src/model-catalog/README.md). Instance level: the table is configuration, not customer data, and no
// workspace owns an entry. The service above this module holds the rules (names, status moves, the check against the
// provider); this one stores, reads and guards what only the database can keep true on several app instances: a name is
// unique whatever its case, a status moves only from the status the caller saw, and a draft is the only entry deleted.
//
// Two reads are written for the privacy of the model. `listMemberEntries` selects only the columns a member may see, so
// the provider and the model id are not even read. `countProjectsSelecting` answers a number for the operator's
// confirmation and reads no row of a workspace into the answer.
import "server-only";
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Selectable } from "kysely";
import { formatTimestamp, tryDecodeJson } from "../codecs.ts";
import { errorCode } from "../errors.ts";
import {
  CATALOG_KINDS,
  isCatalogStatus,
  type CatalogEntry,
  type CatalogStatus,
} from "../../model-catalog/entries.ts";
import type { MemberCatalogEntry } from "../../model-catalog/member.ts";
import type { ProjectReviewKind } from "../../review-settings/settings.ts";
import type { Database, ModelCatalogEntriesTable } from "../schema.ts";

/** The names of the project settings that hold a catalog entry id, one per kind (#430 writes them; ADR 0005, 2.7). */
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
  /** Deletes the entry when it is a draft; false for any other status and for an id that is not there. */
  deleteDraft(id: string): Promise<boolean>;
  /** What a member may see: the released and the retired entries, with no provider and no model id. */
  listMemberEntries(): Promise<MemberCatalogEntry[]>;
  /** The model id of every entry of every status, once each: the ids that must never reach a member. */
  allModelIds(): Promise<string[]>;
  /** How many projects, of any workspace, select the entry for a kind. A number only. */
  countProjectsSelecting(id: string): Promise<number>;
};

type Row = Selectable<ModelCatalogEntriesTable>;
type MemberRow = Pick<
  Row,
  | "id"
  | "name"
  | "description"
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

/** True when a stored project settings text selects `id` in one of the selection settings. */
function selects(settings: string, id: string): boolean {
  const decoded = tryDecodeJson<unknown>(settings);
  if (
    !decoded.ok ||
    typeof decoded.value !== "object" ||
    decoded.value === null
  )
    return false;
  const value = decoded.value as Record<string, unknown>;
  return CATALOG_SELECTION_KEYS.some((key) => value[key] === id);
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

    async countProjectsSelecting(id) {
      // The id is opaque text; the filter only narrows the rows (`_` and `%` in `like` are wildcards, which can only
      // let more rows through), and the settings are read again as JSON so that an id that merely appears in some
      // other setting does not count.
      const rows = await db
        .selectFrom("projects")
        .select("settings")
        .where(sql<boolean>`settings like ${`%${id}%`}`)
        .execute();
      return rows.filter((row) => selects(row.settings, id)).length;
    },
  };
}
