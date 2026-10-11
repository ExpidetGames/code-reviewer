// Access to the workspaces table: the owners of customer data. Instance level (it is the table that
// scoping starts from, so it takes no workspace). Members are not handled here yet; the workspaces
// feature adds them. See src/workspaces/README.md.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database, WorkspacesTable } from "../schema.ts";

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  createdBy: string | null;
  createdAt: string;
};

export type WorkspacesRepository = {
  get(id: string): Promise<Workspace | undefined>;
  /** The oldest workspace, which is the default one the migration made; undefined when there is none. */
  findDefault(): Promise<Workspace | undefined>;
  /**
   * The default workspace, created ("Default workspace", slug "default") when the database has none.
   * Two callers at once end with the same workspace. TEMPORARY: until the first-run setup creates the
   * workspace, the app works in this one (src/workspaces/current-workspace.ts).
   */
  ensureDefault(): Promise<Workspace>;
  create(input: {
    name: string;
    slug: string;
    createdBy: string | null;
  }): Promise<Workspace>;
};

export const DEFAULT_WORKSPACE_SLUG = "default";

function toWorkspace(row: WorkspacesTable): Workspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function createWorkspacesRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
  newId: () => string = () => crypto.randomUUID(),
): WorkspacesRepository {
  async function findDefault() {
    const row = await db
      .selectFrom("workspaces")
      .selectAll()
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
        .executeTakeFirst();
      return row === undefined ? undefined : toWorkspace(row);
    },

    findDefault,

    async ensureDefault() {
      const existing = await findDefault();
      if (existing !== undefined) return existing;
      await db
        .insertInto("workspaces")
        .values({
          id: newId(),
          name: "Default workspace",
          slug: DEFAULT_WORKSPACE_SLUG,
          created_by: null,
          created_at: formatTimestamp(now()),
        })
        // A concurrent first request made it a moment ago.
        .onConflict((conflict) => conflict.column("slug").doNothing())
        .execute();
      const created = await findDefault();
      if (created === undefined)
        throw new Error("The default workspace could not be created.");
      return created;
    },

    async create(input) {
      const row: WorkspacesTable = {
        id: newId(),
        name: input.name,
        slug: input.slug,
        created_by: input.createdBy,
        created_at: formatTimestamp(now()),
      };
      await db.insertInto("workspaces").values(row).execute();
      return toWorkspace(row);
    },
  };
}
