// SPDX-License-Identifier: Apache-2.0

// The repository of the billing plans (#438) on a real SQLite file and, when TEST_DATABASE_URL is set, on a real
// Postgres: the same code, the same answers.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { PlanMetadata } from "../../admin/ui/plans-view.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { insertUser } from "../../test-support/users.ts";
import type { Database } from "../schema.ts";
import {
  PlanChangedError,
  PlanKeyTakenError,
  createBillingPlansRepository,
} from "./billing-plans-repository.ts";

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

const T0 = new Date("2026-10-18T10:00:00.000Z");

function metadata(overrides: Partial<PlanMetadata> = {}): PlanMetadata {
  return {
    name: "Team",
    description: "For small teams.",
    sort: 20,
    offered: true,
    popular: false,
    contactTarget: null,
    ...overrides,
  };
}

describe.each(ENGINES)("the billing plans repository on $name", (engine) => {
  const it_ = engine.skip ? it.skip : it;

  async function start() {
    const db = await engine.open();
    let now = T0;
    let counter = 0;
    const repository = createBillingPlansRepository(
      db,
      () => now,
      () => `bpl_${++counter}`,
    );
    return {
      db,
      repository,
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
    };
  }

  // #438-T03
  it_(
    "stores a plan with its display fields and reads it back whole",
    async () => {
      const { db, repository } = await start();
      const user = await insertUser(db, { id: "admin-1" });

      const plan = await repository.insert(
        {
          planKey: "team",
          kind: "paid",
          metadata: metadata({ popular: true }),
        },
        user,
      );

      expect(plan).toEqual({
        id: "bpl_1",
        planKey: "team",
        kind: "paid",
        ...metadata({ popular: true }),
        archivedAt: null,
        createdAt: T0.toISOString(),
        updatedAt: T0.toISOString(),
      });
      expect(await repository.get("team")).toEqual(plan);
      expect(await repository.get("nope")).toBeUndefined();
    },
  );

  // #438-T26
  it_(
    "lists the plans ascending by sort, ties by plan key, across every kind",
    async () => {
      const { repository } = await start();
      await repository.insert(
        {
          planKey: "enterprise",
          kind: "contact",
          metadata: metadata({
            name: "Enterprise",
            sort: 30,
            contactTarget: "mailto:sales@example.test",
          }),
        },
        null,
      );
      await repository.insert(
        {
          planKey: "free",
          kind: "free",
          metadata: metadata({ name: "Free", sort: 10 }),
        },
        null,
      );
      await repository.insert(
        {
          planKey: "pro",
          kind: "paid",
          metadata: metadata({ name: "Pro", sort: 20 }),
        },
        null,
      );
      await repository.insert(
        {
          planKey: "alpha",
          kind: "paid",
          metadata: metadata({ name: "Alpha", sort: 20 }),
        },
        null,
      );

      expect((await repository.list()).map((plan) => plan.planKey)).toEqual([
        "free",
        "alpha",
        "pro",
        "enterprise",
      ]);
    },
  );

  // #438-T03
  it_("refuses a second plan with the same key", async () => {
    const { repository } = await start();
    await repository.insert(
      { planKey: "team", kind: "paid", metadata: metadata() },
      null,
    );

    await expect(
      repository.insert(
        {
          planKey: "team",
          kind: "paid",
          metadata: metadata({ name: "Other" }),
        },
        null,
      ),
    ).rejects.toBeInstanceOf(PlanKeyTakenError);
  });

  // #438-T03
  it_(
    "edits the display fields in place and records who and when",
    async () => {
      const { db, repository, advance } = await start();
      const user = await insertUser(db, { id: "admin-2" });
      const created = await repository.insert(
        { planKey: "team", kind: "paid", metadata: metadata() },
        null,
      );
      advance(60_000);

      const changed = await repository.update(
        "team",
        metadata({ name: "Teams", description: "", sort: 5, offered: false }),
        user,
        created.updatedAt,
      );

      expect(changed?.plan).toMatchObject({
        id: created.id,
        name: "Teams",
        description: "",
        sort: 5,
        offered: false,
        updatedAt: new Date(T0.getTime() + 60_000).toISOString(),
      });
      expect(changed?.clearedPopular).toBeNull();
    },
  );

  // #438-T03
  it_("writes nothing when the plan changed since it was read", async () => {
    const { repository, advance } = await start();
    const created = await repository.insert(
      { planKey: "team", kind: "paid", metadata: metadata() },
      null,
    );
    advance(1_000);
    await repository.update(
      "team",
      metadata({ sort: 1 }),
      null,
      created.updatedAt,
    );

    const stale = await repository.update(
      "team",
      metadata({ sort: 99 }),
      null,
      created.updatedAt,
    );

    expect(stale).toBeUndefined();
    expect((await repository.get("team"))?.sort).toBe(1);
  });

  // #438-T27
  it_("moves the Popular flag in one transaction", async () => {
    const { repository, advance } = await start();
    const a = await repository.insert(
      {
        planKey: "a",
        kind: "paid",
        metadata: metadata({ name: "A", popular: true }),
      },
      null,
    );
    const b = await repository.insert(
      {
        planKey: "b",
        kind: "paid",
        metadata: metadata({ name: "B", sort: 21 }),
      },
      null,
    );
    advance(1_000);

    const moved = await repository.update(
      "b",
      metadata({ name: "B", sort: 21, popular: true }),
      null,
      b.updatedAt,
    );

    expect(moved?.clearedPopular).toBe("a");
    const plans = await repository.list();
    expect(plans.filter((plan) => plan.popular).map((p) => p.planKey)).toEqual([
      "b",
    ]);
    expect((await repository.get("a"))?.updatedAt).not.toBe(a.updatedAt);
  });

  // #438-T27
  it_(
    "leaves the old Popular plan alone when the update is stale",
    async () => {
      const { repository, advance } = await start();
      await repository.insert(
        {
          planKey: "a",
          kind: "paid",
          metadata: metadata({ name: "A", popular: true }),
        },
        null,
      );
      const b = await repository.insert(
        {
          planKey: "b",
          kind: "paid",
          metadata: metadata({ name: "B", sort: 21 }),
        },
        null,
      );
      advance(1_000);
      await repository.update(
        "b",
        metadata({ name: "B", sort: 3 }),
        null,
        b.updatedAt,
      );

      const stale = await repository.update(
        "b",
        metadata({ name: "B", sort: 21, popular: true }),
        null,
        b.updatedAt,
      );

      expect(stale).toBeUndefined();
      expect((await repository.get("a"))?.popular).toBe(true);
      expect((await repository.get("b"))?.popular).toBe(false);
    },
  );

  // #438-T28
  it_("makes the database refuse a second Popular plan", async () => {
    const { db, repository } = await start();
    await repository.insert(
      {
        planKey: "a",
        kind: "paid",
        metadata: metadata({ name: "A", popular: true }),
      },
      null,
    );
    await repository.insert(
      { planKey: "b", kind: "paid", metadata: metadata({ name: "B" }) },
      null,
    );

    await expect(
      db
        .updateTable("billing_plans")
        .set({ popular: 1 })
        .where("plan_key", "=", "b")
        .execute(),
    ).rejects.toThrow();
    await expect(
      repository.insert(
        {
          planKey: "c",
          kind: "paid",
          metadata: metadata({ name: "C", popular: true }),
        },
        null,
      ),
    ).rejects.toBeInstanceOf(PlanChangedError);
  });

  // #438-T28
  it_(
    "lets the database refuse Popular on a plan that is not paid, a second Free plan and a target outside a contact plan",
    async () => {
      const { db, repository } = await start();
      await repository.insert(
        { planKey: "free", kind: "free", metadata: metadata({ name: "Free" }) },
        null,
      );

      await expect(
        db
          .updateTable("billing_plans")
          .set({ popular: 1 })
          .where("plan_key", "=", "free")
          .execute(),
      ).rejects.toThrow();
      await expect(
        db
          .updateTable("billing_plans")
          .set({ contact_target: "https://example.test" })
          .where("plan_key", "=", "free")
          .execute(),
      ).rejects.toThrow();
      await expect(
        repository.insert(
          {
            planKey: "free-two",
            kind: "free",
            metadata: metadata({ name: "Free two" }),
          },
          null,
        ),
      ).rejects.toBeInstanceOf(PlanChangedError);
    },
  );

  // #438-T08
  it_(
    "deletes a plan without versions and keeps one that has them",
    async () => {
      const { db, repository } = await start();
      const enterprise = await repository.insert(
        {
          planKey: "enterprise",
          kind: "contact",
          metadata: metadata({
            name: "Enterprise",
            contactTarget: "mailto:sales@example.test",
          }),
        },
        null,
      );
      const team = await repository.insert(
        { planKey: "team", kind: "paid", metadata: metadata() },
        null,
      );
      await db
        .insertInto("billing_plan_versions")
        .values({
          id: "v-1",
          plan_id: team.id,
          number: 1,
          role: "current",
          key_mode: "managed",
          limits: "{}",
          model_access: null,
          monthly_amount_minor: 100,
          yearly_amount_minor: null,
          created_at: T0.toISOString(),
          created_by: null,
        })
        .execute();

      expect(await repository.remove("enterprise")).toBe(true);
      expect(await repository.remove("team")).toBe(false);
      expect(await repository.remove("missing")).toBe(false);
      expect(await repository.get("enterprise")).toBeUndefined();
      expect((await repository.get("team"))?.id).toBe(team.id);
      expect(enterprise.id).not.toBe(team.id);
    },
  );

  // #438-T03
  it_(
    "archives a plan: it is no longer offered or popular, and can be restored",
    async () => {
      const { repository, advance } = await start();
      await repository.insert(
        {
          planKey: "team",
          kind: "paid",
          metadata: metadata({ popular: true }),
        },
        null,
      );
      advance(5_000);

      const archived = await repository.setArchived("team", true, null);
      expect(archived).toMatchObject({
        offered: false,
        popular: false,
        archivedAt: new Date(T0.getTime() + 5_000).toISOString(),
      });

      const restored = await repository.setArchived("team", false, null);
      expect(restored).toMatchObject({ offered: false, archivedAt: null });
      expect(
        await repository.setArchived("missing", true, null),
      ).toBeUndefined();
    },
  );

  it_("stores its flags as 0 or 1", async () => {
    const { db, repository } = await start();
    await repository.insert(
      { planKey: "team", kind: "paid", metadata: metadata() },
      null,
    );

    const { rows } = await sql<{ offered: number; popular: number }>`
      select offered, popular from billing_plans`.execute(db);

    expect(rows).toEqual([{ offered: 1, popular: 0 }]);
  });
});
