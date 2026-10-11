// Access to the projects table. The only code that reads or writes it. A project is a repository the
// instance reviews. The row is created by the first activation and never deleted: deactivating sets
// `active` to 0, and activating again switches the same row back on, so the settings a project
// collected in between survive. A repository the platform stopped listing keeps its row too; it is
// "unavailable" and cannot be activated (the repositories table says so, not this one).
import "server-only";
import type { Kysely } from "kysely";
import type {
  IntegrationStatus,
  IntegrationType,
  JsonValue,
} from "../../integrations/types.ts";
import {
  decodeBoolean,
  tryDecodeJson,
  encodeBoolean,
  encodeJson,
  formatTimestamp,
} from "../codecs.ts";
import type { Database, ProjectsTable } from "../schema.ts";

export type ProjectSettings = { [key: string]: JsonValue };

/** A project as stored. */
export type StoredProject = {
  id: string;
  repositoryId: string;
  active: boolean;
  /** The project's setting overrides (src/review-settings); empty until some are saved. */
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
};

/**
 * What the list shows for a repository:
 * - `active`: a project exists, is switched on, and the platform still lists the repository;
 * - `inactive`: no project yet, or it was switched off;
 * - `unavailable`: the platform no longer lists the repository, or its integration is suspended or
 *   removed (the project row, if any, is kept).
 */
export const PROJECT_STATUSES = ["active", "inactive", "unavailable"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** One repository of the list, with the integration it belongs to and its project, if it has one. */
export type ProjectListEntry = {
  repository: {
    id: string;
    externalId: string;
    fullName: string;
    url: string;
    /** False once the platform no longer lists the repository or its integration is disabled. */
    available: boolean;
    integration: {
      id: string;
      type: IntegrationType;
      displayName: string;
      status: IntegrationStatus;
    };
  };
  project: StoredProject | null;
  status: ProjectStatus;
};

export type ActivateResult =
  | {
      kind: "activated";
      project: StoredProject;
      /** `created`: first activation; `reactivated`: the row was off; `unchanged`: it was on already. */
      outcome: "created" | "reactivated" | "unchanged";
    }
  | { kind: "repository_not_found" }
  | { kind: "repository_unavailable" }
  /** The repository is listed, but its integration is suspended or removed (status `disabled`). */
  | { kind: "integration_unavailable" };

export type DeactivateResult =
  | {
      kind: "deactivated";
      /** The project after the call; undefined when the repository never had one. */
      project: StoredProject | undefined;
      /** False when there was nothing to switch off (no project, or already off). */
      changed: boolean;
    }
  | { kind: "repository_not_found" };

/**
 * Runs inside the deactivation's transaction, with the project as it is now and the executor to use
 * for its own queries (never the outer connection, see src/db/README.md). A failure rolls the
 * deactivation back.
 */
export type AfterDeactivate = (
  project: StoredProject,
  executor: Kysely<Database>,
) => Promise<void>;

export type ProjectsRepository = {
  /** The project of a repository, switched on or not. */
  get(repositoryId: string): Promise<StoredProject | undefined>;
  /** The project of a repository when it is switched on and the platform still lists the repository. */
  findActiveForRepository(
    repositoryId: string,
  ): Promise<StoredProject | undefined>;
  /** Same, found by the platform's id of the repository (what a webhook carries). */
  findActiveForExternalRepository(
    integrationId: string,
    externalId: string,
  ): Promise<StoredProject | undefined>;
  /**
   * Switches the project of a repository on, creating it the first time, in one transaction. A
   * repository the platform no longer lists, or that does not exist, is refused without a write.
   */
  activate(repositoryId: string): Promise<ActivateResult>;
  /**
   * Switches the project of a repository off and keeps the row; an unknown repository is reported.
   * `afterDeactivate` runs in the same
   * transaction whenever the repository has a project (also when it was off already, so a repeated
   * call can finish cleaning up).
   */
  deactivate(
    repositoryId: string,
    afterDeactivate?: AfterDeactivate,
  ): Promise<DeactivateResult>;
  /**
   * Replaces the settings (the overrides of the review settings) of the project of a repository and
   * moves `updatedAt`. Works for a project that is switched off too. Returns the project after the
   * change, or undefined when the repository has no project (nothing is written then).
   */
  updateSettings(
    repositoryId: string,
    settings: ProjectSettings,
  ): Promise<StoredProject | undefined>;
  /**
   * Every repository the platform lists, plus the ones that disappeared but have a project, joined
   * with their integration and project, ordered by name.
   */
  list(): Promise<ProjectListEntry[]>;
  /** One entry of the list, found by the id of its repository; undefined when the list has none. */
  find(repositoryId: string): Promise<ProjectListEntry | undefined>;
};

/**
 * The settings of a project as an object. Damaged text (not JSON) must not take the project list, the
 * claim and every review down: it reads as no settings, and a warning names the project (never the
 * text). Saving settings again replaces it.
 */
function readSettings(
  text: string,
  projectId: string,
  warn: (message: string) => void,
): ProjectSettings {
  const decoded = tryDecodeJson<ProjectSettings>(text);
  if (decoded.ok) return decoded.value;
  warn(
    `[db] PROJECT_SETTINGS_UNREADABLE: the stored settings of project ${projectId} are not valid JSON and are ignored.`,
  );
  return {};
}

function toStoredProject(
  row: ProjectsTable,
  warn: (message: string) => void,
): StoredProject {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    active: decodeBoolean(row.active),
    settings: readSettings(row.settings, row.id, warn),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createProjectsRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
  newId: () => string = () => crypto.randomUUID(),
  warn: (message: string) => void = console.warn,
): ProjectsRepository {
  const toStored = (row: ProjectsTable): StoredProject =>
    toStoredProject(row, warn);

  // A transaction cannot start another one; inside one, just use it.
  function inTransaction<T>(
    run: (executor: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    return db.isTransaction ? run(db) : db.transaction().execute(run);
  }

  async function findActive(
    where: (
      query: ReturnType<typeof baseActiveQuery>,
    ) => ReturnType<typeof baseActiveQuery>,
  ): Promise<StoredProject | undefined> {
    const row = await where(baseActiveQuery()).executeTakeFirst();
    return row === undefined ? undefined : toStored(row);
  }

  // The project columns of a switched-on project whose repository the platform still lists and whose
  // integration is not suspended or removed.
  function baseActiveQuery() {
    return db
      .selectFrom("projects")
      .innerJoin("repositories", "repositories.id", "projects.repository_id")
      .innerJoin(
        "integrations",
        "integrations.id",
        "repositories.integration_id",
      )
      .select([
        "projects.id",
        "projects.repository_id",
        "projects.active",
        "projects.settings",
        "projects.created_at",
        "projects.updated_at",
      ])
      .where("projects.active", "=", encodeBoolean(true))
      .where("repositories.active", "=", encodeBoolean(true))
      .where("integrations.status", "=", "active");
  }

  function entryQuery() {
    return (
      db
        .selectFrom("repositories")
        .innerJoin(
          "integrations",
          "integrations.id",
          "repositories.integration_id",
        )
        .leftJoin("projects", "projects.repository_id", "repositories.id")
        .select([
          "repositories.id as repository_id",
          "repositories.external_id as repository_external_id",
          "repositories.full_name as repository_full_name",
          "repositories.url as repository_url",
          "repositories.active as repository_active",
          "integrations.id as integration_id",
          "integrations.type as integration_type",
          "integrations.display_name as integration_display_name",
          "integrations.status as integration_status",
          "projects.id as project_id",
          "projects.active as project_active",
          "projects.settings as project_settings",
          "projects.created_at as project_created_at",
          "projects.updated_at as project_updated_at",
        ])
        // A repository that disappeared and never had a project is of no interest to anybody.
        .where((eb) =>
          eb.or([
            eb("repositories.active", "=", encodeBoolean(true)),
            eb("projects.id", "is not", null),
          ]),
        )
        .orderBy("repositories.full_name")
        .orderBy("repositories.id")
    );
  }

  function toEntry(
    row: Awaited<ReturnType<ReturnType<typeof entryQuery>["execute"]>>[number],
  ): ProjectListEntry {
    const available =
      decodeBoolean(row.repository_active) &&
      row.integration_status === "active";
    const project: StoredProject | null =
      row.project_id === null ||
      row.project_active === null ||
      row.project_settings === null ||
      row.project_created_at === null ||
      row.project_updated_at === null
        ? null
        : {
            id: row.project_id,
            repositoryId: row.repository_id,
            active: decodeBoolean(row.project_active),
            settings: readSettings(row.project_settings, row.project_id, warn),
            createdAt: row.project_created_at,
            updatedAt: row.project_updated_at,
          };
    const status: ProjectStatus = !available
      ? "unavailable"
      : project?.active === true
        ? "active"
        : "inactive";
    return {
      repository: {
        id: row.repository_id,
        externalId: row.repository_external_id,
        fullName: row.repository_full_name,
        url: row.repository_url,
        available,
        integration: {
          id: row.integration_id,
          type: row.integration_type as IntegrationType,
          displayName: row.integration_display_name,
          status: row.integration_status as IntegrationStatus,
        },
      },
      project,
      status,
    };
  }

  return {
    async get(repositoryId) {
      const row = await db
        .selectFrom("projects")
        .selectAll()
        .where("repository_id", "=", repositoryId)
        .executeTakeFirst();
      return row === undefined ? undefined : toStored(row);
    },

    findActiveForRepository(repositoryId) {
      return findActive((query) =>
        query.where("projects.repository_id", "=", repositoryId),
      );
    },

    findActiveForExternalRepository(integrationId, externalId) {
      return findActive((query) =>
        query
          .where("repositories.integration_id", "=", integrationId)
          .where("repositories.external_id", "=", externalId),
      );
    },

    activate(repositoryId) {
      // Transactions begin immediate (src/db/dialect.ts): the check of the repository and the write
      // happen under the write lock, so a sync that deactivates the repository cannot slip in between
      // and two activations cannot both insert.
      return inTransaction(async (trx): Promise<ActivateResult> => {
        const repository = await trx
          .selectFrom("repositories")
          .innerJoin(
            "integrations",
            "integrations.id",
            "repositories.integration_id",
          )
          .select([
            "repositories.id",
            "repositories.active",
            "integrations.status as integration_status",
          ])
          .where("repositories.id", "=", repositoryId)
          .executeTakeFirst();
        if (repository === undefined) return { kind: "repository_not_found" };
        if (!decodeBoolean(repository.active))
          return { kind: "repository_unavailable" };
        if (repository.integration_status !== "active")
          return { kind: "integration_unavailable" };

        const timestamp = formatTimestamp(now());
        const existing = await trx
          .selectFrom("projects")
          .selectAll()
          .where("repository_id", "=", repositoryId)
          .executeTakeFirst();

        if (existing === undefined) {
          const row = await trx
            .insertInto("projects")
            .values({
              id: newId(),
              repository_id: repositoryId,
              active: encodeBoolean(true),
              settings: encodeJson({}),
              created_at: timestamp,
              updated_at: timestamp,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          return {
            kind: "activated",
            project: toStored(row),
            outcome: "created",
          };
        }

        if (decodeBoolean(existing.active))
          return {
            kind: "activated",
            project: toStored(existing),
            outcome: "unchanged",
          };

        const row = await trx
          .updateTable("projects")
          .set({ active: encodeBoolean(true), updated_at: timestamp })
          .where("id", "=", existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return {
          kind: "activated",
          project: toStored(row),
          outcome: "reactivated",
        };
      });
    },

    deactivate(repositoryId, afterDeactivate) {
      return inTransaction(async (trx): Promise<DeactivateResult> => {
        const existing = await trx
          .selectFrom("projects")
          .selectAll()
          .where("repository_id", "=", repositoryId)
          .executeTakeFirst();
        if (existing === undefined) {
          const repository = await trx
            .selectFrom("repositories")
            .select("id")
            .where("id", "=", repositoryId)
            .executeTakeFirst();
          return repository === undefined
            ? { kind: "repository_not_found" }
            : { kind: "deactivated", project: undefined, changed: false };
        }

        const changed = decodeBoolean(existing.active);
        const row = changed
          ? await trx
              .updateTable("projects")
              .set({
                active: encodeBoolean(false),
                updated_at: formatTimestamp(now()),
              })
              .where("id", "=", existing.id)
              .returningAll()
              .executeTakeFirstOrThrow()
          : existing;
        const project = toStored(row);
        if (afterDeactivate !== undefined) await afterDeactivate(project, trx);
        return { kind: "deactivated", project, changed };
      });
    },

    async updateSettings(repositoryId, settings) {
      const row = await db
        .updateTable("projects")
        .set({
          settings: encodeJson(settings),
          updated_at: formatTimestamp(now()),
        })
        .where("repository_id", "=", repositoryId)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toStored(row);
    },

    async list() {
      const rows = await entryQuery().execute();
      return rows.map(toEntry);
    },

    async find(repositoryId) {
      const row = await entryQuery()
        .where("repositories.id", "=", repositoryId)
        .executeTakeFirst();
      return row === undefined ? undefined : toEntry(row);
    },
  };
}
