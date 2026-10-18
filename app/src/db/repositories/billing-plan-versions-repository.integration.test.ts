// SPDX-License-Identifier: Apache-2.0

// The repository of the billing plan versions (#438) on a real SQLite file and, when TEST_DATABASE_URL is set, on a
// real Postgres. A version is immutable after creation but for its role and its two price links.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { PlanTerms } from "../../admin/ui/plans-view.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import type { Database } from "../schema.ts";
import {
  PlanChangedError,
  createBillingPlansRepository,
} from "./billing-plans-repository.ts";
import { createBillingPlanPricesRepository } from "./billing-plan-prices-repository.ts";
import {
  PriceLinkNotClearableError,
  createBillingPlanVersionsRepository,
} from "./billing-plan-versions-repository.ts";

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

function aPrice(db: Kysely<Database>, planId: string, paddlePriceId: string) {
  return createBillingPlanPricesRepository(db, () => T0).insertLinked({
    planId,
    paddlePriceId,
    env: "sandbox",
    snapshot: {
      productId: "pro_1",
      interval: "month",
      frequency: 1,
      currency: "USD",
      amount: "1234",
      taxMode: "internal",
      hasOverrides: false,
      trialDays: null,
      quantityMinimum: 1,
      quantityMaximum: 100,
      status: "active",
    },
  });
}

// Made-up numbers: no amount or limit of a real plan lives in the repository.
function managed(overrides: Partial<PlanTerms> = {}): PlanTerms {
  return {
    keyMode: "managed",
    limits: {
      diffRunsPerPeriod: 40,
      dynamicRunsPerPeriod: 8,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
    },
    modelAccess: { catalogEntries: ["mce_one"] },
    monthlyAmountMinor: 1234,
    yearlyAmountMinor: 12_340,
    ...overrides,
  };
}

describe.each(ENGINES)(
  "the billing plan versions repository on $name",
  (engine) => {
    const it_ = engine.skip ? it.skip : it;

    async function start() {
      const db = await engine.open();
      let now = T0;
      let counter = 0;
      const plans = createBillingPlansRepository(
        db,
        () => now,
        () => `bpl_${++counter}`,
      );
      const versions = createBillingPlanVersionsRepository(
        db,
        () => now,
        () => `bpv_${++counter}`,
      );
      const plan = await plans.insert(
        {
          planKey: "team",
          kind: "paid",
          metadata: {
            name: "Team",
            description: "",
            sort: 1,
            offered: true,
            popular: false,
            contactTarget: null,
          },
        },
        null,
      );
      return {
        db,
        plan,
        versions,
        advance: (ms: number) => {
          now = new Date(now.getTime() + ms);
        },
      };
    }

    // #438-T01
    it_("creates version 1 as the current one", async () => {
      const { plan, versions } = await start();

      const first = await versions.createNext(plan.id, managed(), null, 0);

      expect(first).toMatchObject({
        planId: plan.id,
        number: 1,
        role: "current",
        createdAt: T0.toISOString(),
        createdBy: null,
        ...managed(),
      });
      expect(await versions.current(plan.id)).toEqual(first);
    });

    // #438-T02
    it_("makes version 2 current, version 1 legacy and unchanged", async () => {
      const { plan, versions, advance } = await start();
      const first = await versions.createNext(plan.id, managed(), null, 0);
      advance(60_000);

      const second = await versions.createNext(
        plan.id,
        managed({
          limits: { ...managed().limits, diffRunsPerPeriod: 90 },
        }),
        null,
        1,
      );

      expect(second).toMatchObject({ number: 2, role: "current" });
      expect(second.limits.diffRunsPerPeriod).toBe(90);
      const all = await versions.list(plan.id);
      expect(all.map((version) => [version.number, version.role])).toEqual([
        [2, "current"],
        [1, "legacy"],
      ]);
      expect(all[1]).toEqual({ ...first, role: "legacy" });
    });

    // #438-T12
    it_(
      "changes nothing but the role of a version that is replaced",
      async () => {
        const { db, plan, versions } = await start();
        await versions.createNext(plan.id, managed(), null, 0);
        const columns = async () =>
          (
            await sql<Record<string, unknown>>`
            select * from billing_plan_versions where number = 1`.execute(db)
          ).rows[0];
        const before = await columns();

        await versions.createNext(
          plan.id,
          managed({ monthlyAmountMinor: 999 }),
          null,
          1,
        );

        expect({ ...(await columns()), role: "current" }).toEqual(before);
      },
    );

    // #439-T05 (review of #468, B1): the link is written to the current version only, whatever the caller read before.
    it_(
      "does not link a version that a newer version replaced, and keeps the links of that legacy version",
      async () => {
        const { db, plan, versions } = await start();
        const price = await aPrice(db, plan.id, "pri_m");
        const first = await versions.createNext(plan.id, managed(), null, 0);
        await versions.createNext(
          plan.id,
          managed({ monthlyAmountMinor: 5 }),
          null,
          1,
        );

        const result = await versions.setPriceLink(
          first.id,
          "month",
          price.id,
          null,
        );

        expect(result).toEqual({ ok: false, reason: "not_current" });
        const [second, legacy] = await versions.list(plan.id);
        expect(legacy).toMatchObject({ role: "legacy", monthlyPriceId: null });
        expect(second).toMatchObject({ role: "current", monthlyPriceId: null });
      },
    );

    // #439-T16 (review of #468, N1): relinking is allowed, but only from the link the caller saw.
    it_(
      "relinks a slot only from the link the caller read: a second writer that read the old link is refused",
      async () => {
        const { db, plan, versions } = await start();
        const version = await versions.createNext(plan.id, managed(), null, 0);
        const a = await aPrice(db, plan.id, "pri_a");
        const b = await aPrice(db, plan.id, "pri_b");
        const c = await aPrice(db, plan.id, "pri_c");

        expect(
          await versions.setPriceLink(version.id, "month", a.id, null),
        ).toEqual({
          ok: true,
        });
        expect(
          await versions.setPriceLink(version.id, "month", b.id, a.id),
        ).toEqual({
          ok: true,
        });
        // Both read `a`: the second one finds `b` and writes nothing.
        expect(
          await versions.setPriceLink(version.id, "month", c.id, a.id),
        ).toEqual({
          ok: false,
          reason: "link_changed",
        });
        // A first link over a link somebody set meanwhile is a conflict as well.
        expect(
          await versions.setPriceLink(version.id, "month", c.id, null),
        ).toEqual({
          ok: false,
          reason: "link_changed",
        });

        expect(await versions.current(plan.id)).toMatchObject({
          monthlyPriceId: b.id,
          yearlyPriceId: null,
        });
      },
    );

    // #439-T16 (review of #468, N1)
    it_("treats a link that is the one asked for already as done", async () => {
      const { db, plan, versions } = await start();
      const version = await versions.createNext(plan.id, managed(), null, 0);
      const a = await aPrice(db, plan.id, "pri_a");
      await versions.setPriceLink(version.id, "month", a.id, null);

      expect(
        await versions.setPriceLink(version.id, "month", a.id, null),
      ).toEqual({
        ok: true,
      });
      expect(
        await versions.setPriceLink(version.id, "month", a.id, a.id),
      ).toEqual({
        ok: true,
      });
    });

    // #439-T16 (review of #468, N1): a link, once set, is never cleared; the repository has no way to and says so.
    it_("never clears a link, with a stable code", async () => {
      const { db, plan, versions } = await start();
      const version = await versions.createNext(plan.id, managed(), null, 0);
      const a = await aPrice(db, plan.id, "pri_a");
      await versions.setPriceLink(version.id, "month", a.id, null);

      const attempt = versions.setPriceLink(
        version.id,
        "month",
        null as never,
        a.id,
      );

      await expect(attempt).rejects.toBeInstanceOf(PriceLinkNotClearableError);
      await expect(attempt).rejects.toMatchObject({
        code: "price_link_not_clearable",
      });
      expect(await versions.current(plan.id)).toMatchObject({
        monthlyPriceId: a.id,
      });
    });

    // #438-T12
    it_("offers no way to update a version", async () => {
      const { versions } = await start();

      expect(Object.keys(versions).sort()).toEqual([
        "createNext",
        "current",
        "list",
        "listForPlans",
        "setPriceLink",
      ]);
    });

    // The database refuses what the repository merely does not offer (#438, review N6): whoever writes, an app instance
    // of another release or somebody with SQL, a version is never changed beyond `role` and never deleted. `created_by`
    // moves too: the account merge and the deletion of a user rewrite who made a version. And so do the two price links
    // (#439): linking a Paddle price to a slot is the one thing that happens to a version after it was saved.
    const IMMUTABLE_MESSAGE = /billing_plan_versions_immutable/;

    // #438-T12
    it_(
      "refuses an update of any column of a version but its role and its author, whichever column the table has",
      async () => {
        const { db, plan, versions } = await start();
        const version = await versions.createNext(plan.id, managed(), null, 0);
        const columns = (await db.introspection.getTables())
          .find((table) => table.name === "billing_plan_versions")
          ?.columns.map((column) => column.name);
        // The mutable ones are named here, so a column that is added later is checked without anybody remembering to.
        const mutable = [
          "role",
          "created_by",
          "monthly_price_id",
          "yearly_price_id",
        ];
        const frozen = (columns ?? []).filter(
          (column) => !mutable.includes(column),
        );
        expect(
          columns?.filter((column) => mutable.includes(column)).sort(),
        ).toEqual([...mutable].sort());
        expect(frozen.sort()).toEqual([
          "created_at",
          "id",
          "key_mode",
          "limits",
          "model_access",
          "monthly_amount_minor",
          "number",
          "plan_id",
          "yearly_amount_minor",
        ]);
        const before = (
          await sql<Record<string, unknown>>`
            select * from billing_plan_versions where id = ${version.id}`.execute(
            db,
          )
        ).rows[0];

        for (const column of frozen) {
          const value =
            column === "number" ||
            column === "monthly_amount_minor" ||
            column === "yearly_amount_minor"
              ? 77
              : "changed";
          await expect(
            sql`update billing_plan_versions set ${sql.ref(column)} = ${value} where id = ${version.id}`.execute(
              db,
            ),
            column,
          ).rejects.toThrow(IMMUTABLE_MESSAGE);
        }

        expect(
          (
            await sql<Record<string, unknown>>`
              select * from billing_plan_versions where id = ${version.id}`.execute(
              db,
            )
          ).rows[0],
        ).toEqual(before);
      },
    );

    // #438-T12
    it_(
      "refuses an update that sets several columns when one of them is not the role",
      async () => {
        const { db, plan, versions } = await start();
        const version = await versions.createNext(plan.id, managed(), null, 0);

        await expect(
          sql`update billing_plan_versions set role = 'legacy', monthly_amount_minor = 1 where id = ${version.id}`.execute(
            db,
          ),
        ).rejects.toThrow(IMMUTABLE_MESSAGE);

        expect((await versions.current(plan.id))?.monthlyAmountMinor).toBe(
          1234,
        );
      },
    );

    // #439 (review of #462, N6: the every-column test is extended with the two columns this issue adds)
    it_(
      "lets the two price links of a version be set and changed, never cleared, and refuses to set one together with a frozen column",
      async () => {
        const { db, plan, versions } = await start();
        const version = await versions.createNext(plan.id, managed(), null, 0);
        await aPrice(db, plan.id, "pri_1");
        const rows = await sql<{
          id: string;
        }>`select id from billing_plan_prices`.execute(db);
        const priceId = rows.rows[0]?.id ?? "";

        await sql`update billing_plan_versions set monthly_price_id = ${priceId}, yearly_price_id = ${priceId} where id = ${version.id}`.execute(
          db,
        );
        // Review of #468, N1: value to null is refused for either slot, whoever writes; relinking stays possible.
        for (const slot of ["monthly_price_id", "yearly_price_id"])
          await expect(
            sql`update billing_plan_versions set ${sql.ref(slot)} = null where id = ${version.id}`.execute(
              db,
            ),
            slot,
          ).rejects.toThrow(/billing_plan_versions_immutable/);
        await expect(
          sql`update billing_plan_versions set yearly_price_id = ${priceId}, yearly_amount_minor = 5 where id = ${version.id}`.execute(
            db,
          ),
        ).rejects.toThrow(/billing_plan_versions_immutable/);

        const row = (
          await sql<{
            monthly_price_id: string | null;
            yearly_price_id: string | null;
            yearly_amount_minor: number;
          }>`select * from billing_plan_versions where id = ${version.id}`.execute(
            db,
          )
        ).rows[0];
        expect(row).toMatchObject({
          monthly_price_id: priceId,
          yearly_price_id: priceId,
          yearly_amount_minor: 12_340,
        });
      },
    );

    // #438-T12
    it_("refuses to delete a version", async () => {
      const { db, plan, versions } = await start();
      const version = await versions.createNext(plan.id, managed(), null, 0);

      await expect(
        sql`delete from billing_plan_versions where id = ${version.id}`.execute(
          db,
        ),
      ).rejects.toThrow(IMMUTABLE_MESSAGE);

      expect(await versions.list(plan.id)).toHaveLength(1);
    });

    // #438-T12
    it_(
      "still lets the role change, and the author be rewritten by the merge of two accounts or the deletion of a user",
      async () => {
        const { db, plan, versions } = await start();
        await db
          .insertInto("users")
          .values(
            ["author-1", "author-2"].map((id) => ({
              id,
              name: id,
              email: `${id}@example.test`,
              email_verified: 0,
              image: null,
              github_login: null,
              imported_at: null,
              is_instance_admin: 0,
              email_conflict: null,
              org_checked_at: null,
              org_checked_for: null,
              created_at: T0.toISOString(),
              updated_at: T0.toISOString(),
            })),
          )
          .execute();
        const version = await versions.createNext(
          plan.id,
          managed(),
          "author-1",
          0,
        );

        await sql`update billing_plan_versions set created_by = 'author-2' where id = ${version.id}`.execute(
          db,
        );
        await sql`delete from users where id = 'author-2'`.execute(db);
        await versions.createNext(
          plan.id,
          managed({ monthlyAmountMinor: 5 }),
          null,
          1,
        );

        const all = await versions.list(plan.id);
        expect(all.map((row) => [row.number, row.role, row.createdBy])).toEqual(
          [
            [2, "current", null],
            [1, "legacy", null],
          ],
        );
      },
    );

    // #438-T02
    it_(
      "refuses a version based on a number that is no longer current",
      async () => {
        const { plan, versions } = await start();
        await versions.createNext(plan.id, managed(), null, 0);
        await versions.createNext(
          plan.id,
          managed({ monthlyAmountMinor: 999 }),
          null,
          1,
        );

        await expect(
          versions.createNext(
            plan.id,
            managed({ monthlyAmountMinor: 500 }),
            null,
            1,
          ),
        ).rejects.toBeInstanceOf(PlanChangedError);
        await expect(
          versions.createNext(plan.id, managed(), null, 0),
        ).rejects.toBeInstanceOf(PlanChangedError);
        expect((await versions.list(plan.id)).map((v) => v.number)).toEqual([
          2, 1,
        ]);
      },
    );

    // #438-T02
    it_("lets one of two writers that read the same version win", async () => {
      const { plan, versions } = await start();
      await versions.createNext(plan.id, managed(), null, 0);

      const results = await Promise.allSettled([
        versions.createNext(
          plan.id,
          managed({ monthlyAmountMinor: 1 }),
          null,
          1,
        ),
        versions.createNext(
          plan.id,
          managed({ monthlyAmountMinor: 2 }),
          null,
          1,
        ),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const all = await versions.list(plan.id);
      expect(all.filter((version) => version.role === "current")).toHaveLength(
        1,
      );
      expect(all.map((version) => version.number)).toEqual([2, 1]);
    });

    // #438-T14
    it_(
      "keeps an own version with no model access and unlimited runs",
      async () => {
        const { db, plan, versions } = await start();

        const own = await versions.createNext(
          plan.id,
          {
            keyMode: "own",
            limits: {
              diffRunsPerPeriod: null,
              dynamicRunsPerPeriod: null,
              managedCostLimitMicroUsd: null,
              ownKeyCostLimitMicroUsd: null,
            },
            modelAccess: null,
            monthlyAmountMinor: 1000,
            yearlyAmountMinor: null,
          },
          null,
          0,
        );

        expect(own.modelAccess).toBeNull();
        expect(own.limits.diffRunsPerPeriod).toBeNull();
        const { rows } = await sql<{ model_access: string | null }>`
        select model_access from billing_plan_versions`.execute(db);
        expect(rows).toEqual([{ model_access: null }]);
      },
    );

    // #438-T15
    it_(
      "keeps the limits and the own key cost limit as configured",
      async () => {
        const { plan, versions } = await start();

        const own = await versions.createNext(
          plan.id,
          {
            keyMode: "own",
            limits: {
              diffRunsPerPeriod: 75,
              dynamicRunsPerPeriod: 11,
              managedCostLimitMicroUsd: null,
              ownKeyCostLimitMicroUsd: 3_000_000,
            },
            modelAccess: null,
            monthlyAmountMinor: 1000,
            yearlyAmountMinor: null,
          },
          null,
          0,
        );

        expect(own.limits).toEqual({
          diffRunsPerPeriod: 75,
          dynamicRunsPerPeriod: 11,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: 3_000_000,
        });
      },
    );

    // #438-T21
    it_("stores both prices as integers in minor units", async () => {
      const { db, plan, versions } = await start();

      await versions.createNext(plan.id, managed(), null, 0);

      const { rows } = await sql<{ m: number; y: number }>`
        select monthly_amount_minor as m, yearly_amount_minor as y from billing_plan_versions`.execute(
        db,
      );
      expect(rows).toEqual([{ m: 1234, y: 12_340 }]);
    });

    // #438-T22
    it_("stores no yearly price as null", async () => {
      const { plan, versions } = await start();

      const first = await versions.createNext(
        plan.id,
        managed({ yearlyAmountMinor: null }),
        null,
        0,
      );

      expect(first.yearlyAmountMinor).toBeNull();
      expect(first.monthlyAmountMinor).toBe(1234);
    });

    // #438-T21
    it_("lets the table refuse what a price cannot be", async () => {
      const { db, plan } = await start();
      const row = {
        id: "bpv-x",
        plan_id: plan.id,
        number: 1,
        role: "current",
        key_mode: "managed",
        limits: "{}",
        model_access: null as string | null,
        monthly_amount_minor: 100 as number | null,
        yearly_amount_minor: null as number | null,
        created_at: T0.toISOString(),
        created_by: null,
      };
      const insert = (overrides: Partial<typeof row>) =>
        db
          .insertInto("billing_plan_versions")
          .values({ ...row, ...overrides })
          .execute();

      await expect(insert({ monthly_amount_minor: 0 })).rejects.toThrow();
      await expect(insert({ monthly_amount_minor: -1 })).rejects.toThrow();
      await expect(insert({ yearly_amount_minor: 0 })).rejects.toThrow();
      await expect(
        insert({ monthly_amount_minor: null, yearly_amount_minor: 100 }),
      ).rejects.toThrow();
      await expect(insert({ key_mode: "shared" })).rejects.toThrow();
      await expect(insert({ role: "old" })).rejects.toThrow();
      await expect(
        insert({ key_mode: "own", model_access: '{"catalogEntries":null}' }),
      ).rejects.toThrow();
    });

    // #438-T12
    it_(
      "lets the table hold one current version per plan and one number once",
      async () => {
        const { db, plan, versions } = await start();
        await versions.createNext(plan.id, managed(), null, 0);
        const row = {
          plan_id: plan.id,
          key_mode: "managed",
          limits: "{}",
          model_access: null,
          monthly_amount_minor: 100,
          yearly_amount_minor: null,
          created_at: T0.toISOString(),
          created_by: null,
        };

        await expect(
          db
            .insertInto("billing_plan_versions")
            .values({ ...row, id: "bpv-2", number: 2, role: "current" })
            .execute(),
        ).rejects.toThrow();
        await expect(
          db
            .insertInto("billing_plan_versions")
            .values({ ...row, id: "bpv-3", number: 1, role: "legacy" })
            .execute(),
        ).rejects.toThrow();
      },
    );

    it_(
      "lists the versions of several plans at once, newest first",
      async () => {
        const { db, plan, versions } = await start();
        const other = await createBillingPlansRepository(db).insert(
          {
            planKey: "other",
            kind: "paid",
            metadata: {
              name: "Other",
              description: "",
              sort: 2,
              offered: true,
              popular: false,
              contactTarget: null,
            },
          },
          null,
        );
        await versions.createNext(plan.id, managed(), null, 0);
        await versions.createNext(
          plan.id,
          managed({ monthlyAmountMinor: 5 }),
          null,
          1,
        );
        await versions.createNext(other.id, managed(), null, 0);

        const listed = await versions.listForPlans([plan.id, other.id]);

        expect(
          listed
            .filter((version) => version.planId === plan.id)
            .map((v) => v.number),
        ).toEqual([2, 1]);
        expect(
          listed
            .filter((version) => version.planId === other.id)
            .map((v) => v.number),
        ).toEqual([1]);
        expect(await versions.listForPlans([])).toEqual([]);
      },
    );
  },
);
