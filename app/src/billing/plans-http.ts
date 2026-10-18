// SPDX-License-Identifier: Apache-2.0

// The handlers behind the plans data routes of the admin portal (#438; the route files are below
// src/app/api/instance-portal/billing/plans and the proxy's /admin rewrite serves them at the addresses below), with their collaborators passed in so the route
// files only wire the real ones and tests wire a test database:
//
//   GET    /api/admin/billing/plans             the plans in display order with their versions, the catalog entries to
//                                               pick for `modelAccess`, and the warnings (`PlansView`)
//   POST   /api/admin/billing/plans             a new plan: a paid plan with its first version, or an Enterprise plan
//   PUT    /api/admin/billing/plans/:planKey    one change; the body has exactly one of
//                                               { "metadata": { name?, description?, sort?, offered?, popular?, contactTarget? } }
//                                                 (edited in place, no new version)
//                                               { "terms": { "basedOnVersion": n, "terms": { keyMode, limits, modelAccess,
//                                                 monthlyAmountMinor, yearlyAmountMinor } } }   (creates version n + 1)
//                                               { "archived": boolean }
//                                               { "priceLink": { versionNumber, interval: "month" | "year", paddlePriceId } }
//                                                 (#439: links a Paddle price to the slot of the current version; the body has
//                                                 no amount, currency or tax mode, they are the version's and Paddle's)
//                                               { "refreshPrices": true }   (reads the linked prices again from Paddle)
//                                               { "createPrices": { versionNumber, trialDays? } }
//                                                 (#440: creates the Paddle product on first use and the prices of the current
//                                                 version that have none, from the version's entered amounts; the body has no
//                                                 amount, currency, interval or tax mode)
//                                               { "archivePrice": { paddlePriceId } }
//                                                 (#440: archives a price the current version is not sold with and no live
//                                                 subscription uses; the only change ever made to an existing price)
//   DELETE /api/admin/billing/plans/:planKey    deletes a plan that has no version (an Enterprise plan)
//
// Order: the admin first (nothing is read before the caller is known: not signed in is 401, signed in but not an admin is
// a 404 like for any path that does not exist), then whether billing is on (while it is off these routes are the 404 of a
// missing path, `guardBillingRoute`: no billing table is read), then for a change where the request comes from, its content
// type and its body, then the service. Every refusal is `{ "error": <code> }` (with `field` when a field is to blame) with a
// stable code from plan-errors.ts or the entitlements validation; every answer is `Cache-Control: no-store`. A successful
// write answers `{ ok: true, clearedPopular, plans }`: the whole list, and the key of the plan that lost the Popular badge.
import "server-only";
import type { AdminAccess } from "../admin/access.ts";
import type { SessionUser } from "../auth/access-policy.ts";
import { JSON_BODY_ERROR_STATUS, readJsonObject } from "../http/json-body.ts";
import { isCrossSite } from "../http/request-checks.ts";
import { ENTITLEMENT_ERROR_CODES } from "../workspaces/entitlements-validation.ts";
import { guardBillingRoute } from "./enabled.ts";
import { PLAN_ERROR_STATUS, type PlanRefusal } from "./plan-errors.ts";
import { PRICE_ERROR_STATUS, type PriceRefusal } from "./price-errors.ts";
import type { BillingPlansService, PlansResult } from "./plans-service.ts";
import type { BillingPricesService, PricesResult } from "./prices-service.ts";

/** Limits, a list of entries and a few lines of text: far below this. */
export const PLANS_REQUEST_MAX_BYTES = 64 * 1024;

export type PlansRouteDependencies = {
  /** Who the request is: called first, on every request. */
  access: () => Promise<AdminAccess>;
  /** The 404 for somebody who is not an admin, and for every request while billing is off: Next.js's own. Throws. */
  notFound: () => never;
  /** Whether billing is on right now (`isBillingOn`). */
  isOn: () => Promise<boolean>;
  service: BillingPlansService;
  /** The Paddle prices linked to plan versions (#439). */
  prices: BillingPricesService;
};

export type PlansRouteHandlers = {
  get(request: Request): Promise<Response>;
  create(request: Request): Promise<Response>;
  change(request: Request, planKey: string): Promise<Response>;
  remove(request: Request, planKey: string): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };
const CHANGE_KEYS = [
  "metadata",
  "terms",
  "archived",
  "priceLink",
  "refreshPrices",
  "createPrices",
  "archivePrice",
] as const;
const PLAN_KEY = /^[a-z][a-z0-9-]{1,31}$/;

function statusOf(code: PlanRefusal["code"]): number {
  if (Object.hasOwn(PLAN_ERROR_STATUS, code))
    return PLAN_ERROR_STATUS[code as keyof typeof PLAN_ERROR_STATUS];
  return ENTITLEMENT_ERROR_CODES.some((known) => known === code) ? 422 : 400;
}

function refusal(
  error: string,
  status: number,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({ error, ...extra }, { status, headers: NO_STORE });
}

function fromRefusal(result: PlanRefusal): Response {
  // `field` names the field to blame; `issues` is the same for the pages (src/ui/json-request.ts reads it).
  return refusal(
    result.code,
    statusOf(result.code),
    result.field === undefined
      ? {}
      : {
          field: result.field,
          issues: [{ field: result.field, code: result.code }],
        },
  );
}

function fromPriceRefusal(result: PriceRefusal): Response {
  return refusal(result.code, PRICE_ERROR_STATUS[result.code], {
    ...(result.field === undefined
      ? {}
      : {
          field: result.field,
          issues: [{ field: result.field, code: result.code }],
        }),
    // A refresh that could not read some prices: one issue per price, its id as the field.
    ...(result.failures === undefined
      ? {}
      : {
          issues: result.failures.map((failure) => ({
            field: failure.paddlePriceId,
            code: failure.code,
          })),
        }),
    // The two values of a mismatch, in minor units for an amount: what the version holds and what Paddle says.
    ...(result.entered === undefined ? {} : { entered: result.entered }),
    ...(result.paddle === undefined ? {} : { paddle: result.paddle }),
  });
}

function invalidInput(): Response {
  return refusal("invalid_input", JSON_BODY_ERROR_STATUS.invalid_input, {
    issues: [{ field: "", code: "body_invalid" }],
  });
}

export function createPlansRouteHandlers({
  access,
  notFound,
  isOn,
  service,
  prices,
}: PlansRouteDependencies): PlansRouteHandlers {
  // The user first. The proxy has turned these away already; this is the second guard.
  async function admin(): Promise<SessionUser | Response> {
    const who = await access();
    if (who.kind === "anonymous")
      return Response.json(
        { error: "UNAUTHENTICATED" },
        { status: 401, headers: NO_STORE },
      );
    if (who.kind === "not_admin") return notFound();
    return who.user;
  }

  /** The admin check, then the billing guard, then the work. */
  function route<Args extends unknown[]>(
    work: (
      who: SessionUser,
      request: Request,
      ...args: Args
    ) => Promise<Response>,
  ): (request: Request, ...args: Args) => Promise<Response> {
    return async (request, ...args) => {
      const who = await admin();
      if (who instanceof Response) return who;
      const guarded = guardBillingRoute(
        { isOn, notFound },
        (...inner: [Request, ...Args]) => work(who, ...inner),
      );
      return guarded(request, ...args);
    };
  }

  /** Runs a service call; a database failure is a 503, never a message. */
  async function guarded<T>(call: () => Promise<T>): Promise<T | Response> {
    try {
      return await call();
    } catch {
      // No error text: it could carry whatever the failing layer held.
      console.error(
        "[billing] BILLING_PLANS_UNAVAILABLE: the request was not served.",
      );
      return refusal("unavailable", 503);
    }
  }

  /** The whole list after a successful write, and the key of the plan that lost the Popular badge. */
  async function listAfterWrite(
    clearedPopular: string | null,
  ): Promise<Response> {
    const plans = await guarded(() => service.view());
    if (plans instanceof Response) return plans;
    return Response.json(
      { ok: true, clearedPopular, plans },
      { headers: NO_STORE },
    );
  }

  async function answer(
    result: PlansResult<{ clearedPopular?: string | null }>,
  ): Promise<Response> {
    if (!result.ok) return fromRefusal(result);
    return listAfterWrite(result.clearedPopular ?? null);
  }

  async function answerPrice(result: PricesResult): Promise<Response> {
    if (!result.ok) return fromPriceRefusal(result);
    return listAfterWrite(null);
  }

  function validPlanKey(planKey: string): boolean {
    return PLAN_KEY.test(planKey);
  }

  return {
    get: route(async () => {
      const plans = await guarded(() => service.view());
      if (plans instanceof Response) return plans;
      return Response.json(plans, { headers: NO_STORE });
    }),

    create: route(async (who, request) => {
      const body = await readJsonObject(request, PLANS_REQUEST_MAX_BYTES);
      if (!body.ok)
        return refusal(body.error, JSON_BODY_ERROR_STATUS[body.error]);
      const result = await guarded(() =>
        service.createPlan(who.id, body.value),
      );
      if (result instanceof Response) return result;
      return answer(result);
    }),

    change: route(async (who, request, planKey: string) => {
      const body = await readJsonObject(request, PLANS_REQUEST_MAX_BYTES);
      if (!body.ok)
        return refusal(body.error, JSON_BODY_ERROR_STATUS[body.error]);
      const fields = body.value;
      const given = CHANGE_KEYS.filter((key) => Object.hasOwn(fields, key));
      if (given.length !== 1 || Object.keys(fields).length !== 1)
        return invalidInput();
      if (!validPlanKey(planKey)) return refusal("plan_not_found", 404);
      const answered = await guarded(
        async (): Promise<Response | undefined> => {
          switch (given[0]) {
            case "metadata":
              return answer(
                await service.updatePlan(who.id, planKey, fields.metadata),
              );
            case "terms":
              return answer(
                await service.saveTerms(who.id, planKey, fields.terms),
              );
            case "priceLink":
              return answerPrice(
                await prices.link(who.id, planKey, fields.priceLink),
              );
            case "refreshPrices":
              if (fields.refreshPrices !== true) return undefined;
              return answerPrice(await prices.refresh(planKey));
            case "createPrices":
              return answerPrice(
                await prices.create(who.id, planKey, fields.createPrices),
              );
            case "archivePrice":
              return answerPrice(
                await prices.archive(who.id, planKey, fields.archivePrice),
              );
            default:
              if (typeof fields.archived !== "boolean") return undefined;
              return answer(
                await service.setArchived(who.id, planKey, fields.archived),
              );
          }
        },
      );
      return answered ?? invalidInput();
    }),

    remove: route(async (_who, request, planKey: string) => {
      if (isCrossSite(request))
        return refusal(
          "cross_site_request",
          JSON_BODY_ERROR_STATUS.cross_site_request,
        );
      if (!validPlanKey(planKey)) return refusal("plan_not_found", 404);
      const result = await guarded(() => service.deletePlan(planKey));
      if (result instanceof Response) return result;
      return answer(result);
    }),
  };
}
