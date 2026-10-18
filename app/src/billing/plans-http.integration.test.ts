// SPDX-License-Identifier: Apache-2.0

// The data routes of the plans page (#438) with the real service over a real database: only the instance admin reaches
// them, they do not exist while billing is off (and then read no billing table), a change needs the same origin and a JSON
// body, and every refusal is `{ "error": <stable code> }`. The portal around them (proxy, sessions) is tested by
// src/admin; these tests hand the handlers the access result directly.
import type { KyselyPlugin } from "kysely";
import { describe, expect, it, vi } from "vitest";
import type { AdminAccess } from "../admin/access.ts";
import type { PlansView } from "../admin/ui/plans-view.ts";
import { NotFoundSignal } from "../test-support/admin-harness.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { insertUser } from "../test-support/users.ts";
import { createPlansRouteHandlers } from "./plans-http.ts";
import { createBillingPlansService } from "./plans-service.ts";

const LIMITS = {
  diffRunsPerPeriod: 40,
  dynamicRunsPerPeriod: 8,
  managedCostLimitMicroUsd: null,
  ownKeyCostLimitMicroUsd: null,
};

const NEW_PLAN = {
  planKey: "team",
  kind: "paid",
  name: "Team",
  description: "",
  sort: 20,
  offered: true,
  popular: false,
  contactTarget: null,
  terms: {
    keyMode: "managed",
    limits: LIMITS,
    modelAccess: { catalogEntries: null },
    monthlyAmountMinor: 1234,
    yearlyAmountMinor: null,
  },
};

async function start(
  options: { access?: AdminAccess; billingOn?: boolean } = {},
) {
  const { db } = await createTestDatabase();
  const admin = await insertUser(db, { id: "admin-1", isInstanceAdmin: true });
  const statements: string[] = [];
  const recorder: KyselyPlugin = {
    transformQuery: ({ node }) => {
      statements.push(JSON.stringify(node));
      return node;
    },
    transformResult: (args) => Promise.resolve(args.result),
  };
  const service = createBillingPlansService({ db: db.withPlugin(recorder) });
  const spy = {
    view: vi.spyOn(service, "view"),
    createPlan: vi.spyOn(service, "createPlan"),
  };
  let access: AdminAccess =
    options.access ?? ({ kind: "admin", user: { id: admin } } as AdminAccess);
  const handlers = createPlansRouteHandlers({
    access: () => Promise.resolve(access),
    notFound: () => {
      throw new NotFoundSignal();
    },
    isOn: () => Promise.resolve(options.billingOn ?? true),
    service,
  });
  return {
    handlers,
    spy,
    statements,
    setAccess: (next: AdminAccess) => {
      access = next;
    },
  };
}

function json(
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request("http://localhost:3000/api/admin/billing/plans", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function bare(method: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/admin/billing/plans", {
    method,
    headers,
  });
}

describe("the plans routes", () => {
  // #438-T11
  it("answer an anonymous caller 401 and read nothing", async () => {
    const { handlers, statements } = await start({
      access: { kind: "anonymous" } as AdminAccess,
    });

    const response = await handlers.get(bare("GET"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
    expect(statements).toEqual([]);
  });

  // #438-T11
  it("answer somebody who is not an admin as a path that does not exist and read nothing", async () => {
    const { handlers, statements } = await start({
      access: { kind: "not_admin" } as AdminAccess,
    });

    await expect(handlers.get(bare("GET"))).rejects.toBeInstanceOf(
      NotFoundSignal,
    );
    await expect(
      handlers.create(json("POST", NEW_PLAN)),
    ).rejects.toBeInstanceOf(NotFoundSignal);
    await expect(
      handlers.change(json("PUT", { archived: true }), "team"),
    ).rejects.toBeInstanceOf(NotFoundSignal);
    await expect(
      handlers.remove(bare("DELETE"), "team"),
    ).rejects.toBeInstanceOf(NotFoundSignal);
    expect(statements).toEqual([]);
  });

  // #438-T10
  it("do not exist while billing is off: no billing table is read or written", async () => {
    const { handlers, statements, spy } = await start({ billingOn: false });

    await expect(handlers.get(bare("GET"))).rejects.toBeInstanceOf(
      NotFoundSignal,
    );
    await expect(
      handlers.create(json("POST", NEW_PLAN)),
    ).rejects.toBeInstanceOf(NotFoundSignal);
    await expect(
      handlers.change(json("PUT", { archived: true }), "team"),
    ).rejects.toBeInstanceOf(NotFoundSignal);
    await expect(
      handlers.remove(bare("DELETE"), "team"),
    ).rejects.toBeInstanceOf(NotFoundSignal);

    expect(spy.view).not.toHaveBeenCalled();
    expect(spy.createPlan).not.toHaveBeenCalled();
    expect(statements).toEqual([]);
  });

  it("list the plans with no-store caching", async () => {
    const { handlers } = await start();

    const response = await handlers.get(bare("GET"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      plans: [],
      catalog: [],
      ownKeyWorkspaces: 0,
      warnings: [],
    });
  });

  // #438-T01
  it("create a plan and answer the whole list", async () => {
    const { handlers } = await start();

    const response = await handlers.create(json("POST", NEW_PLAN));
    const body = (await response.json()) as {
      ok: boolean;
      clearedPopular: string | null;
      plans: PlansView;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.clearedPopular).toBeNull();
    expect(body.plans.plans[0]).toMatchObject({
      planKey: "team",
      versions: [{ number: 1, role: "current", monthlyAmountMinor: 1234 }],
    });
  });

  // #438-T02
  it("save the next version, edit in place and archive, one change per request", async () => {
    const { handlers } = await start();
    await handlers.create(json("POST", NEW_PLAN));

    const version = await handlers.change(
      json("PUT", {
        terms: {
          basedOnVersion: 1,
          terms: { ...NEW_PLAN.terms, monthlyAmountMinor: 1500 },
        },
      }),
      "team",
    );
    const edited = await handlers.change(
      json("PUT", { metadata: { name: "Teams", sort: 3 } }),
      "team",
    );
    const archived = await handlers.change(
      json("PUT", { archived: true }),
      "team",
    );

    expect(version.status).toBe(200);
    expect(edited.status).toBe(200);
    expect(archived.status).toBe(200);
    const view = (await (await handlers.get(bare("GET"))).json()) as PlansView;
    expect(view.plans[0]).toMatchObject({
      name: "Teams",
      sort: 3,
      archived: true,
      versions: [
        { number: 2, role: "current", monthlyAmountMinor: 1500 },
        { number: 1, role: "legacy", monthlyAmountMinor: 1234 },
      ],
    });
  });

  // #438-T27
  it("name the plan that lost the Popular badge", async () => {
    const { handlers } = await start();
    await handlers.create(
      json("POST", { ...NEW_PLAN, planKey: "plan-a", popular: true }),
    );
    await handlers.create(json("POST", { ...NEW_PLAN, planKey: "plan-b" }));

    const response = await handlers.change(
      json("PUT", { metadata: { popular: true } }),
      "plan-b",
    );

    expect(await response.json()).toMatchObject({
      ok: true,
      clearedPopular: "plan-a",
    });
  });

  it("refuse a body that has none or several of the changes", async () => {
    const { handlers } = await start();
    await handlers.create(json("POST", NEW_PLAN));

    for (const body of [
      {},
      { archived: true, metadata: { sort: 1 } },
      { archived: "yes" },
      { other: 1 },
    ]) {
      const response = await handlers.change(json("PUT", body), "team");
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: "invalid_input" });
    }
  });

  // #438-T07
  it("refuse a change whose content is not an object", async () => {
    const { handlers } = await start();
    await handlers.create(json("POST", NEW_PLAN));

    const response = await handlers.change(
      json("PUT", { metadata: "x" }),
      "team",
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "plan_input_invalid",
    });
  });

  // #438-T07
  it("answer a refusal with its stable code, the field and the status of the code", async () => {
    const { handlers } = await start();
    await handlers.create(json("POST", NEW_PLAN));

    const price = await handlers.create(
      json("POST", {
        ...NEW_PLAN,
        planKey: "other",
        terms: { ...NEW_PLAN.terms, monthlyAmountMinor: 0 },
      }),
    );
    const taken = await handlers.create(json("POST", NEW_PLAN));
    const limit = await handlers.change(
      json("PUT", {
        terms: {
          basedOnVersion: 1,
          terms: {
            ...NEW_PLAN.terms,
            limits: { ...LIMITS, diffRunsPerPeriod: -1 },
          },
        },
      }),
      "team",
    );

    expect(price.status).toBe(422);
    expect(await price.json()).toEqual({
      error: "plan_price_invalid",
      field: "monthlyAmountMinor",
    });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: "plan_key_taken" });
    expect(limit.status).toBe(422);
    expect(await limit.json()).toEqual({
      error: "limit_invalid",
      field: "diffRunsPerPeriod",
    });
  });

  it("answer a plan that does not exist 404, also for a key that is no key", async () => {
    const { handlers } = await start();

    for (const key of ["ghost", "Not A Key", "../x"]) {
      const response = await handlers.change(
        json("PUT", { archived: true }),
        key,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "plan_not_found" });
    }
    expect((await handlers.remove(bare("DELETE"), "ghost")).status).toBe(404);
  });

  // #438-T08
  it("delete an Enterprise plan and refuse to delete a plan with versions", async () => {
    const { handlers } = await start();
    await handlers.create(json("POST", NEW_PLAN));
    await handlers.create(
      json("POST", {
        planKey: "enterprise",
        kind: "contact",
        name: "Enterprise",
        description: "",
        sort: 90,
        offered: true,
        popular: false,
        contactTarget: "mailto:sales@example.test",
      }),
    );

    const kept = await handlers.remove(bare("DELETE"), "team");
    const gone = await handlers.remove(bare("DELETE"), "enterprise");

    expect(kept.status).toBe(409);
    expect(await kept.json()).toEqual({ error: "plan_has_versions" });
    expect(gone.status).toBe(200);
  });

  it("refuse a change from another site, without a JSON body or with a body that is too large", async () => {
    const { handlers } = await start();

    const crossSite = await handlers.create(
      json("POST", NEW_PLAN, { "sec-fetch-site": "cross-site" }),
    );
    const crossDelete = await handlers.remove(
      bare("DELETE", { "sec-fetch-site": "cross-site" }),
      "team",
    );
    const text = await handlers.create(
      new Request("http://localhost:3000/api/admin/billing/plans", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify(NEW_PLAN),
      }),
    );
    const large = await handlers.create(
      json("POST", { ...NEW_PLAN, description: "x".repeat(70_000) }),
    );
    const notJson = await handlers.create(
      new Request("http://localhost:3000/api/admin/billing/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );

    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: "cross_site_request" });
    expect(crossDelete.status).toBe(403);
    expect(text.status).toBe(415);
    expect(large.status).toBe(413);
    expect(notJson.status).toBe(422);
  });

  it("answer a failure of the database 503 with no detail", async () => {
    const { handlers, spy } = await start();
    spy.view.mockRejectedValueOnce(new Error("secret detail"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handlers.get(bare("GET"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });
});
