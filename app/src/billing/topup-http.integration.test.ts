// SPDX-License-Identifier: Apache-2.0

// #501: `POST /api/w/:workspace/billing/top-ups` as the app wires it (guard, adapter, access, limit, body, service), over a
// real database, the real matrix of roles and the fake Stripe.
import { vi } from "vitest";
import { describe, expect, it } from "vitest";
import { createBillingProfilesRepository } from "../db/repositories/billing-profiles-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { signedInMember } from "../test-support/session-lookup.ts";
import { clientFor, startTestStripe } from "../test-support/stripe-fake.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { resolveWorkspaceAccess } from "../workspaces/access.ts";
import { accessRefusal } from "../workspaces/access-response.ts";
import type { WorkspaceRole } from "../workspaces/roles.ts";
import { isBillingOn } from "./enabled.ts";
import { manualAdapter } from "./manual-adapter.ts";
import type { BillingProfileInput } from "./profile.ts";
import { createStripeAdapter } from "./stripe-adapter.ts";
import { TOP_UP_REQUESTS_MAX, createTopUpLimits } from "./topup-limits.ts";
import { createTopUpRoute } from "./topup-http.ts";
import { createTopUpService } from "./topup-service.ts";
import type { BillingAdapter } from "./adapter.ts";

const BASE_URL = "https://app.example.test";
const PROFILE: BillingProfileInput = {
  legalName: "Example GmbH",
  country: "DE",
  addressLine1: "Teststrasse 1",
  addressLine2: null,
  postalCode: "10115",
  city: "Berlin",
  vatId: "DE123456789",
};

class NotFound extends Error {}

async function start(
  options: { billingOn?: boolean; adapter?: "stripe" | "manual" | "none" } = {},
) {
  const { db } = await createTestDatabase();
  const workspaceId = await addWorkspace(db, "acme");
  const otherWorkspaceId = await addWorkspace(db, "other");
  await setBillingSwitch(db, options.billingOn ?? true);
  const fake = await startTestStripe();
  const stripe = createStripeAdapter({
    client: () => Promise.resolve(clientFor(fake)),
  });
  const adapter: BillingAdapter | undefined =
    options.adapter === "manual"
      ? manualAdapter
      : options.adapter === "none"
        ? undefined
        : stripe;
  const isOn = vi.fn(() => isBillingOn(db));
  const activeAdapter = vi.fn(() => Promise.resolve(adapter));
  const logs: string[] = [];
  const route = createTopUpRoute({
    guard: {
      isOn,
      notFound: () => {
        throw new NotFound("not found");
      },
    },
    activeAdapter,
    serviceFor: (active) =>
      createTopUpService({
        db,
        adapter: active,
        log: (line) => logs.push(line),
      }),
    limits: createTopUpLimits(createRateLimitsRepository(db)),
    baseUrl: BASE_URL,
    log: { info: (line) => logs.push(line) },
  });
  const workspaces = createWorkspacesRepository(db);
  await createBillingProfilesRepository(db, workspaceId).save(PROFILE);

  /** The access check of a workspace route with the real matrix and the real refusals, for this person. */
  const as =
    (
      lookup: Awaited<ReturnType<typeof signedInMember>> | { kind: "none" },
      slug = "acme",
    ) =>
    (handler: Parameters<Parameters<typeof route.post>[2]>[0]) =>
      resolveWorkspaceAccess({
        lookup,
        slug,
        action: "manage_billing",
        findMembership: (userId, name) =>
          workspaces.findMembership(userId, name),
      }).then((result) =>
        result.kind === "ok" ? handler(result.access) : accessRefusal(result),
      );
  const person = async (
    role: WorkspaceRole,
    id = `u-${role}`,
    workspace = workspaceId,
  ) => signedInMember(db, { id, workspaceId: workspace, role });
  const request = (body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${BASE_URL}/api/w/acme/billing/top-ups`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const intents = () =>
    createBillingTopUpIntentsRepository(db, workspaceId).list({ limit: 10 });
  return {
    db,
    workspaceId,
    otherWorkspaceId,
    fake,
    route,
    as,
    person,
    request,
    intents,
    isOn,
    activeAdapter,
    logs,
  };
}

const GOOD = { amountCents: 2500, confirmBusiness: true };

describe("POST /api/w/:workspace/billing/top-ups", () => {
  // #501-T01
  it("starts a top-up for an Owner: the page to go to and the intent, with no store and the success page of the workspace", async () => {
    const t = await start();

    const response = await t.route.post(
      t.request(GOOD),
      "acme",
      t.as(await t.person("owner")),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { intentId: string; url: string };
    expect(Object.keys(body).sort()).toEqual(["intentId", "url"]);
    expect(body.url).toBe(t.fake.checkoutSessions()[0]?.url);
    expect(await t.intents()).toMatchObject([
      { id: body.intentId, state: "pending", amountMicroUsd: 25_000_000 },
    ]);
    const sent = t.fake
      .requests()
      .find((r) => r.path === "/v1/checkout/sessions");
    expect(sent?.form).toMatchObject({
      success_url: "https://app.example.test/w/acme/billing?topup=success",
      cancel_url: "https://app.example.test/w/acme/billing?topup=cancelled",
    });
  });

  // #501-T01
  it("lets an Admin top up", async () => {
    const t = await start();

    const response = await t.route.post(
      t.request(GOOD),
      "acme",
      t.as(await t.person("admin")),
    );

    expect(response.status).toBe(200);
  });

  // #501-T04
  it("answers a Member 403 and stores nothing, calls nobody", async () => {
    const t = await start();

    const response = await t.route.post(
      t.request(GOOD),
      "acme",
      t.as(await t.person("member")),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(await t.intents()).toEqual([]);
    expect(t.fake.requests()).toEqual([]);
    expect(
      await createBillingProfilesRepository(t.db, t.workspaceId).get(),
    ).toMatchObject({ confirmedAt: null });
  });

  // #501-T04
  it("answers a person of another workspace, and nobody signed in, with the refusals of every workspace route and stores nothing", async () => {
    const t = await start();
    const outsider = await t.person("owner", "u-outsider", t.otherWorkspaceId);

    const outside = await t.route.post(t.request(GOOD), "acme", t.as(outsider));
    const anonymous = await t.route.post(
      t.request(GOOD),
      "acme",
      t.as({ kind: "none" }),
    );

    expect(outside.status).toBe(404);
    expect(await outside.json()).toEqual({ error: "not_found" });
    expect(anonymous.status).toBe(401);
    expect(await t.intents()).toEqual([]);
    expect(
      await createBillingTopUpIntentsRepository(t.db, t.otherWorkspaceId).list({
        limit: 10,
      }),
    ).toEqual([]);
    expect(t.fake.requests()).toEqual([]);
  });

  // #501-T04
  it("takes the workspace from the address, never from the body", async () => {
    const t = await start();
    const owner = await t.person("owner");

    const response = await t.route.post(
      t.request({
        ...GOOD,
        workspaceId: t.otherWorkspaceId,
        workspace: "other",
      }),
      "acme",
      t.as(owner),
    );

    expect(response.status).toBe(200);
    expect(await t.intents()).toHaveLength(1);
    expect(
      await createBillingTopUpIntentsRepository(t.db, t.otherWorkspaceId).list({
        limit: 10,
      }),
    ).toEqual([]);
  });

  // #501-T10
  it("is the missing path while billing is off, before anything else is asked", async () => {
    const t = await start({ billingOn: false });
    const withAccess = vi.fn(t.as(await t.person("owner")));

    await expect(
      t.route.post(t.request(GOOD), "acme", withAccess),
    ).rejects.toBeInstanceOf(NotFound);

    expect(withAccess).not.toHaveBeenCalled();
    expect(t.activeAdapter).not.toHaveBeenCalled();
    expect(t.fake.requests()).toEqual([]);
    expect(await t.intents()).toEqual([]);
  });

  // #501-T10
  it("is the missing path when the active adapter is the manual one, or there is none", async () => {
    for (const adapter of ["manual", "none"] as const) {
      const t = await start({ adapter });
      const withAccess = vi.fn(t.as(await t.person("owner")));

      await expect(
        t.route.post(t.request(GOOD), "acme", withAccess),
        adapter,
      ).rejects.toBeInstanceOf(NotFound);

      expect(withAccess).not.toHaveBeenCalled();
      expect(await t.intents()).toEqual([]);
    }
  });

  // #501-T02
  it("answers an amount that is not 10 to 500 USD in cents with 422 and a code, before Stripe", async () => {
    const t = await start();
    const owner = await t.person("owner");

    for (const [amountCents, error] of [
      [999, "amount_out_of_range"],
      [50001, "amount_out_of_range"],
      [0, "amount_out_of_range"],
      [-5, "amount_out_of_range"],
      [25.5, "amount_invalid"],
      ["2500", "amount_invalid"],
      [undefined, "amount_invalid"],
    ] as const) {
      const response = await t.route.post(
        t.request({ amountCents, confirmBusiness: true }),
        "acme",
        t.as(owner),
      );
      expect(response.status, String(amountCents)).toBe(422);
      expect(await response.json(), String(amountCents)).toEqual({ error });
    }
    expect(t.fake.requests()).toEqual([]);
    expect(await t.intents()).toEqual([]);
  });

  // #501-T03
  it("answers 409 when the profile is missing and when the first top-up has no confirmation", async () => {
    const t = await start();
    const owner = await t.person("owner");

    const without = await t.route.post(
      t.request({ amountCents: 2500 }),
      "acme",
      t.as(owner),
    );
    expect(without.status).toBe(409);
    expect(await without.json()).toEqual({
      error: "business_confirmation_required",
    });

    await t.db.deleteFrom("billing_profiles").execute();
    const none = await t.route.post(t.request(GOOD), "acme", t.as(owner));
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: "profile_required" });
    expect(t.fake.requests()).toEqual([]);
  });

  // #501-T07
  it("answers 502 provider_unavailable when Stripe is down, with a code and nothing of Stripe", async () => {
    const t = await start();
    t.fake.faults.failWith(
      { method: "POST", path: "/v1/checkout/sessions" },
      503,
      {
        times: 10,
        body: { error: { message: "secret detail of Stripe" } },
      },
    );

    const response = await t.route.post(
      t.request(GOOD),
      "acme",
      t.as(await t.person("owner")),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "provider_unavailable" });
    expect((await t.intents()).map((i) => i.state)).toEqual(["failed"]);
  });

  // #501-T06
  it("answers the same click twice with the same page", async () => {
    const t = await start();
    const owner = await t.person("owner");
    const intentId = "6f1f4a2e-0c52-4b8e-9a43-0d0f6f1d2a11";

    const first = await t.route.post(
      t.request({ ...GOOD, intentId }),
      "acme",
      t.as(owner),
    );
    const second = await t.route.post(
      t.request({ ...GOOD, intentId }),
      "acme",
      t.as(owner),
    );

    expect(await second.json()).toEqual(await first.json());
    expect(t.fake.checkoutSessions()).toHaveLength(1);
  });

  it("refuses a request from another site, a body that is not JSON, and one that is too large", async () => {
    const t = await start();
    const owner = await t.person("owner");
    const post = (request: Request) =>
      t.route.post(request, "acme", t.as(owner));

    const cross = await post(
      t.request(GOOD, { "sec-fetch-site": "cross-site" }),
    );
    const text = await post(t.request(GOOD, { "content-type": "text/plain" }));
    const broken = await post(t.request("{not json"));
    const array = await post(t.request("[1]"));
    const large = await post(t.request({ ...GOOD, pad: "x".repeat(20_000) }));

    expect([
      cross.status,
      text.status,
      broken.status,
      array.status,
      large.status,
    ]).toEqual([403, 415, 422, 422, 413]);
    expect(await cross.json()).toEqual({ error: "cross_site_request" });
    expect(await t.intents()).toEqual([]);
  });

  // #501-T07
  it("limits the clicks of one person in one workspace, and says when to try again", async () => {
    const t = await start();
    const owner = await t.person("owner");
    const bad = () =>
      t.route.post(t.request({ amountCents: 1 }), "acme", t.as(owner));

    for (let i = 0; i < TOP_UP_REQUESTS_MAX; i += 1)
      expect((await bad()).status).toBe(422);
    const limited = await bad();

    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another person has their own count.
    const admin = await t.person("admin");
    expect(
      (await t.route.post(t.request(GOOD), "acme", t.as(admin))).status,
    ).toBe(200);
  });

  // #501-T09
  it("logs a result and the workspace, and nothing of the request or the answer", async () => {
    const t = await start();
    const response = await t.route.post(
      t.request(GOOD),
      "acme",
      t.as(await t.person("owner")),
    );
    const { url } = (await response.json()) as { url: string };

    const lines = t.logs.join("\n");
    expect(t.logs.length).toBeGreaterThan(0);
    for (const text of [
      "Example GmbH",
      "Teststrasse",
      "DE123456789",
      "2500",
      "25.00",
      url,
      "cs_",
      "cus_",
    ])
      expect(lines, text).not.toContain(text);
  });
});
