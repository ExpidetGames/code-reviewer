// SPDX-License-Identifier: LicenseRef-Proprietary

// #659: `GET /api/w/:workspace/billing/invoices` as the app wires it (guard, access, service), over a real database, the real
// matrix of roles and the fake Stripe: an Owner and an Admin read the invoices of their own workspace's customer, a Member is
// refused, and the invoices of another workspace are never listed.
import { describe, expect, it } from "vitest";
import { createBillingProfilesRepository } from "../db/repositories/billing-profiles-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { signedInMember } from "../test-support/session-lookup.ts";
import { clientFor, startTestStripe } from "../test-support/stripe-fake.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { resolveWorkspaceAccess } from "../workspaces/access.ts";
import { accessRefusal } from "../workspaces/access-response.ts";
import type { WorkspaceRole } from "../workspaces/roles.ts";
import { toUsd, type BillingAdapter } from "./adapter.ts";
import { isBillingOn } from "./enabled.ts";
import { createInvoicesRoute } from "./invoices-http.ts";
import { createInvoicesService } from "./invoices-service.ts";
import { manualAdapter } from "./manual-adapter.ts";
import { createStripeAdapter } from "./stripe-adapter.ts";

class NotFound extends Error {}

const PROFILE = {
  legalName: "Example GmbH",
  country: "DE",
  addressLine1: "Teststrasse 1",
  addressLine2: null,
  postalCode: "10115",
  city: "Berlin",
  vatId: null,
};

async function start(options: { billingOn?: boolean } = {}) {
  const { db } = await createTestDatabase();
  const workspaceId = await addWorkspace(db, "acme");
  const otherWorkspaceId = await addWorkspace(db, "other");
  await setBillingSwitch(db, options.billingOn ?? true);
  const fake = await startTestStripe();
  const stripe = createStripeAdapter({
    client: () => Promise.resolve(clientFor(fake)),
    allowedLinkOrigin: fake.baseUrl,
  });
  let adapter: BillingAdapter = stripe;
  const logs: string[] = [];
  const route = createInvoicesRoute({
    guard: {
      isOn: () => isBillingOn(db),
      notFound: () => {
        throw new NotFound("not found");
      },
    },
    service: createInvoicesService({
      db,
      activeAdapter: () => Promise.resolve(adapter),
      log: (line) => logs.push(line),
    }),
  });
  const workspaces = createWorkspacesRepository(db);
  const as =
    (lookup: Awaited<ReturnType<typeof signedInMember>> | { kind: "none" }) =>
    (handler: Parameters<Parameters<typeof route.get>[2]>[0]) =>
      resolveWorkspaceAccess({
        lookup,
        slug: "acme",
        action: "manage_billing",
        findMembership: (userId, name) =>
          workspaces.findMembership(userId, name),
      }).then((result) =>
        result.kind === "ok" ? handler(result.access) : accessRefusal(result),
      );
  const person = (role: WorkspaceRole, workspace = workspaceId) =>
    signedInMember(db, { id: `u-${role}`, workspaceId: workspace, role });
  /** The workspace gets its Stripe customer the way the first top-up gives it one. */
  async function customerOf(workspace: string): Promise<string> {
    const profiles = createBillingProfilesRepository(db, workspace);
    await profiles.save(PROFILE);
    const customer = await stripe.ensureCustomer({
      workspace: { id: workspace },
      profile: {
        legalName: PROFILE.legalName,
        country: PROFILE.country,
        addressLines: [PROFILE.addressLine1],
        postalCode: PROFILE.postalCode,
        city: PROFILE.city,
        vatId: null,
        locale: "en",
      },
      customer: null,
    });
    if (customer === null) throw new Error("no customer");
    await profiles.setCustomer("stripe", customer);
    return customer;
  }
  /** A top-up of `dollars` that the buyer of `customer` paid at the fake. */
  async function pay(customer: string, intentId: string, dollars: number) {
    const started = await stripe.createTopUpCheckout({
      customer,
      intentId,
      amount: toUsd(dollars * 1_000_000),
      returnUrl: "https://app.example.test/w/acme/settings/billing",
    });
    if (started.session === null) throw new Error("no session");
    fake.buyer.pay(started.session);
  }
  const get = (
    who: Awaited<ReturnType<typeof signedInMember>> | { kind: "none" },
  ) =>
    route.get(
      new Request("https://app.example.test/api/w/acme/billing/invoices"),
      "acme",
      as(who),
    );
  return {
    db,
    workspaceId,
    otherWorkspaceId,
    fake,
    logs,
    person,
    as,
    route,
    customerOf,
    pay,
    get,
    useAdapter: (next: BillingAdapter) => {
      adapter = next;
    },
  };
}

describe("the invoices of a workspace", () => {
  // #659-T01
  it("lists the invoices of a paid top-up for an Owner and for an Admin, with date, amount, status and the addresses", async () => {
    const t = await start();
    const customer = await t.customerOf(t.workspaceId);
    await t.pay(customer, "intent-1", 25);
    await t.pay(customer, "intent-2", 40);

    for (const role of ["owner", "admin"] as const) {
      const answer = await t.get(await t.person(role));
      expect(answer.status).toBe(200);
      expect(answer.headers.get("cache-control")).toBe("no-store");
      const body = (await answer.json()) as {
        invoices: Array<Record<string, unknown>>;
      };
      expect(body.invoices.map((invoice) => invoice.amountMinor)).toEqual([
        4000, 2500,
      ]);
      expect(body.invoices[0]).toMatchObject({
        currency: "usd",
        status: "paid",
        number: expect.stringMatching(/^FAKE-/),
        viewUrl: expect.stringMatching(/^http/),
        downloadUrl: expect.stringMatching(/\/pdf$/),
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    }
  });

  // #659-T02
  it("shows the invoice of a top-up as soon as it is paid, and not before", async () => {
    const t = await start();
    const customer = await t.customerOf(t.workspaceId);
    const owner = await t.person("owner");
    expect(await (await t.get(owner)).json()).toEqual({ invoices: [] });

    await t.pay(customer, "intent-1", 10);

    expect(
      ((await (await t.get(owner)).json()) as { invoices: unknown[] }).invoices,
    ).toHaveLength(1);
  });

  // #659-T03
  it("refuses a Member and a visitor, and asks Stripe for nothing", async () => {
    const t = await start();
    const customer = await t.customerOf(t.workspaceId);
    await t.pay(customer, "intent-1", 10);
    const before = t.fake.requests().length;

    const member = await t.get(await t.person("member"));
    const visitor = await t.get({ kind: "none" });

    expect(member.status).toBe(403);
    expect(visitor.status).toBe(401);
    expect(await member.text()).not.toContain("FAKE-");
    expect(t.fake.requests().length).toBe(before);
  });

  // #659-T03
  // The real route file asks for `manage_billing` in `withWorkspace`; src/admin/portal-guards.test.ts (#501-T04) pins that for it.
  it("refuses a Member at the route even if the service would answer", async () => {
    const t = await start();
    const customer = await t.customerOf(t.workspaceId);
    await t.pay(customer, "intent-1", 10);
    let asked = 0;
    const route = createInvoicesRoute({
      guard: {
        isOn: () => Promise.resolve(true),
        notFound: () => {
          throw new NotFound("x");
        },
      },
      service: {
        list: () => {
          asked += 1;
          return Promise.resolve({ ok: true, list: { invoices: [] } });
        },
      },
    });

    const answer = await route.get(
      new Request("https://app.example.test/api/w/acme/billing/invoices"),
      "acme",
      t.as(await t.person("member")),
    );

    expect(answer.status).toBe(403);
    expect(asked).toBe(0);
  });

  // #659-T03
  it("refuses a Member at the service even when the route's access check is bypassed", async () => {
    const t = await start();
    const customer = await t.customerOf(t.workspaceId);
    await t.pay(customer, "intent-1", 10);
    const before = t.fake.requests().length;
    // A bypassed check hands the handler a Member's access as if it were allowed.
    const member = await t.person("member");
    const answer = await t.route.get(
      new Request("https://app.example.test/api/w/acme/billing/invoices"),
      "acme",
      (handler) =>
        handler({
          workspace: { id: t.workspaceId },
          user: { id: member.user.id },
          role: "member",
        } as never),
    );

    expect(answer.status).toBe(403);
    expect(await answer.json()).toEqual({ error: "forbidden" });
    expect(t.fake.requests().length).toBe(before);
  });

  // #659-T03
  it("never lists the invoices of another workspace, and asks Stripe for the stored customer only", async () => {
    const t = await start();
    const mine = await t.customerOf(t.workspaceId);
    const other = await t.customerOf(t.otherWorkspaceId);
    await t.pay(other, "intent-other", 500);
    await t.pay(mine, "intent-mine", 10);

    const answer = await t.get(await t.person("owner"));

    const body = (await answer.json()) as {
      invoices: Array<{ amountMinor: number }>;
    };
    expect(body.invoices.map((invoice) => invoice.amountMinor)).toEqual([1000]);
    const asked = t.fake.requests().filter((r) => r.path === "/v1/invoices");
    expect(asked.map((r) => r.query.customer)).toEqual([mine]);
  });

  // #659-T03
  it("lists nothing when the stored customer was made at another adapter", async () => {
    const t = await start();
    const customer = await t.customerOf(t.workspaceId);
    await t.pay(customer, "intent-1", 10);
    await createBillingProfilesRepository(t.db, t.workspaceId).setCustomer(
      "manual",
      customer,
    );
    const before = t.fake.requests().length;

    const answer = await t.get(await t.person("owner"));

    expect(await answer.json()).toEqual({ invoices: [] });
    expect(t.fake.requests().length).toBe(before);
  });

  // #659-T04
  it("is an empty list for a workspace that never topped up (no profile, no customer) and makes no call", async () => {
    const t = await start();

    const answer = await t.get(await t.person("owner"));

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ invoices: [] });
    expect(t.fake.requests()).toHaveLength(0);
  });

  // #659-T04
  it("is an empty list on the manual adapter, which has no invoices to list", async () => {
    const t = await start();
    t.useAdapter(manualAdapter);

    const answer = await t.get(await t.person("owner"));

    expect(await answer.json()).toEqual({ invoices: [] });
  });

  // #659-T01
  it("answers 503 provider_unavailable when Stripe fails, without a word of what it said", async () => {
    const t = await start();
    await t.customerOf(t.workspaceId);
    t.fake.faults.failWith({ method: "GET", path: "/v1/invoices" }, 500, {
      times: 10,
    });

    const answer = await t.get(await t.person("owner"));

    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({ error: "provider_unavailable" });
    expect(t.logs.join("\n")).toContain("result=provider_unavailable");
  });

  // #659-T04
  it("is an empty list, logged once with the workspace and a code, when Stripe has no such customer", async () => {
    const t = await start();
    // A customer stored while the instance ran on a test key; the key is a live one now.
    await createBillingProfilesRepository(t.db, t.workspaceId).save(PROFILE);
    await createBillingProfilesRepository(t.db, t.workspaceId).setCustomer(
      "stripe",
      "cus_madeUnderTheTestKey",
    );

    const answer = await t.get(await t.person("owner"));

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ invoices: [] });
    expect(t.logs).toEqual([
      `[billing] INVOICES_LISTED workspace=${t.workspaceId} result=customer_missing`,
    ]);
  });

  // #659-T04
  it("keeps a key Stripe refuses an error: 503 provider_not_configured", async () => {
    const t = await start();
    await t.customerOf(t.workspaceId);
    t.fake.faults.failWith({ method: "GET", path: "/v1/invoices" }, 403);

    const answer = await t.get(await t.person("owner"));

    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({ error: "provider_not_configured" });
  });

  // #659-T03
  it("is the 404 of a path that does not exist while billing is off, before anything is read", async () => {
    const t = await start({ billingOn: false });

    await expect(t.get(await t.person("owner"))).rejects.toBeInstanceOf(
      NotFound,
    );
    expect(t.fake.requests()).toHaveLength(0);
  });
});
