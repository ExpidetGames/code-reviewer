// SPDX-License-Identifier: Apache-2.0

// Access to the workspaces table: the owners of customer data. Instance level (it is the table that
// scoping starts from, so it takes no workspace). It also answers the questions that start from a user
// rather than a workspace (which workspaces does this person belong to, in which role); the members of
// one workspace are in workspace-members-repository.ts. See src/workspaces/README.md.
import "server-only";
import { sql, type Kysely, type Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import { databaseDriver } from "../driver.ts";
import { isWorkspaceRole, type WorkspaceRole } from "../../workspaces/roles.ts";
import type { Database, WorkspacesTable } from "../schema.ts";

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  createdBy: string | null;
  createdAt: string;
  /** When the workspace was deleted (#658), or null. The readers below do not return a deleted one, except `getIncludingDeleted`. */
  deletedAt: string | null;
};

/** A workspace a user belongs to, with the role they have in it. */
export type Membership = { workspace: Workspace; role: WorkspaceRole };

export type WorkspacesRepository = {
  /** The workspace, or undefined when there is none or it was deleted (#658). */
  get(id: string): Promise<Workspace | undefined>;
  /**
   * The workspace as the row has it, a tombstone (name and address anonymised, `deletedAt` set) included. For the readers that
   * explain money which belongs to a deleted workspace; every other reader uses `get`. With `lock` the row is read `FOR SHARE`
   * on Postgres: a deletion that is in flight (it holds the row) is waited for and its result is what is read, so a credit that
   * checks the workspace first cannot land in one that is being deleted.
   */
  getIncludingDeleted(
    id: string,
    options?: { lock?: boolean },
  ): Promise<Workspace | undefined>;
  /** The oldest workspace that is not deleted, which is the default one the migration made; undefined when there is none. */
  findDefault(): Promise<Workspace | undefined>;
  /**
   * Whether a workspace has this slug. A tombstone counts only with its own anonymised address, which is unique like every
   * address; the address it had before is free again.
   */
  slugExists(slug: string): Promise<boolean>;
  /** The workspaces the user is a member of, in the order they joined (then by id). */
  listForUser(userId: string): Promise<Membership[]>;
  /**
   * The workspace with this slug, if (and only if) the user is a member of it, with their role. A workspace
   * the user does not belong to answers exactly like one that does not exist.
   */
  findMembership(userId: string, slug: string): Promise<Membership | undefined>;
  /** The same by workspace id. */
  findMembershipById(
    userId: string,
    workspaceId: string,
  ): Promise<Membership | undefined>;
  /** How many workspaces the user is an Owner of (what the limit "workspaces per user" counts). */
  countOwnedBy(userId: string): Promise<number>;
  /** Whether the user is a member of at least one workspace. */
  hasMembership(userId: string): Promise<boolean>;
  /** Changes the name; the slug stays. Returns false for an id nobody has. */
  rename(workspaceId: string, name: string): Promise<boolean>;
  create(input: {
    name: string;
    slug: string;
    createdBy: string | null;
  }): Promise<Workspace>;
  /** Makes the user a member with the role. A user who is a member already keeps their role. */
  addMember(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<void>;
  /** Whether the workspace has at least one Owner. */
  hasOwner(workspaceId: string): Promise<boolean>;
  /** How many workspaces the instance has (a deleted one, #658, is not one). */
  count(): Promise<number>;
  /**
   * The workspaces whose name holds the text (any case, `%` and `_` are plain characters), by name, at most `limit`; an
   * empty text lists the first ones. For the manual credit of the admin portal (#504).
   */
  search(text: string, limit: number): Promise<Workspace[]>;
  /**
   * A page of workspaces ordered by id, those after `after` (exclusive) when given. `hasMore` says whether
   * another page follows. For the operator API (#275): instance level, like the table.
   */
  listPage(input: {
    after?: string | undefined;
    limit: number;
  }): Promise<{ workspaces: Workspace[]; hasMore: boolean }>;
};

export const DEFAULT_WORKSPACE_SLUG = "default";

/**
 * The address a deleted workspace keeps (#658): the row stays because the billing journal points at it, with its name and
 * address anonymised (the address stays unique, so it carries the id). What marks it a tombstone is `deleted_at`, not this.
 */
export function deletedWorkspaceSlug(id: string): string {
  return `deleted-${id}`;
}

/** Whether a workspace is a tombstone. The one test for a workspace in memory; `NOT_DELETED` is the same for a query. */
export function isDeleted(workspace: { deletedAt: string | null }): boolean {
  return workspace.deletedAt !== null;
}

/** The rows that are workspaces, not tombstones: the condition of every query that reads `workspaces` for a customer or an operator. */
export const NOT_DELETED = sql<boolean>`workspaces.deleted_at is null`;

function toWorkspace(row: Selectable<WorkspacesTable>): Workspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdBy: row.created_by,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}

export function createWorkspacesRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
  newId: () => string = () => crypto.randomUUID(),
): WorkspacesRepository {
  /** The workspaces joined with one membership each; the caller says whose. */
  function memberships() {
    return db
      .selectFrom("workspace_members")
      .innerJoin(
        "workspaces",
        "workspaces.id",
        "workspace_members.workspace_id",
      )
      .select([
        "workspaces.id as id",
        "workspaces.name as name",
        "workspaces.slug as slug",
        "workspaces.created_by as created_by",
        "workspaces.created_at as created_at",
        "workspaces.deleted_at as deleted_at",
        "workspace_members.role as role",
      ])
      .where(NOT_DELETED);
  }

  function toMembership(
    row: Selectable<WorkspacesTable> & { role: string },
  ): Membership {
    if (!isWorkspaceRole(row.role))
      throw new Error(`The database holds an unknown role "${row.role}".`);
    return { workspace: toWorkspace(row), role: row.role };
  }

  async function findDefault() {
    const row = await db
      .selectFrom("workspaces")
      .selectAll()
      .where(NOT_DELETED)
      .orderBy("created_at")
      .orderBy("id")
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : toWorkspace(row);
  }

  return {
    async get(id) {
      const row = await db
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "=", id)
        .where(NOT_DELETED)
        .executeTakeFirst();
      return row === undefined ? undefined : toWorkspace(row);
    },

    async getIncludingDeleted(id, options) {
      let query = db.selectFrom("workspaces").selectAll().where("id", "=", id);
      if (options?.lock === true && databaseDriver(db) === "postgres")
        query = query.forShare();
      const row = await query.executeTakeFirst();
      return row === undefined ? undefined : toWorkspace(row);
    },

    findDefault,

    async count() {
      const row = await db
        .selectFrom("workspaces")
        .select((builder) => builder.fn.countAll<string | number>().as("count"))
        .where(NOT_DELETED)
        .executeTakeFirst();
      return Number(row?.count ?? 0);
    },

    async search(text, limit) {
      const escaped = text.toLowerCase().replace(/[\\%_]/g, "\\$&");
      let query = db.selectFrom("workspaces").selectAll().where(NOT_DELETED);
      if (escaped !== "")
        query = query.where(
          sql<boolean>`lower(name) like ${`%${escaped}%`} escape '\\'`,
        );
      const rows = await query
        .orderBy(sql`lower(name)`)
        .orderBy("id")
        .limit(limit)
        .execute();
      return rows.map(toWorkspace);
    },

    async slugExists(slug) {
      const row = await db
        .selectFrom("workspaces")
        .select("id")
        .where("slug", "=", slug)
        .executeTakeFirst();
      return row !== undefined;
    },

    async listForUser(userId) {
      const rows = await memberships()
        .where("workspace_members.user_id", "=", userId)
        .orderBy("workspace_members.created_at")
        .orderBy("workspaces.id")
        .execute();
      return rows.map(toMembership);
    },

    async findMembership(userId, slug) {
      const row = await memberships()
        .where("workspace_members.user_id", "=", userId)
        .where("workspaces.slug", "=", slug)
        .executeTakeFirst();
      return row === undefined ? undefined : toMembership(row);
    },

    async findMembershipById(userId, workspaceId) {
      const row = await memberships()
        .where("workspace_members.user_id", "=", userId)
        .where("workspaces.id", "=", workspaceId)
        .executeTakeFirst();
      return row === undefined ? undefined : toMembership(row);
    },

    async countOwnedBy(userId) {
      const row = await db
        .selectFrom("workspace_members")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("user_id", "=", userId)
        .where("role", "=", "owner")
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },

    async hasMembership(userId) {
      const row = await db
        .selectFrom("workspace_members")
        .select("user_id")
        .where("user_id", "=", userId)
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },

    async rename(workspaceId, name) {
      const result = await db
        .updateTable("workspaces")
        .set({ name })
        .where("id", "=", workspaceId)
        .where(NOT_DELETED)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async create(input) {
      const row = {
        id: newId(),
        name: input.name,
        slug: input.slug,
        created_by: input.createdBy,
        created_at: formatTimestamp(now()),
      };
      await db.insertInto("workspaces").values(row).execute();
      return toWorkspace({ ...row, deleted_at: null });
    },

    async addMember(workspaceId, userId, role) {
      await db
        .insertInto("workspace_members")
        .values({
          workspace_id: workspaceId,
          user_id: userId,
          role,
          created_at: formatTimestamp(now()),
        })
        .onConflict((conflict) =>
          conflict.columns(["workspace_id", "user_id"]).doNothing(),
        )
        .execute();
    },

    async hasOwner(workspaceId) {
      const row = await db
        .selectFrom("workspace_members")
        .select("user_id")
        .where("workspace_id", "=", workspaceId)
        .where("role", "=", "owner")
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },

    async listPage({ after, limit }) {
      let query = db.selectFrom("workspaces").selectAll().where(NOT_DELETED);
      if (after !== undefined) query = query.where("id", ">", after);
      // One more than asked for tells whether another page follows.
      const rows = await query
        .orderBy("id")
        .limit(limit + 1)
        .execute();
      return {
        workspaces: rows.slice(0, limit).map(toWorkspace),
        hasMore: rows.length > limit,
      };
    },
  };
}
