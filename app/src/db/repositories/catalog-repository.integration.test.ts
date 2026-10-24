// SPDX-License-Identifier: LicenseRef-Proprietary

// The repository of the model catalog (#425) on a real SQLite file and, when TEST_DATABASE_URL is set, on a real
// Postgres: the same code, the same answers.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createJobQueueFixture } from "../../test-support/jobs.ts";
import type { CatalogDefaults } from "../../model-catalog/entries.ts";
import type { EntitlementsData } from "../../workspaces/entitlements.ts";
import { defaultWorkspaceId } from "../../test-support/workspaces.ts";
import { createInstanceSettingsRepository } from "./instance-settings-repository.ts";
import { createWorkspaceEntitlementsRepository } from "./workspace-entitlements-repository.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { insertUser } from "../../test-support/users.ts";
import type { Database } from "../schema.ts";
import {
  CatalogNameTakenError,
  createCatalogRepository,
  type NewCatalogEntry,
} from "./catalog-repository.ts";

const ENGINES: Array<{
  name: string;
  open: () => Promise<Kysely<Database>>;
  skip: boolean;
}> = [
  {
    name: "SQLite",
    open: async () => (await createTestDatabase()).db,
    skip: false,
  },
  {
    name: "Postgres",
    open: async () => (await createPostgresTestDatabase()).db,
    skip: !hasPostgres(),
  },
];

const T0 = new Date("2026-10-17T10:00:00.000Z");

function entry(overrides: Partial<NewCatalogEntry> = {}): NewCatalogEntry {
  return {
    name: "Fast",
    nameKey: "fast",
    description: "Quick reviews.",
    provider: "openrouter",
    modelId: "acme/quick-1",
    kinds: ["diff"],
    sortOrder: 0,
    ...overrides,
  };
}

describe.each(ENGINES)("the model catalog repository on $name", (engine) => {
  const it_ = engine.skip ? it.skip : it;

  async function start() {
    const db = await engine.open();
    let now = T0;
    const repository = createCatalogRepository(db, () => now);
    return {
      db,
      repository,
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
    };
  }

  // #425-T01
  it_("creates a draft with an opaque id and reads it back whole", async () => {
    const { repository } = await start();

    const created = await repository.insert(
      entry({ kinds: ["diff", "dynamic"] }),
      null,
    );

    expect(created.id).toMatch(/^mce_[0-9a-f]{32}$/);
    expect(created).toEqual({
      id: created.id,
      name: "Fast",
      description: "Quick reviews.",
      provider: "openrouter",
      modelId: "acme/quick-1",
      kinds: ["diff", "dynamic"],
      status: "draft",
      sortOrder: 0,
      createdAt: "2026-10-17T10:00:00.000Z",
      updatedAt: "2026-10-17T10:00:00.000Z",
      updatedBy: null,
    });
    expect(await repository.get(created.id)).toEqual(created);
    expect(await repository.get("mce_missing")).toBeUndefined();
  });

  // #425-T01
  it_(
    "lists by sort order, then by name, and gives every entry its own id",
    async () => {
      const { repository } = await start();
      const b = await repository.insert(
        entry({ name: "B", nameKey: "b", sortOrder: 2 }),
        null,
      );
      const c = await repository.insert(
        entry({ name: "C", nameKey: "c", sortOrder: 1 }),
        null,
      );
      const a = await repository.insert(
        entry({ name: "A", nameKey: "a", sortOrder: 2 }),
        null,
      );

      expect((await repository.list()).map((e) => e.name)).toEqual([
        "C",
        "A",
        "B",
      ]);
      expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    },
  );

  // #425-T01
  it_(
    "updates fields in place: the id stays and the times and the author move",
    async () => {
      const { repository, advance, db } = await start();
      const created = await repository.insert(entry(), null);
      await insertUser(db, { id: "user-1" });
      advance(5000);

      const updated = await repository.update(
        created.id,
        {
          name: "Quick",
          nameKey: "quick",
          description: null,
          kinds: ["dynamic"],
          sortOrder: 4,
        },
        "user-1",
      );

      expect(updated).toEqual({
        ...created,
        name: "Quick",
        description: null,
        kinds: ["dynamic"],
        sortOrder: 4,
        updatedAt: "2026-10-17T10:00:05.000Z",
        updatedBy: "user-1",
      });
      expect(
        await repository.update("mce_missing", { sortOrder: 1 }, null),
      ).toBeUndefined();
    },
  );

  // #425-T02
  it_(
    "refuses a second name that differs only in case, on insert and on rename",
    async () => {
      const { repository } = await start();
      await repository.insert(entry({ name: "Deep", nameKey: "deep" }), null);
      const other = await repository.insert(
        entry({ name: "Other", nameKey: "other" }),
        null,
      );

      await expect(
        repository.insert(entry({ name: "DEEP", nameKey: "deep" }), null),
      ).rejects.toBeInstanceOf(CatalogNameTakenError);
      await expect(
        repository.update(other.id, { name: "deep", nameKey: "deep" }, null),
      ).rejects.toBeInstanceOf(CatalogNameTakenError);
      expect((await repository.list()).map((e) => e.name)).toEqual([
        "Deep",
        "Other",
      ]);
    },
  );

  // #425-T02
  it_("frees a name when a draft is deleted", async () => {
    const { repository } = await start();
    const draft = await repository.insert(entry(), null);

    expect(await repository.deleteDraft(draft.id)).toBe(true);

    await expect(repository.insert(entry(), null)).resolves.toMatchObject({
      name: "Fast",
    });
  });

  // #425-T03
  it_(
    "moves the status only from the status the caller saw, and only when nobody wrote in between",
    async () => {
      const { repository, advance } = await start();
      const created = await repository.insert(entry(), null);
      advance(1000);

      const released = await repository.setStatus(
        created.id,
        "draft",
        "released",
        null,
        created.updatedAt,
      );
      expect(released).toMatchObject({
        status: "released",
        updatedAt: "2026-10-17T10:00:01.000Z",
      });

      // From the wrong status, or with a stale read, nothing changes.
      expect(
        await repository.setStatus(created.id, "draft", "released", null),
      ).toBeUndefined();
      advance(1000);
      expect(
        await repository.setStatus(
          created.id,
          "released",
          "retired",
          null,
          created.updatedAt,
        ),
      ).toBeUndefined();
      expect((await repository.get(created.id))?.status).toBe("released");
    },
  );

  // #425-T03
  it_("deletes a draft and never any other entry", async () => {
    const { repository } = await start();
    const draft = await repository.insert(
      entry({ name: "D", nameKey: "d" }),
      null,
    );
    const kept = await repository.insert(
      entry({ name: "K", nameKey: "k" }),
      null,
    );
    await repository.setStatus(kept.id, "draft", "released", null);

    expect(await repository.deleteDraft(draft.id)).toBe(true);
    expect(await repository.deleteDraft(draft.id)).toBe(false);
    expect(await repository.deleteDraft(kept.id)).toBe(false);
    await repository.setStatus(kept.id, "released", "retired", null);
    expect(await repository.deleteDraft(kept.id)).toBe(false);
    expect((await repository.list()).map((e) => e.id)).toEqual([kept.id]);
  });

  // #425-T07
  it_(
    "lists to a member only released and retired entries, with nothing about the model",
    async () => {
      const { repository } = await start();
      const draft = await repository.insert(
        entry({ name: "D", nameKey: "d", modelId: "sentinel/draft-model" }),
        null,
      );
      const live = await repository.insert(
        entry({
          name: "L",
          nameKey: "l",
          modelId: "sentinel/live-model",
          kinds: ["diff", "dynamic"],
          sortOrder: 1,
        }),
        null,
      );
      const old = await repository.insert(
        entry({
          name: "O",
          nameKey: "o",
          modelId: "sentinel/old-model",
          sortOrder: 2,
        }),
        null,
      );
      await repository.setStatus(live.id, "draft", "released", null);
      await repository.setStatus(old.id, "draft", "released", null);
      await repository.setStatus(old.id, "released", "retired", null);

      const listed = await repository.listMemberEntries();

      expect(listed.map((e) => [e.id, e.status])).toEqual([
        [live.id, "released"],
        [old.id, "retired"],
      ]);
      expect(listed.map((e) => e.id)).not.toContain(draft.id);
      for (const item of listed)
        expect(Object.keys(item).sort()).toEqual([
          "description",
          "id",
          "kinds",
          "name",
          "providerLabel",
          "sortOrder",
          "status",
        ]);
      expect(listed.map((e) => e.providerLabel)).toEqual([
        "Sentinel",
        "Sentinel",
      ]);
      expect(JSON.stringify(listed)).not.toMatch(
        /sentinel\/|openrouter|old-model/,
      );
    },
  );

  // #425-T01
  it_("lists every distinct model id of every status for masking", async () => {
    const { repository } = await start();
    const a = await repository.insert(
      entry({ name: "A", nameKey: "a", modelId: "x/one" }),
      null,
    );
    await repository.insert(
      entry({ name: "B", nameKey: "b", modelId: "x/one" }),
      null,
    );
    const c = await repository.insert(
      entry({ name: "C", nameKey: "c", modelId: "x/two" }),
      null,
    );
    await repository.setStatus(a.id, "draft", "released", null);
    await repository.setStatus(c.id, "draft", "released", null);
    await repository.setStatus(c.id, "released", "retired", null);

    expect((await repository.allModelIds()).sort()).toEqual(["x/one", "x/two"]);
  });

  // #425-T09
  it_(
    "counts the projects that select an entry, in either kind, across workspaces, and nothing else",
    async () => {
      const database = await engine.open();
      const fixture = await createJobQueueFixture({ database });
      const repository = createCatalogRepository(database, () => T0);
      const created = await repository.insert(
        entry({ kinds: ["diff", "dynamic"] }),
        null,
      );
      const other = await repository.insert(
        entry({ name: "Other", nameKey: "other" }),
        null,
      );
      const put = (
        id: string,
        repositoryId: string,
        settings: unknown,
        active = 1,
      ) =>
        database
          .insertInto("projects")
          .values({
            id,
            repository_id: repositoryId,
            active,
            settings: JSON.stringify(settings),
            created_at: T0.toISOString(),
            updated_at: T0.toISOString(),
          })
          .execute();

      const none = { diff: null, dynamic: null };
      const countOf = async (id: string) =>
        (await repository.countProjectsUsing(none)).get(id) ?? 0;

      expect(await countOf(created.id)).toBe(0);
      await put("p1", fixture.repositoryId, { catalogEntryDiff: created.id });
      await put("p2", fixture.otherRepositoryId, {
        catalogEntryDynamic: created.id,
        model: "x/y",
      });

      expect(await countOf(created.id)).toBe(2);
      expect(await countOf(other.id)).toBe(0);
      // An id that merely appears somewhere in the settings is not a selection.
      await database
        .updateTable("projects")
        .set({ settings: JSON.stringify({ note: created.id }) })
        .where("id", "=", "p2")
        .execute();
      expect(await countOf(created.id)).toBe(1);
    },
  );

  // #429-T02
  it_(
    "counts a project that falls back to an instance default only in a workspace on the operator's key, once, next to the explicit selections",
    async () => {
      const database = await engine.open();
      const fixture = await createJobQueueFixture({ database });
      const workspaceId = await defaultWorkspaceId(database);
      const repository = createCatalogRepository(database, () => T0);
      const diffDefault = await repository.insert(
        entry({ kinds: ["diff", "dynamic"] }),
        null,
      );
      const dynamicDefault = await repository.insert(
        entry({ name: "Deep", nameKey: "deep", kinds: ["dynamic"] }),
        null,
      );
      const defaults: CatalogDefaults = {
        diff: diffDefault.id,
        dynamic: dynamicDefault.id,
      };
      const none: CatalogDefaults = { diff: null, dynamic: null };
      const put = (id: string, repositoryId: string, settings: unknown) =>
        database
          .insertInto("projects")
          .values({
            id,
            repository_id: repositoryId,
            active: 1,
            settings: JSON.stringify(settings),
            created_at: T0.toISOString(),
            updated_at: T0.toISOString(),
          })
          .execute();
      const used = async (given = defaults) => {
        const counts = await repository.countProjectsUsing(given);
        return [
          counts.get(diffDefault.id) ?? 0,
          counts.get(dynamicDefault.id) ?? 0,
        ];
      };
      const entitle = (keyMode: "own" | "managed") => {
        const data: EntitlementsData = {
          planLabel: "Team",
          keyMode,
          limits: {
            diffRunsPerPeriod: null,
            dynamicRunsPerPeriod: null,
            managedCostLimitMicroUsd: null,
            ownKeyCostLimitMicroUsd: null,
          },
          periodStart: "2026-10-01T00:00:00.000Z",
          suspended: false,
          suspensionCode: null,
        };
        return createWorkspaceEntitlementsRepository(database, workspaceId).put(
          data,
          null,
        );
      };
      // p1 runs Diff and p2 runs Dynamic, neither has chosen an entry.
      await put("p1", fixture.repositoryId, {});
      await put("p2", fixture.otherRepositoryId, { reviewKind: "dynamic" });

      // No entitlements at all: the workspace reviews on its own key, the catalog is not in play.
      expect(await used()).toEqual([0, 0]);
      await entitle("own");
      expect(await used()).toEqual([0, 0]);

      await entitle("managed");
      expect(await used()).toEqual([1, 1]);
      // With no default of a kind there is nothing to fall back to.
      expect(await used({ diff: null, dynamic: dynamicDefault.id })).toEqual([
        0, 1,
      ]);
      expect(await used(none)).toEqual([0, 0]);

      // A choice of the project replaces the fallback of its kind; a choice for the other kind does not.
      await database
        .updateTable("projects")
        .set({
          settings: JSON.stringify({ catalogEntryDiff: dynamicDefault.id }),
        })
        .where("id", "=", "p1")
        .execute();
      expect(await used()).toEqual([0, 2]);
      await database
        .updateTable("projects")
        .set({
          settings: JSON.stringify({ catalogEntryDynamic: dynamicDefault.id }),
        })
        .where("id", "=", "p1")
        .execute();
      expect(await used()).toEqual([1, 2]);

      // A project that chose the default itself is counted once, not twice.
      await database
        .updateTable("projects")
        .set({ settings: JSON.stringify({ catalogEntryDiff: diffDefault.id }) })
        .where("id", "=", "p1")
        .execute();
      expect(await used()).toEqual([1, 1]);
    },
  );

  // #429-T02
  it_(
    "treats a workspace without a row of its own as managed when the default of the instance is managed",
    async () => {
      const database = await engine.open();
      const fixture = await createJobQueueFixture({ database });
      const repository = createCatalogRepository(database, () => T0);
      const created = await repository.insert(entry(), null);
      await database
        .insertInto("projects")
        .values({
          id: "p1",
          repository_id: fixture.repositoryId,
          active: 1,
          settings: "{}",
          created_at: T0.toISOString(),
          updated_at: T0.toISOString(),
        })
        .execute();
      const defaults = { diff: created.id, dynamic: null };
      const settings = createInstanceSettingsRepository(database);
      const entitlements = (keyMode: "own" | "managed"): EntitlementsData => ({
        planLabel: "Free",
        keyMode,
        limits: {
          diffRunsPerPeriod: 10,
          dynamicRunsPerPeriod: 0,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
        periodStart: "2026-10-01T00:00:00.000Z",
        suspended: false,
        suspensionCode: null,
      });

      await settings.set("default_entitlements", entitlements("own"), null);
      expect(
        (await repository.countProjectsUsing(defaults)).get(created.id) ?? 0,
      ).toBe(0);
      await settings.set("default_entitlements", entitlements("managed"), null);
      expect(
        (await repository.countProjectsUsing(defaults)).get(created.id) ?? 0,
      ).toBe(1);
    },
  );

  // #429-T02
  it_(
    "puts every entry at its place in the given order in one go, and changes nothing when the list is not exactly the entries",
    async () => {
      const { db, repository } = await start();
      await insertUser(db, { id: "user-1" });
      const a = await repository.insert(
        entry({ name: "A", nameKey: "a", sortOrder: 0 }),
        null,
      );
      const b = await repository.insert(
        entry({ name: "B", nameKey: "b", sortOrder: 1 }),
        null,
      );
      const c = await repository.insert(
        entry({ name: "C", nameKey: "c", sortOrder: 2 }),
        null,
      );

      expect(await repository.reorder([c.id, a.id, b.id], "user-1")).toBe(true);

      const listed = await repository.list();
      expect(listed.map((item) => [item.id, item.sortOrder])).toEqual([
        [c.id, 0],
        [a.id, 1],
        [b.id, 2],
      ]);
      // Only the entries that changed place were written.
      expect(listed.find((item) => item.id === c.id)?.updatedBy).toBe("user-1");
      // A missing entry, an unknown one and a repeated one are refused, and nothing is written.
      for (const given of [
        [a.id, b.id],
        [a.id, b.id, c.id, "mce_nothing"],
        [a.id, a.id, b.id],
        [a.id, b.id, "mce_nothing"],
      ])
        expect(await repository.reorder(given, null)).toBe(false);
      expect(
        (await repository.list()).map((item) => [item.id, item.sortOrder]),
      ).toEqual([
        [c.id, 0],
        [a.id, 1],
        [b.id, 2],
      ]);
    },
  );

  // #425-T12
  it_("is refused by the database when an entry serves no kind", async () => {
    const { db, repository } = await start();

    await expect(
      repository.insert(entry({ kinds: [] }), null),
    ).rejects.toThrow();
    await expect(
      sql`insert into model_catalog_entries
        (id, name, name_key, provider, model_id, serves_diff, serves_dynamic, status, sort_order, created_at, updated_at)
        values ('mce_raw', 'Raw', 'raw', 'openrouter', 'a/b', 0, 0, 'draft', 0, 'x', 'x')`.execute(
        db,
      ),
    ).rejects.toThrow();
    const created = await repository.insert(entry(), null);
    await expect(
      sql`update model_catalog_entries set serves_diff = 0 where id = ${created.id}`.execute(
        db,
      ),
    ).rejects.toThrow();
    expect(await repository.list()).toHaveLength(1);
  });

  // #425-T12
  it_(
    "is refused by the database when the status is not one of the three",
    async () => {
      const { db, repository } = await start();
      const created = await repository.insert(entry(), null);

      await expect(
        sql`update model_catalog_entries set status = 'lost' where id = ${created.id}`.execute(
          db,
        ),
      ).rejects.toThrow();
    },
  );
});
