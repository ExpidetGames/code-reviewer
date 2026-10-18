// SPDX-License-Identifier: Apache-2.0

// What the plans page of the admin portal reads and changes (#438, ADR 0005, 2.11): the plans, their versions, the
// Free plan and the default entitlements it drives. A plan version is the sold unit: saving the price, the limits, the key
// mode or the model access creates the next version and turns the current one legacy, so a subscriber's terms never
// change implicitly. The display fields (name, description, sort, offered, Popular, the contact target) are edited in
// place. Every refusal is a stable code (`plan-errors.ts`) with the field it concerns; nothing here throws for a
// refusal. Billing off: this service is not reached (the routes answer the missing path, `enabled.ts`).
//
// The Free plan is seeded the first time billing is switched on (`enable`), and its current version is written to
// `default_entitlements` with the marker `source: billing` on enabling and on every new Free version, in the same
// transaction as the version. `release` (billing switched off again) removes a default that billing wrote.
import "server-only";
import type { Kysely } from "kysely";
import type {
  CatalogChoice,
  PlanMetadata,
  PlanTerms,
  PlanView,
  PlanVersionView,
  PlansView,
  PlanWarning,
} from "../admin/ui/plans-view.ts";
import { createCatalogRepository } from "../db/repositories/catalog-repository.ts";
import {
  PlanChangedError,
  PlanKeyTakenError,
  createBillingPlansRepository,
  type PlanRow,
} from "../db/repositories/billing-plans-repository.ts";
import {
  createBillingPlanVersionsRepository,
  type PlanVersionRow,
} from "../db/repositories/billing-plan-versions-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createOwnKeyCountRepository } from "../db/repositories/own-key-count-repository.ts";
import type { Database } from "../db/schema.ts";
import type { PlanRefusal } from "./plan-errors.ts";
import { planEntitlements } from "./plan-entitlements.ts";
import {
  validateNewPlan,
  validatePlanMetadata,
  validatePlanTerms,
} from "./plan-rules.ts";

export type PlansResult<T extends object = object> =
  ({ ok: true } & T) | ({ ok: false } & PlanRefusal);

export type BillingPlansService = {
  /** Every plan in display order with its versions, the catalog entries to pick from, and the warnings. */
  view(): Promise<PlansView>;
  /** A `paid` plan with its first version, or a `contact` plan (Enterprise). `clearedPopular` names a plan that lost the badge. */
  createPlan(
    adminId: string,
    input: unknown,
  ): Promise<PlansResult<{ plan: PlanView; clearedPopular: string | null }>>;
  /** Replaces some of the display fields in place; no new version. */
  updatePlan(
    adminId: string,
    planKey: string,
    patch: unknown,
  ): Promise<PlansResult<{ plan: PlanView; clearedPopular: string | null }>>;
  /** `{ basedOnVersion, terms }`: saves the next version of a plan. */
  saveTerms(
    adminId: string,
    planKey: string,
    input: unknown,
  ): Promise<PlansResult<{ plan: PlanView }>>;
  setArchived(
    adminId: string,
    planKey: string,
    archived: boolean,
  ): Promise<PlansResult<{ plan: PlanView }>>;
  deletePlan(planKey: string): Promise<PlansResult>;
  /** Billing was switched on: seeds the Free plan the first time and writes its current version as the default. */
  enable(adminId: string): Promise<void>;
  /** Billing was switched off: the default entitlements return to the operator. */
  release(): Promise<void>;
};

export type BillingPlansServiceOptions = {
  db: Kysely<Database>;
  now?: () => Date;
};

export const FREE_PLAN_KEY = "free";

/**
 * The starting point of the Free plan, written once when billing is first switched on and edited by the operator from
 * then on: these are limits, not prices, and the plan is `managed` with an empty model access until the operator picks
 * entries (ADR 0005, M7, M18).
 */
const FREE_PLAN_SEED = {
  name: "Free",
  description: "",
  sort: 0,
  terms: {
    keyMode: "managed",
    limits: {
      diffRunsPerPeriod: 10,
      dynamicRunsPerPeriod: 2,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
    },
    modelAccess: { catalogEntries: [] },
    monthlyAmountMinor: null,
    yearlyAmountMinor: null,
  },
} as const satisfies {
  name: string;
  description: string;
  sort: number;
  terms: PlanTerms;
};

const REFUSE_NOT_FOUND = {
  ok: false,
  code: "plan_not_found",
} as const satisfies PlansResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function startOfMonth(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
}

function toVersionView(version: PlanVersionRow): PlanVersionView {
  return {
    number: version.number,
    role: version.role,
    createdAt: version.createdAt,
    keyMode: version.keyMode,
    limits: version.limits,
    modelAccess: version.modelAccess,
    monthlyAmountMinor: version.monthlyAmountMinor,
    yearlyAmountMinor: version.yearlyAmountMinor,
  };
}

function toPlanView(plan: PlanRow, versions: PlanVersionRow[]): PlanView {
  return {
    planKey: plan.planKey,
    kind: plan.kind,
    name: plan.name,
    description: plan.description,
    sort: plan.sort,
    offered: plan.offered,
    popular: plan.popular,
    contactTarget: plan.contactTarget,
    archived: plan.archivedAt !== null,
    versions: versions.map(toVersionView),
  };
}

function sameList(a: readonly string[] | null, b: readonly string[] | null) {
  if (a === null || b === null) return a === b;
  return (
    a.length === b.length &&
    [...a].sort().join("\n") === [...b].sort().join("\n")
  );
}

/** Whether saving `next` would only repeat `current`: the order of a list of entries does not make a version. */
function sameTerms(current: PlanTerms, next: PlanTerms): boolean {
  return (
    current.keyMode === next.keyMode &&
    current.monthlyAmountMinor === next.monthlyAmountMinor &&
    current.yearlyAmountMinor === next.yearlyAmountMinor &&
    (Object.keys(current.limits) as Array<keyof PlanTerms["limits"]>).every(
      (name) => current.limits[name] === next.limits[name],
    ) &&
    sameList(
      current.modelAccess?.catalogEntries ?? null,
      next.modelAccess?.catalogEntries ?? null,
    )
  );
}

export function createBillingPlansService({
  db,
  now = () => new Date(),
}: BillingPlansServiceOptions): BillingPlansService {
  function repositories(executor: Kysely<Database>) {
    return {
      plans: createBillingPlansRepository(executor, now),
      versions: createBillingPlanVersionsRepository(executor, now),
      settings: createInstanceSettingsRepository(executor, now),
    };
  }
  type Repositories = ReturnType<typeof repositories>;

  async function viewOf(
    { plans, versions }: Pick<Repositories, "plans" | "versions">,
    planKey: string,
  ): Promise<PlanView> {
    const plan = await plans.get(planKey);
    if (plan === undefined) throw new Error("The plan cannot be read.");
    return toPlanView(plan, await versions.list(plan.id));
  }

  /** The current version of the Free plan becomes the default entitlements of every workspace without a row. */
  async function writeFreeDefault(
    { plans, versions, settings }: Repositories,
    adminId: string,
  ): Promise<void> {
    const free = (await plans.list()).find((plan) => plan.kind === "free");
    if (free === undefined) return;
    const current = await versions.current(free.id);
    if (current === undefined) return;
    await settings.setBillingDefaultEntitlements(
      planEntitlements({
        name: free.name,
        terms: current,
        periodStart: startOfMonth(now()),
      }),
      adminId,
    );
  }

  /** The refusal for an error thrown by a repository, or the error again. */
  function refusalOf(error: unknown): PlansResult | undefined {
    if (error instanceof PlanKeyTakenError)
      return { ok: false, code: "plan_key_taken", field: "planKey" };
    if (error instanceof PlanChangedError)
      return { ok: false, code: "plan_changed" };
    return undefined;
  }

  async function guardedWrite<T extends object>(
    work: () => Promise<PlansResult<T>>,
  ): Promise<PlansResult<T>> {
    try {
      return await work();
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal === undefined || refusal.ok) throw error;
      return refusal;
    }
  }

  return {
    async view() {
      const { plans, versions } = repositories(db);
      const rows = await plans.list();
      const all = await versions.listForPlans(rows.map((plan) => plan.id));
      const planViews = rows.map((plan) =>
        toPlanView(
          plan,
          all.filter((version) => version.planId === plan.id),
        ),
      );
      const entries = await createCatalogRepository(db).list();
      const catalog: CatalogChoice[] = entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        provider: entry.provider,
        modelId: entry.modelId,
        status: entry.status,
      }));
      const ownKeyWorkspaces =
        await createOwnKeyCountRepository(db).countWorkspacesWithStoredOwnKey();
      const ownPlanOffered = planViews.some(
        (plan) =>
          plan.kind === "paid" &&
          plan.offered &&
          !plan.archived &&
          plan.versions.find((version) => version.role === "current")
            ?.keyMode === "own",
      );
      const warnings: PlanWarning[] =
        ownKeyWorkspaces > 0 && !ownPlanOffered
          ? ["own_key_workspaces_without_own_plan"]
          : [];
      return { plans: planViews, catalog, ownKeyWorkspaces, warnings };
    },

    createPlan(adminId, input) {
      return guardedWrite(async () => {
        const checked = validateNewPlan(input, now());
        if (!checked.ok) return checked;
        const { planKey, kind, metadata, terms } = checked.value;
        return db.transaction().execute(async (trx) => {
          const repos = repositories(trx);
          // The flag is set after the insert, so it moves from the plan that has it in the same transaction.
          const inserted = await repos.plans.insert(
            { planKey, kind, metadata: { ...metadata, popular: false } },
            adminId,
          );
          let clearedPopular: string | null = null;
          if (metadata.popular) {
            const moved = await repos.plans.update(
              planKey,
              metadata,
              adminId,
              inserted.updatedAt,
            );
            if (moved === undefined) throw new PlanChangedError();
            clearedPopular = moved.clearedPopular;
          }
          if (terms !== null)
            await repos.versions.createNext(inserted.id, terms, adminId, 0);
          return {
            ok: true as const,
            plan: await viewOf(repos, planKey),
            clearedPopular,
          };
        });
      });
    },

    updatePlan(adminId, planKey, patch) {
      return guardedWrite(async () => {
        if (!isRecord(patch)) return { ok: false, code: "plan_input_invalid" };
        const stored = await createBillingPlansRepository(db, now).get(planKey);
        if (stored === undefined) return REFUSE_NOT_FOUND;
        const merged = {
          name: stored.name,
          description: stored.description,
          sort: stored.sort,
          offered: stored.offered,
          popular: stored.popular,
          contactTarget: stored.contactTarget,
          ...patch,
        };
        const checked = validatePlanMetadata(stored.kind, merged);
        if (!checked.ok) return checked;
        // An archived plan is not offered and has no badge; restore it first.
        if (
          stored.archivedAt !== null &&
          (checked.value.offered || checked.value.popular)
        )
          return {
            ok: false,
            code: "plan_archived",
            field: checked.value.popular ? "popular" : "offered",
          };
        return db.transaction().execute(async (trx) => {
          const repos = repositories(trx);
          const moved = await repos.plans.update(
            planKey,
            checked.value satisfies PlanMetadata,
            adminId,
            stored.updatedAt,
          );
          if (moved === undefined)
            return { ok: false as const, code: "plan_changed" as const };
          // The plan label of the default is the name of the Free plan.
          if (stored.kind === "free" && stored.name !== checked.value.name)
            await writeFreeDefault(repos, adminId);
          return {
            ok: true as const,
            plan: await viewOf(repos, planKey),
            clearedPopular: moved.clearedPopular,
          };
        });
      });
    },

    saveTerms(adminId, planKey, input) {
      return guardedWrite(async () => {
        const body = isRecord(input) ? input : undefined;
        if (
          body === undefined ||
          Object.keys(body).some(
            (key) => key !== "basedOnVersion" && key !== "terms",
          ) ||
          typeof body.basedOnVersion !== "number" ||
          !Number.isSafeInteger(body.basedOnVersion) ||
          body.basedOnVersion < 0
        )
          return {
            ok: false,
            code: "plan_input_invalid",
            field: "basedOnVersion",
          };
        const { basedOnVersion } = body;
        const stored = await createBillingPlansRepository(db, now).get(planKey);
        if (stored === undefined) return REFUSE_NOT_FOUND;
        if (stored.archivedAt !== null)
          return { ok: false, code: "plan_archived" };
        const checked = validatePlanTerms(stored.kind, body.terms, {
          planName: stored.name,
          now: now(),
        });
        if (!checked.ok) return checked;
        return db.transaction().execute(async (trx) => {
          const repos = repositories(trx);
          const current = await repos.versions.current(stored.id);
          if (current !== undefined && sameTerms(current, checked.value))
            return {
              ok: false as const,
              code: "plan_version_unchanged" as const,
            };
          await repos.versions.createNext(
            stored.id,
            checked.value,
            adminId,
            basedOnVersion,
          );
          if (stored.kind === "free") await writeFreeDefault(repos, adminId);
          return { ok: true as const, plan: await viewOf(repos, planKey) };
        });
      });
    },

    setArchived(adminId, planKey, archived) {
      return guardedWrite(async () => {
        const { plans, versions } = repositories(db);
        const stored = await plans.get(planKey);
        if (stored === undefined) return REFUSE_NOT_FOUND;
        if (stored.kind === "free")
          return { ok: false, code: "free_plan_not_archivable" };
        const changed = await plans.setArchived(planKey, archived, adminId);
        if (changed === undefined) return REFUSE_NOT_FOUND;
        return {
          ok: true as const,
          plan: toPlanView(changed, await versions.list(changed.id)),
        };
      });
    },

    async deletePlan(planKey) {
      const { plans } = repositories(db);
      const stored = await plans.get(planKey);
      if (stored === undefined) return REFUSE_NOT_FOUND;
      if (stored.kind === "free")
        return { ok: false, code: "free_plan_not_deletable" };
      // Versions are what subscribers bought: a plan that has any is archived, not deleted.
      if (!(await plans.remove(planKey)))
        return { ok: false, code: "plan_has_versions" };
      return { ok: true };
    },

    async enable(adminId) {
      await db.transaction().execute(async (trx) => {
        const repos = repositories(trx);
        let free = (await repos.plans.list()).find(
          (plan) => plan.kind === "free",
        );
        free ??= await repos.plans.insert(
          {
            planKey: FREE_PLAN_KEY,
            kind: "free",
            metadata: {
              name: FREE_PLAN_SEED.name,
              description: FREE_PLAN_SEED.description,
              sort: FREE_PLAN_SEED.sort,
              offered: true,
              popular: false,
              contactTarget: null,
            },
          },
          adminId,
        );
        if ((await repos.versions.current(free.id)) === undefined)
          await repos.versions.createNext(
            free.id,
            FREE_PLAN_SEED.terms,
            adminId,
            0,
          );
        await writeFreeDefault(repos, adminId);
      });
    },

    async release() {
      await repositories(db).settings.removeBillingDefaultEntitlements();
    },
  };
}
