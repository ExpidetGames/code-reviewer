// SPDX-License-Identifier: Apache-2.0

// The billing page of the admin portal end to end over a real database, the real proxy and the real data routes, with the
// fake Stripe as the payment provider (#504): what an admin can save and read back, how the switch is judged, the connection
// check and the webhook endpoint, the rates, the manual credit, that a person who is not an admin reaches nothing, and that no
// credential is in an answer, a page or a log line.
import { sql, type Kysely, type KyselyPlugin } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startStripeFake } from "../../../fakes/stripe/server.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import type { Database } from "../db/schema.ts";
import { createAdminHarness } from "../test-support/admin-harness.ts";
import { describeQuery } from "../test-support/query-hook.ts";
import { cleanUpAfterTest } from "../test-support/test-database.ts";
import { isBillingOn } from "./enabled.ts";
import { runJournalCheckWhileBillingOn } from "./journal-check.ts";
import { STRIPE_MANAGED_PAYMENTS_API_VERSION } from "./stripe-client.ts";
import { STRIPE_WEBHOOK_EVENTS } from "./stripe-webhook-events.ts";
import { createBillingWebhookHandler } from "./webhook-handler.ts";

const MEMBER = { email: "member@example.com", password: "k4Pq-v8Zm2Xw" };
const PUBLIC_URL = "https://reviews.example.test";
const WEBHOOK_URL = `${PUBLIC_URL}/api/billing/webhook`;
/** Made-up numbers; no rate of an operator is in the repository. */
const RATES = {
  factorA: 50_000,
  minuteRateMicroUsd: { diff: 13_000, dynamic: 16_000 },
  diffAiReserveMicroUsd: 150_000,
};
// Built from parts: a live-looking key in the source would be refused by the secret scan of the push.
const LIVE_PREFIX = ["sk", "live", ""].join("_");
const MANUAL_SECRET = "whsec_ManualSecret0123456789abcdef";
const TERMS_URL = "https://example.com/terms";
const PRIVACY_URL = "https://example.com/privacy";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- the shape is asserted field by field

class NotFound extends Error {}

/**
 * The webhook route of billing (`POST /api/billing/webhook`) as the app wires it, over the given database, with the active
 * adapter replaced by a spy: whether the spy is asked tells whether the request got past the switch.
 */
function webhookRoute(db: Kysely<Database>) {
  const activeAdapter = vi.fn(() => Promise.resolve(undefined));
  const handler = createBillingWebhookHandler({
    db,
    guard: {
      isOn: () => isBillingOn(db),
      notFound: () => {
        throw new NotFound("not found");
      },
    },
    activeAdapter,
  });
  return {
    activeAdapter,
    post: () =>
      handler(new Request(WEBHOOK_URL, { method: "POST", body: "{}" })),
  };
}

/** The tables the statements of a run touched. */
function recordTables(tables: string[]): KyselyPlugin {
  return {
    transformQuery({ node }) {
      const table = describeQuery(node).table;
      if (table !== undefined) tables.push(table);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
}

/** A Stripe client's `fetch` that changes the endpoints Stripe lists, the way another dashboard user could have. */
function listingEndpointsAs(change: (endpoint: Json) => Json): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname !== "/v1/webhook_endpoints" || init?.method !== "GET")
      return response;
    const body = (await response.json()) as Json;
    return Response.json(
      { ...body, data: (body.data as Json[]).map(change) },
      { status: response.status },
    );
  };
}

async function start(
  options: {
    publicUrl?: string;
    fakeKey?: string;
    stripeFetch?: typeof fetch;
  } = {},
) {
  const stripe = await startStripeFake(
    options.fakeKey === undefined ? {} : { apiKey: options.fakeKey },
  );
  cleanUpAfterTest(() => stripe.close());
  const portal = await createAdminHarness({
    stripe,
    ...(options.publicUrl === undefined
      ? {}
      : { billingPublicUrl: options.publicUrl }),
    ...(options.stripeFetch === undefined
      ? {}
      : { stripeFetch: options.stripeFetch }),
  });
  const answers: string[] = [];
  const call = async (
    path: string,
    init: {
      method?: string;
      body?: unknown;
      cookies?: typeof portal.adminCookies;
    } = {},
  ) => {
    const response = await portal.visit(path, {
      cookies: portal.adminCookies,
      ...init,
    });
    const text = await response.clone().text();
    answers.push(text);
    return response;
  };
  const put = (body: unknown) =>
    call("/api/admin/billing", { method: "PUT", body });
  const view = async () =>
    (await (await call("/api/admin/billing")).json()) as Json;
  const post = (path: string, body: unknown = {}) =>
    call(`/api/admin/billing${path}`, { method: "POST", body });
  const saveStripe = (body: Record<string, unknown>) => put({ stripe: body });
  const saveRates = (rates: unknown = RATES) => put({ rates });
  const saveLegal = (legal: unknown = { termsUrl: TERMS_URL }) =>
    put({ legal });
  const workspace = async (name = "Acme") => {
    const found = await portal.db
      .insertInto("workspaces")
      .values({
        id: `ws-${name}`,
        name,
        slug: name.toLowerCase(),
        created_by: null,
        created_at: "2026-10-20T08:00:00.000Z",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return found.id;
  };
  return {
    stripe,
    portal,
    answers,
    call,
    put,
    view,
    post,
    saveStripe,
    saveRates,
    saveLegal,
    workspace,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("billing that was never configured", () => {
  // #504-T01
  it("makes no outbound call and reads no billing table when the page is not opened, and the webhook route is a missing path", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const s = await start();
    const tables: string[] = [];
    const route = webhookRoute(s.portal.db.withPlugin(recordTables(tables)));

    await expect(route.post()).rejects.toBeInstanceOf(NotFound);

    expect(await isBillingOn(s.portal.db)).toBe(false);
    expect(
      await createInstanceSettingsRepository(s.portal.db).get(
        "billing_settings",
      ),
    ).toBeUndefined();
    // Past the switch the route would ask for the active adapter; it does not get that far.
    expect(route.activeAdapter).not.toHaveBeenCalled();
    // The one thing read is the switch, an instance setting: no billing table, no secret.
    expect(tables).toEqual(["instance_settings"]);
    expect(spy).not.toHaveBeenCalled();
    expect(s.stripe.requests()).toEqual([]);
  });

  // #504-T01
  it("shows the page's data with nothing configured, off, and calls nobody for it", async () => {
    const s = await start();

    const v = await s.view();

    expect(v).toMatchObject({
      enabled: false,
      on: false,
      adapter: "manual",
      stripe: {
        apiKey: { state: "not_configured" },
        webhookSecret: { state: "not_configured" },
        environment: null,
        checkedAt: null,
      },
      rates: {
        factorA: null,
        diffMinuteRateMicroUsd: null,
        dynamicMinuteRateMicroUsd: null,
        diffAiReserveMicroUsd: null,
      },
      numbers: {
        startCreditMicroUsd: 2_000_000,
        startCreditStored: false,
      },
      workspaces: 1,
      ownKeyWorkspaces: 0,
    });
    expect(v.missing).toEqual([
      "factor_a_missing",
      "minute_rate_diff_missing",
      "minute_rate_dynamic_missing",
      "diff_ai_reserve_missing",
    ]);
    // #626-T17
    expect(v.journalCheck).toEqual({
      state: "never",
      checkedAt: null,
      workspaces: 0,
      inconsistentWorkspaces: 0,
    });
    expect(s.stripe.requests()).toEqual([]);
  });
});

describe("the check of the journal on the page's data", () => {
  // #626-T17
  it("shows the result of the scheduled check: ok, then inconsistent when the cache and the journal are apart", async () => {
    const s = await start();
    await s.saveRates();
    await s.put({ enabled: true });
    const id = await s.workspace("Acme");
    await createBillingJournalRepository(s.portal.db, id).append({
      type: "top_up",
      amountMicroUsd: 5_000_000,
      provider: "manual",
      providerRef: "ref-626",
      refKey: "ref-626",
    });
    const time = new Date("2026-10-21T03:00:00.000Z");

    await runJournalCheckWhileBillingOn(s.portal.db, {
      now: () => time,
      log: { info: () => undefined, error: () => undefined },
    });
    const ok = (await s.view()).journalCheck;
    await sql`update billing_balances set balance_micro_usd = 1 where workspace_id = ${id}`.execute(
      s.portal.db,
    );
    const later = new Date(time.getTime() + 25 * 60 * 60 * 1000);
    await runJournalCheckWhileBillingOn(s.portal.db, {
      now: () => later,
      log: { info: () => undefined, error: () => undefined },
    });
    const broken = (await s.view()).journalCheck;

    expect(ok).toEqual({
      state: "ok",
      checkedAt: "2026-10-21T03:00:00.000Z",
      workspaces: 1,
      inconsistentWorkspaces: 0,
    });
    expect(broken).toEqual({
      state: "inconsistent",
      checkedAt: "2026-10-22T04:00:00.000Z",
      workspaces: 1,
      inconsistentWorkspaces: 1,
    });
  });
});

describe("saving the Stripe credentials", () => {
  // #504-T02
  it("stores them encrypted, and the answers show only that they are set and the last four characters", async () => {
    const s = await start();
    const secret = "whsec_SecretValueForTheTest0123456789";

    const response = await s.saveStripe({
      apiKey: s.stripe.apiKey,
      webhookSecret: secret,
    });

    expect(response.status).toBe(200);
    const v = await s.view();
    expect(v.stripe).toMatchObject({
      apiKey: { state: "configured", lastFour: s.stripe.apiKey.slice(-4) },
      webhookSecret: { state: "configured", lastFour: secret.slice(-4) },
      environment: "test",
    });
    for (const text of s.answers) {
      expect(text).not.toContain(s.stripe.apiKey);
      expect(text).not.toContain(secret);
    }
    const rows = await s.portal.db
      .selectFrom("secrets")
      .selectAll()
      .where("name", "in", ["stripe_api_key", "stripe_webhook_secret"])
      .execute();
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(s.stripe.apiKey);
    expect(JSON.stringify(rows)).not.toContain(secret);
    const used = await s.portal.secrets.use("stripe_api_key");
    expect(used.ok && used.value.reveal()).toBe(s.stripe.apiKey);
  });

  // #504-T02
  it("keeps what is stored for an empty field, and replaces only what is given", async () => {
    const s = await start();
    await s.saveStripe({
      apiKey: s.stripe.apiKey,
      webhookSecret: MANUAL_SECRET,
    });

    const kept = await s.saveStripe({ apiKey: "", webhookSecret: "" });
    const replaced = await s.saveStripe({
      webhookSecret: "whsec_AnotherSecret0123456789abc",
    });

    expect(kept.status).toBe(200);
    expect(replaced.status).toBe(200);
    const key = await s.portal.secrets.use("stripe_api_key");
    expect(key.ok && key.value.reveal()).toBe(s.stripe.apiKey);
    const hook = await s.portal.secrets.use("stripe_webhook_secret");
    expect(hook.ok && hook.value.reveal()).toBe(
      "whsec_AnotherSecret0123456789abc",
    );
  });

  // #504-T02
  it.each([
    [
      "a publishable key",
      { apiKey: "pk_test_0123456789abcdef0123" },
      "apiKey",
      "api_key_invalid",
    ],
    [
      "a restricted key of no environment",
      { apiKey: "rk_0123456789" },
      "apiKey",
      "api_key_invalid",
    ],
    [
      "text with spaces as the webhook secret",
      { webhookSecret: "whsec with spaces" },
      "webhookSecret",
      "webhook_secret_invalid",
    ],
    [
      "a webhook secret that is no secret",
      { webhookSecret: "secret" },
      "webhookSecret",
      "webhook_secret_invalid",
    ],
    ["a number as the key", { apiKey: 5 }, "apiKey", "api_key_invalid"],
  ])(
    "refuses %s with a code and stores nothing",
    async (_name, body, field, code) => {
      const s = await start();

      const response = await s.saveStripe(body);

      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: "invalid_input",
        issues: [{ field, code }],
      });
      expect((await s.view()).stripe.apiKey).toEqual({
        state: "not_configured",
      });
    },
  );

  // #504-T02
  it("forgets a credential on request while billing is off, and the check with the key", async () => {
    const s = await start();
    await s.saveStripe({
      apiKey: s.stripe.apiKey,
      webhookSecret: MANUAL_SECRET,
    });
    await s.post("/check");
    expect((await s.view()).stripe.checkedAt).not.toBeNull();

    const removed = await s.put({ removeSecret: "apiKey" });

    expect(removed.status).toBe(200);
    const v = await s.view();
    expect(v.stripe.apiKey).toEqual({ state: "not_configured" });
    expect(v.stripe.checkedAt).toBeNull();
    expect(v.stripe.webhookSecret.state).toBe("configured");
  });
});

describe("the connection check", () => {
  // #504-T05
  it("passes against the fake, is recorded with its environment, and a new key clears it", async () => {
    const s = await start();
    await s.saveStripe({ apiKey: s.stripe.apiKey });

    const response = await s.post("/check");

    expect(await response.json()).toEqual({ ok: true, environment: "test" });
    expect(s.stripe.requests().map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v1/account",
    ]);
    expect((await s.view()).stripe.checkedAt).not.toBeNull();

    await s.saveStripe({ apiKey: "sk_test_ANewKeyForTheTest0123456789" });

    expect((await s.view()).stripe.checkedAt).toBeNull();
  });

  // #504-T05
  it("gives a stable code for a key Stripe rejects, and records no pass", async () => {
    const s = await start();
    await s.saveStripe({ apiKey: "sk_test_AKeyTheFakeDoesNotKnow0123456" });

    const response = await s.post("/check");

    expect(await response.json()).toEqual({
      ok: false,
      error: "stripe_key_rejected",
    });
    expect((await s.view()).stripe.checkedAt).toBeNull();
  });

  // #504-T05
  it("names a missing key, and tells a Stripe outage and a limit from a rejected key", async () => {
    const s = await start();

    expect(await (await s.post("/check")).json()).toEqual({
      ok: false,
      error: "api_key_missing",
    });
    await s.saveStripe({ apiKey: s.stripe.apiKey });
    s.stripe.faults.failWith({ method: "GET", path: "/v1/account" }, 500, {
      times: 5,
    });
    expect(await (await s.post("/check")).json()).toEqual({
      ok: false,
      error: "stripe_unavailable",
    });
    s.stripe.faults.clear();
    s.stripe.faults.rateLimit(
      { method: "GET", path: "/v1/account" },
      { retryAfterSeconds: 60 },
    );
    expect(await (await s.post("/check")).json()).toEqual({
      ok: false,
      error: "stripe_rate_limited",
    });
  });
});

describe("switching billing on", () => {
  // #504-T03
  it("refuses an empty Stripe setup with every missing item named, and stays off", async () => {
    const s = await start();
    await s.put({ adapter: "stripe" });

    const response = await s.put({ enabled: true });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "billing_not_ready",
      missing: [
        "factor_a_missing",
        "minute_rate_diff_missing",
        "minute_rate_dynamic_missing",
        "diff_ai_reserve_missing",
        "stripe_api_key_missing",
        "stripe_webhook_secret_missing",
        "connection_check_missing",
        "terms_url_missing",
      ],
    });
    expect((await s.view()).enabled).toBe(false);
    expect(await isBillingOn(s.portal.db)).toBe(false);
  });

  // #504-T03
  it("refuses without a passing connection check even when the credentials and rates are set", async () => {
    const s = await start();
    await s.put({ adapter: "stripe" });
    await s.saveLegal();
    await s.saveRates();
    await s.saveStripe({
      apiKey: s.stripe.apiKey,
      webhookSecret: MANUAL_SECRET,
    });

    const response = await s.put({ enabled: true });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "billing_not_ready",
      missing: ["connection_check_missing"],
    });
  });

  // #504-T03
  it.each([
    ["A", { ...RATES, factorA: undefined }, "factor_a_missing"],
    [
      "B for Diff",
      { ...RATES, minuteRateMicroUsd: { dynamic: 16_000 } },
      "minute_rate_diff_missing",
    ],
    [
      "B for Dynamic",
      { ...RATES, minuteRateMicroUsd: { diff: 13_000 } },
      "minute_rate_dynamic_missing",
    ],
  ])("refuses without %s and names only it", async (_name, rates, item) => {
    const s = await start();
    await s.saveRates(
      Object.fromEntries(
        Object.entries(rates).filter(([, value]) => value !== undefined),
      ),
    );

    const response = await s.put({ enabled: true });

    expect(await response.json()).toEqual({
      error: "billing_not_ready",
      missing: [item],
    });
  });

  // #504-T04
  it("switches on with the manual adapter and all rates set, and the switch reader says on", async () => {
    const s = await start();
    await s.saveRates();

    const response = await s.put({ enabled: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      billing: { enabled: true, on: true, adapter: "manual", missing: [] },
    });
    expect(await isBillingOn(s.portal.db)).toBe(true);
    expect(s.stripe.requests()).toEqual([]);
    expect(s.portal.billingLog).toContain(
      "[billing] BILLING_SWITCHED enabled=true",
    );
  });

  // #498-T19
  it("refuses while a Dispatcher without vm_lifecycle claimed within a day, naming it, and switches on once it is gone", async () => {
    const s = await start();
    await s.saveRates();
    const settings = createInstanceSettingsRepository(s.portal.db);
    await settings.set(
      "dispatcher_sightings",
      { withoutVmLifecycleAt: new Date(Date.now() - 60_000).toISOString() },
      null,
    );

    const refused = await s.put({ enabled: true });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "billing_not_ready",
      missing: ["dispatcher_lacks_vm_lifecycle"],
    });
    expect((await s.view()).enabled).toBe(false);
    expect(await isBillingOn(s.portal.db)).toBe(false);

    await settings.set(
      "dispatcher_sightings",
      {
        withoutVmLifecycleAt: new Date(
          Date.now() - 25 * 60 * 60 * 1000,
        ).toISOString(),
      },
      null,
    );

    const allowed = await s.put({ enabled: true });

    expect(allowed.status).toBe(200);
    expect(await isBillingOn(s.portal.db)).toBe(true);
  });

  // #504-T03
  it("switches on with Stripe once the key was checked and the rates and the webhook secret are set", async () => {
    const s = await start();
    await s.put({ adapter: "stripe" });
    await s.saveLegal();
    await s.saveRates();
    await s.saveStripe({
      apiKey: s.stripe.apiKey,
      webhookSecret: MANUAL_SECRET,
    });
    await s.post("/check");
    s.stripe.reset();

    const response = await s.put({ enabled: true });

    expect(response.status).toBe(200);
    expect(await isBillingOn(s.portal.db)).toBe(true);
    // The check is made again when the switch is set: a key revoked in between is found now.
    expect(s.stripe.requests().map((r) => r.path)).toEqual(["/v1/account"]);
  });

  // #504-T03
  it("refuses with the failed check named when the key stopped working since the last check", async () => {
    const s = await start();
    await s.put({ adapter: "stripe" });
    await s.saveLegal();
    await s.saveRates();
    await s.saveStripe({
      apiKey: s.stripe.apiKey,
      webhookSecret: MANUAL_SECRET,
    });
    await s.post("/check");
    s.stripe.faults.failWith({ method: "GET", path: "/v1/account" }, 401, {
      times: 1,
    });

    const response = await s.put({ enabled: true });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "billing_not_ready",
      missing: ["connection_check_failed"],
    });
    expect(await isBillingOn(s.portal.db)).toBe(false);
  });

  // #504-T04
  it("keeps the credentials and the adapter in place while billing is on, and a new key must work first", async () => {
    const s = await start();
    await s.put({ adapter: "stripe" });
    await s.saveLegal();
    await s.saveRates();
    await s.saveStripe({
      apiKey: s.stripe.apiKey,
      webhookSecret: MANUAL_SECRET,
    });
    await s.post("/check");
    await s.put({ enabled: true });

    const refusals = [
      await s.put({ adapter: "manual" }),
      await s.put({ removeSecret: "apiKey" }),
      await s.put({ removeSecret: "webhookSecret" }),
    ];
    const wrong = await s.saveStripe({
      apiKey: "sk_test_ANewKeyTheFakeRejects0123456789",
    });

    for (const response of refusals) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "billing_disable_first",
      });
    }
    expect(wrong.status).toBe(422);
    expect(await wrong.json()).toMatchObject({ error: "stripe_key_rejected" });
    const key = await s.portal.secrets.use("stripe_api_key");
    expect(key.ok && key.value.reveal()).toBe(s.stripe.apiKey);
    expect(await isBillingOn(s.portal.db)).toBe(true);
  });

  // #504-T20
  it("refuses a key of the other environment while billing is on, and keeps the key, the webhook secret and the switch", async () => {
    // The fake accepts one key; the client is made to send it for whatever key the app holds, so the new key passes the check.
    let fakeKey = "";
    const asFakeKey: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${fakeKey}`);
      return fetch(input, { ...init, headers });
    };
    const s = await start({ stripeFetch: asFakeKey });
    fakeKey = s.stripe.apiKey;
    await s.put({ adapter: "stripe" });
    await s.saveLegal();
    await s.saveRates();
    await s.saveStripe({
      apiKey: s.stripe.apiKey,
      webhookSecret: MANUAL_SECRET,
    });
    await s.post("/check");
    await s.put({ enabled: true });
    expect((await s.view()).stripe.environment).toBe("test");

    const response = await s.saveStripe({
      apiKey: `${LIVE_PREFIX}ALiveKeyForTheTest0123456789`,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "billing_disable_first" });
    const v = await s.view();
    expect(v.enabled).toBe(true);
    expect(v.on).toBe(true);
    expect(v.stripe.environment).toBe("test");
    expect(v.stripe.webhookSecret.state).toBe("configured");
    const key = await s.portal.secrets.use("stripe_api_key");
    expect(key.ok && key.value.reveal()).toBe(s.stripe.apiKey);
    const secret = await s.portal.secrets.use("stripe_webhook_secret");
    expect(secret.ok && secret.value.reveal()).toBe(MANUAL_SECRET);
    expect(await isBillingOn(s.portal.db)).toBe(true);
  });

  // #595
  it("refuses a new key that passes the check while billing is on and the stored key cannot be read, and keeps everything", async () => {
    // The fake accepts one key; the client is made to send it for whatever key the app holds, so the new key passes the check.
    let fakeKey = "";
    const asFakeKey: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${fakeKey}`);
      return fetch(input, { ...init, headers });
    };
    const s = await start({ stripeFetch: asFakeKey });
    fakeKey = s.stripe.apiKey;
    await s.put({ adapter: "stripe" });
    await s.saveLegal();
    await s.saveRates();
    await s.saveStripe({
      apiKey: s.stripe.apiKey,
      webhookSecret: MANUAL_SECRET,
    });
    await s.post("/check");
    await s.put({ enabled: true });
    await s.portal.db
      .updateTable("secrets")
      .set({ ciphertext: "AAAA" })
      .where("name", "=", "stripe_api_key")
      .execute();

    const response = await s.saveStripe({
      apiKey: `${LIVE_PREFIX}ALiveKeyForTheTest0123456789`,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "billing_disable_first" });
    const stored = await s.portal.db
      .selectFrom("secrets")
      .select("ciphertext")
      .where("name", "=", "stripe_api_key")
      .executeTakeFirstOrThrow();
    expect(stored.ciphertext).toBe("AAAA");
    const secret = await s.portal.secrets.use("stripe_webhook_secret");
    expect(secret.ok && secret.value.reveal()).toBe(MANUAL_SECRET);
    expect(await isBillingOn(s.portal.db)).toBe(true);
  });

  // #504-T04
  it("lets the rates be changed later while billing is on", async () => {
    const s = await start();
    await s.saveRates();
    await s.put({ enabled: true });

    const response = await s.saveRates({ factorA: 60_000 });

    expect(response.status).toBe(200);
    expect((await s.view()).rates.factorA).toBe(60_000);
    expect((await s.view()).rates.diffMinuteRateMicroUsd).toBe(13_000);
    expect(await isBillingOn(s.portal.db)).toBe(true);
  });
});

describe("switching billing off", () => {
  // #504-T14
  it("is always allowed, makes the routes inert again and leaves the journal and the balances alone", async () => {
    const s = await start();
    await s.saveRates();
    await s.put({ enabled: true });
    const workspaceId = await s.workspace();
    await s.call(`/api/admin/billing/workspaces/${workspaceId}/credit`, {
      method: "POST",
      body: {
        type: "credit",
        amountMicroUsd: 10_000_000,
        note: "gift",
        requestId: "form-gift",
      },
    });
    const journal = createBillingJournalRepository(s.portal.db, workspaceId);
    const before = await journal.entries({ limit: 50 });
    const route = webhookRoute(s.portal.db);
    // While billing is on the request gets past the switch, to the active adapter (the manual one has no webhook: still a 404).
    await expect(route.post()).rejects.toBeInstanceOf(NotFound);
    expect(route.activeAdapter).toHaveBeenCalledTimes(1);

    const response = await s.put({ enabled: false });

    expect(response.status).toBe(200);
    expect(await isBillingOn(s.portal.db)).toBe(false);
    expect((await s.view()).enabled).toBe(false);
    // Inert again: the webhook route answers the missing path without asking for the adapter.
    await expect(route.post()).rejects.toBeInstanceOf(NotFound);
    expect(route.activeAdapter).toHaveBeenCalledTimes(1);
    expect(await journal.entries({ limit: 50 })).toEqual(before);
    expect((await journal.balance()).balanceMicroUsd).toBe(10_000_000);
    // The rates stay for the next time.
    expect((await s.view()).rates.factorA).toBe(50_000);
  });

  // #504-T14
  it("is allowed when billing was never on, and writes nothing", async () => {
    const s = await start();

    const response = await s.put({ enabled: false });

    expect(response.status).toBe(200);
    expect(
      await createInstanceSettingsRepository(s.portal.db).get(
        "billing_settings",
      ),
    ).toBeUndefined();
  });
});

describe("the webhook endpoint at Stripe", () => {
  // #504-T06
  it("sends the app's address and the handled events, stores the returned secret, and a second click adopts the endpoint", async () => {
    const s = await start();
    await s.saveStripe({ apiKey: s.stripe.apiKey });

    const first = await s.post("/webhook-endpoint");

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, created: true });
    const [endpoint] = s.stripe.webhookEndpoints();
    expect(s.stripe.webhookEndpoints()).toHaveLength(1);
    expect(endpoint).toMatchObject({
      url: WEBHOOK_URL,
      enabled_events: [...STRIPE_WEBHOOK_EVENTS],
    });
    const created = s.stripe.requests().find((r) => r.method === "POST");
    expect(created?.form).toMatchObject({
      url: WEBHOOK_URL,
      enabled_events: [...STRIPE_WEBHOOK_EVENTS],
    });
    const stored = await s.portal.secrets.use("stripe_webhook_secret");
    expect(stored.ok && stored.value.reveal()).toBe(
      s.stripe.secretOf(String(endpoint?.id)),
    );
    const v = await s.view();
    expect(v.stripe.webhookSecret.state).toBe("configured");
    expect(v.stripe.webhookEndpointId).toBe(endpoint?.id);

    const second = await s.post("/webhook-endpoint");

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, created: false });
    expect(s.stripe.webhookEndpoints()).toHaveLength(1);
    const key = await s.portal.secrets.use("stripe_webhook_secret");
    expect(key.ok && key.value.reveal()).toBe(
      stored.ok && stored.value.reveal(),
    );
  });

  // #501-X01: the follow-up of #500 (pull request 587): the events are rendered in the version the API calls use, whatever the
  // account's default becomes, so the event shape #502 reads is pinned.
  it("pins the API version the events are rendered in to the version of the client", async () => {
    const s = await start();
    await s.saveStripe({ apiKey: s.stripe.apiKey });

    await s.post("/webhook-endpoint");

    const created = s.stripe.requests().find((r) => r.method === "POST");
    expect(created?.form).toMatchObject({
      api_version: STRIPE_MANAGED_PAYMENTS_API_VERSION,
    });
    expect(s.stripe.webhookEndpoints()[0]).toMatchObject({
      api_version: STRIPE_MANAGED_PAYMENTS_API_VERSION,
    });
  });

  // #504-T06
  it("sends the idempotency key of a create, so a repeated call is one endpoint", async () => {
    const s = await start();
    await s.saveStripe({ apiKey: s.stripe.apiKey });

    await s.post("/webhook-endpoint");

    const create = s.stripe.requests().find((r) => r.method === "POST");
    expect(create?.headers.idempotencyKey).toMatch(/\S+/);
  });

  // #504-T06
  it("says the secret is unknown when Stripe has an endpoint of the address and no secret is stored, and recreating replaces it", async () => {
    const s = await start();
    await s.saveStripe({ apiKey: s.stripe.apiKey });
    await s.post("/webhook-endpoint");
    await s.put({ removeSecret: "webhookSecret" });

    const adopt = await s.post("/webhook-endpoint");
    const recreate = await s.post("/webhook-endpoint", { recreate: true });

    expect(adopt.status).toBe(409);
    expect(await adopt.json()).toEqual({
      error: "webhook_endpoint_secret_unknown",
    });
    expect(recreate.status).toBe(200);
    expect(await recreate.json()).toMatchObject({ ok: true, created: true });
    expect(s.stripe.webhookEndpoints()).toHaveLength(1);
    expect((await s.view()).stripe.webhookSecret.state).toBe("configured");
  });

  // #504-T06
  it("does not replace the endpoint while billing is on", async () => {
    const s = await start();
    await s.put({ adapter: "stripe" });
    await s.saveLegal();
    await s.saveRates();
    await s.saveStripe({ apiKey: s.stripe.apiKey });
    await s.post("/webhook-endpoint");
    await s.post("/check");
    await s.put({ enabled: true });

    const response = await s.post("/webhook-endpoint", { recreate: true });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "billing_disable_first" });
    expect(s.stripe.webhookEndpoints()).toHaveLength(1);
  });

  describe("adopting the endpoint that Stripe already has for the address", () => {
    const withEndpoint = async (change: (endpoint: Json) => Json) => {
      let tamper: (endpoint: Json) => Json = (endpoint) => endpoint;
      const s = await start({
        stripeFetch: listingEndpointsAs((endpoint) => tamper(endpoint)),
      });
      await s.saveStripe({ apiKey: s.stripe.apiKey });
      await s.post("/webhook-endpoint");
      tamper = change;
      return { s, made: s.stripe.requests().length };
    };
    const fewer = STRIPE_WEBHOOK_EVENTS.slice(1);

    // #504-T18
    it.each([
      ["switched off at Stripe", { status: "disabled" }],
      [
        "subscribed to fewer events than billing handles",
        { enabled_events: fewer },
      ],
      ["subscribed to no event", { enabled_events: [] }],
      ["subscribed to others only", { enabled_events: ["customer.created"] }],
    ])(
      "refuses an endpoint that is %s, and changes nothing",
      async (_name, patch) => {
        const { s, made } = await withEndpoint((endpoint) => ({
          ...endpoint,
          ...patch,
        }));
        const before = await s.view();

        const response = await s.post("/webhook-endpoint");

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: "webhook_endpoint_unusable",
        });
        expect(
          s.stripe
            .requests()
            .slice(made)
            .map((r) => r.method),
        ).toEqual(["GET"]);
        expect((await s.view()).stripe).toEqual(before.stripe);
      },
    );

    // #504-T18
    it.each([
      ["every event", ["*"]],
      [
        "the handled events and more",
        [...STRIPE_WEBHOOK_EVENTS, "customer.created"],
      ],
    ])(
      "adopts an enabled endpoint that is subscribed to %s",
      async (_name, events) => {
        const { s } = await withEndpoint((endpoint) => ({
          ...endpoint,
          enabled_events: events,
        }));

        const response = await s.post("/webhook-endpoint");

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          ok: true,
          created: false,
        });
      },
    );

    // #504-T18
    it("lets the admin replace such an endpoint while billing is off", async () => {
      const { s } = await withEndpoint((endpoint) => ({
        ...endpoint,
        status: "disabled",
      }));

      const response = await s.post("/webhook-endpoint", { recreate: true });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, created: true });
      expect(s.stripe.webhookEndpoints()).toHaveLength(1);
    });
  });

  // #504-T06
  it("makes one creation at a time through a lease", async () => {
    const s = await start();
    await s.saveStripe({ apiKey: s.stripe.apiKey });
    await createInstanceSettingsRepository(s.portal.db).set(
      "billing_destination_lock",
      { startedAt: new Date().toISOString() },
      null,
    );

    const response = await s.post("/webhook-endpoint");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "webhook_endpoint_in_progress",
    });
    expect(s.stripe.webhookEndpoints()).toEqual([]);
  });

  // #504-T06
  it("releases the lease after the creation, also when Stripe fails", async () => {
    const s = await start();
    await s.saveStripe({ apiKey: s.stripe.apiKey });
    s.stripe.faults.failWith(
      { method: "POST", path: "/v1/webhook_endpoints" },
      500,
      {
        times: 5,
      },
    );

    const failed = await s.post("/webhook-endpoint");
    s.stripe.faults.clear();
    const again = await s.post("/webhook-endpoint");

    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "stripe_unavailable" });
    expect(again.status).toBe(200);
  });

  // #504-T06
  it("asks for the API key first", async () => {
    const s = await start();

    const response = await s.post("/webhook-endpoint");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "api_key_missing" });
  });

  // #504-T07
  it.each([
    ["plain http", "http://reviews.example.test"],
    ["localhost", "https://localhost"],
    ["a private address", "https://192.168.1.10"],
    ["a loopback address", "https://127.0.0.1:3000"],
    ["a local name", "https://reviews.local"],
    ["a name with one label", "https://intranet"],
  ])("refuses %s before any call to Stripe", async (_name, publicUrl) => {
    const s = await start({ publicUrl });
    await s.saveStripe({ apiKey: s.stripe.apiKey });

    const response = await s.post("/webhook-endpoint");

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "webhook_url_not_public" });
    expect(s.stripe.requests()).toEqual([]);
    expect((await s.view()).stripe.webhookUrlPublic).toBe(false);
  });

  // #504-T08
  it("refuses a test key whose endpoint Stripe made in live mode, removes that endpoint and stores no secret", async () => {
    const asLive: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== "/v1/webhook_endpoints" || init?.method !== "POST")
        return response;
      const body = (await response.json()) as Record<string, unknown>;
      return Response.json(
        { ...body, livemode: true },
        { status: response.status },
      );
    };
    const s = await start({ stripeFetch: asLive });
    await s.saveStripe({ apiKey: s.stripe.apiKey });

    const response = await s.post("/webhook-endpoint");

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "webhook_environment_mismatch",
    });
    expect(s.stripe.webhookEndpoints()).toEqual([]);
    expect((await s.view()).stripe.webhookSecret.state).toBe("not_configured");
  });

  // #504-T08
  it("refuses a live key whose endpoint is in test mode", async () => {
    const s = await start({
      fakeKey: `${LIVE_PREFIX}FakeLiveKeyForTests0000000`,
    });
    await s.saveStripe({ apiKey: s.stripe.apiKey });
    expect((await s.view()).stripe.environment).toBe("live");

    const response = await s.post("/webhook-endpoint");

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "webhook_environment_mismatch",
    });
    expect(s.stripe.webhookEndpoints()).toEqual([]);
    expect((await s.view()).stripe.webhookSecret.state).toBe("not_configured");
  });

  // #504-T08
  it("forgets a webhook secret and an endpoint of the other environment when a key of the other environment comes", async () => {
    const s = await start();
    await s.saveStripe({ apiKey: s.stripe.apiKey });
    await s.post("/webhook-endpoint");
    expect((await s.view()).stripe.webhookEndpointId).not.toBeNull();

    const response = await s.saveStripe({
      apiKey: `${LIVE_PREFIX}ALiveKeyForTheTest0123456789`,
    });

    expect(response.status).toBe(200);
    const v = await s.view();
    expect(v.stripe.environment).toBe("live");
    expect(v.stripe.webhookSecret.state).toBe("not_configured");
    expect(v.stripe.webhookEndpointId).toBeNull();
  });
});

describe("the links to the terms and the privacy statement", () => {
  const settingsOf = (db: Kysely<Database>) =>
    createInstanceSettingsRepository(db).get("billing_settings");

  // #626-T04
  it("stores both links, shows them in the page's data, and keeps the rest of the setting", async () => {
    const s = await start();
    await s.saveRates();

    const response = await s.saveLegal({
      termsUrl: TERMS_URL,
      privacyUrl: PRIVACY_URL,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      billing: { legal: { termsUrl: TERMS_URL, privacyUrl: PRIVACY_URL } },
    });
    expect(await settingsOf(s.portal.db)).toMatchObject({
      enabled: false,
      ...RATES,
      legal: { termsUrl: TERMS_URL, privacyUrl: PRIVACY_URL },
    });
    expect((await s.view()).legal).toEqual({
      termsUrl: TERMS_URL,
      privacyUrl: PRIVACY_URL,
    });
    expect(s.stripe.requests()).toEqual([]);
  });

  // #626-T04
  it("shows no link before one is saved", async () => {
    const s = await start();

    expect((await s.view()).legal).toEqual({
      termsUrl: null,
      privacyUrl: null,
    });
  });

  // #626-T04
  it("trims the text, changes one link and leaves the other, and removes a link with an empty text or null", async () => {
    const s = await start();
    await s.saveLegal({ termsUrl: ` ${TERMS_URL} `, privacyUrl: PRIVACY_URL });

    await s.saveLegal({ privacyUrl: "https://example.com/privacy-2" });
    expect((await s.view()).legal).toEqual({
      termsUrl: TERMS_URL,
      privacyUrl: "https://example.com/privacy-2",
    });

    await s.saveLegal({ privacyUrl: "" });
    expect((await s.view()).legal).toEqual({
      termsUrl: TERMS_URL,
      privacyUrl: null,
    });

    await s.saveLegal({ termsUrl: null });
    expect((await s.view()).legal).toEqual({
      termsUrl: null,
      privacyUrl: null,
    });
    expect(await settingsOf(s.portal.db)).not.toHaveProperty("legal");
  });

  // #626-T04
  it.each([
    ["http", "http://example.com/terms"],
    ["a script", "javascript:alert(1)"],
    ["credentials", "https://user:secret@example.com/terms"],
    ["a private host", "https://10.0.0.5/terms"],
    ["a loopback name", "https://localhost/terms"],
    ["text that is no address", "terms"],
    ["a space inside", "https://example.com/my terms"],
    ["more than 2048 characters", `https://example.com/${"a".repeat(2048)}`],
    ["a number", 5],
  ])(
    "refuses %s as the terms link with the field named, and writes nothing",
    async (_name, value) => {
      const s = await start();
      await s.saveLegal({ termsUrl: TERMS_URL });
      const before = await settingsOf(s.portal.db);

      const response = await s.saveLegal({ termsUrl: value });

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "invalid_input",
        issues: [{ field: "legal.termsUrl", code: "url_invalid" }],
      });
      expect(await settingsOf(s.portal.db)).toEqual(before);
    },
  );

  // #626-T04
  it("names both fields when both links are refused, and stores neither when only one is", async () => {
    const s = await start();

    const both = await s.saveLegal({
      termsUrl: "http://example.com/terms",
      privacyUrl: "https://localhost/privacy",
    });
    const one = await s.saveLegal({
      termsUrl: TERMS_URL,
      privacyUrl: "ftp://example.com/privacy",
    });

    expect(await both.json()).toEqual({
      error: "invalid_input",
      issues: [
        { field: "legal.termsUrl", code: "url_invalid" },
        { field: "legal.privacyUrl", code: "url_invalid" },
      ],
    });
    expect(one.status).toBe(422);
    expect(await settingsOf(s.portal.db)).toBeUndefined();
  });

  // #626-T04
  it.each([
    ["a text", "https://example.com/terms"],
    ["a list", []],
    ["null", null],
    [
      "a field it does not know",
      { termsUrl: TERMS_URL, imprintUrl: TERMS_URL },
    ],
  ])("refuses %s in place of the links", async (_name, legal) => {
    const s = await start();

    const response = await s.saveLegal(legal);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "legal", code: "body_invalid" }],
    });
    expect(await settingsOf(s.portal.db)).toBeUndefined();
  });

  // #626-T05
  it("refuses switching billing on with the Stripe adapter without the terms link, naming it alone", async () => {
    const s = await start();
    await s.put({ adapter: "stripe" });
    await s.saveRates();
    await s.saveStripe({
      apiKey: s.stripe.apiKey,
      webhookSecret: MANUAL_SECRET,
    });
    await s.post("/check");
    // The privacy link alone does not make it ready.
    await s.saveLegal({ privacyUrl: PRIVACY_URL });

    const refused = await s.put({ enabled: true });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "billing_not_ready",
      missing: ["terms_url_missing"],
    });
    expect(await isBillingOn(s.portal.db)).toBe(false);
    expect((await s.view()).missing).toEqual(["terms_url_missing"]);

    await s.saveLegal({ termsUrl: TERMS_URL });
    const switched = await s.put({ enabled: true });

    expect(switched.status).toBe(200);
    expect(await isBillingOn(s.portal.db)).toBe(true);
  });

  // #626-T05
  it("switches on with the manual adapter without any link", async () => {
    const s = await start();
    await s.saveRates();

    const response = await s.put({ enabled: true });

    expect(response.status).toBe(200);
    expect((await s.view()).legal).toEqual({
      termsUrl: null,
      privacyUrl: null,
    });
    expect(await isBillingOn(s.portal.db)).toBe(true);
  });

  // #626-T06
  it("keeps the terms link while billing is on with Stripe, and still lets it be changed and the privacy link be removed", async () => {
    const s = await start();
    await s.put({ adapter: "stripe" });
    await s.saveRates();
    await s.saveStripe({
      apiKey: s.stripe.apiKey,
      webhookSecret: MANUAL_SECRET,
    });
    await s.post("/check");
    await s.saveLegal({ termsUrl: TERMS_URL, privacyUrl: PRIVACY_URL });
    await s.put({ enabled: true });

    const removal = await s.saveLegal({ termsUrl: "" });
    const change = await s.saveLegal({
      termsUrl: "https://example.com/terms-2",
      privacyUrl: null,
    });

    expect(removal.status).toBe(409);
    expect(await removal.json()).toMatchObject({
      error: "billing_disable_first",
    });
    expect(change.status).toBe(200);
    expect((await s.view()).legal).toEqual({
      termsUrl: "https://example.com/terms-2",
      privacyUrl: null,
    });
    expect(await isBillingOn(s.portal.db)).toBe(true);
  });

  // #626-T06
  it("lets the terms link be removed while billing is on with the manual adapter", async () => {
    const s = await start();
    await s.saveRates();
    await s.saveLegal();
    await s.put({ enabled: true });

    const response = await s.saveLegal({ termsUrl: null });

    expect(response.status).toBe(200);
    expect(await isBillingOn(s.portal.db)).toBe(true);
  });
});

describe("the rates and the numbers", () => {
  // #504-T09
  it("stores A, both B, the reserve, the start credit, the threshold and the brake, and reads them back", async () => {
    const s = await start();

    const response = await s.saveRates({
      ...RATES,
      startCreditMicroUsd: 3_500_000,
      lowBalanceMicroUsd: 7_000_000,
      hourlyReviewLimit: 30,
    });

    expect(response.status).toBe(200);
    const v = await s.view();
    expect(v.rates).toEqual({
      factorA: 50_000,
      diffMinuteRateMicroUsd: 13_000,
      dynamicMinuteRateMicroUsd: 16_000,
      diffAiReserveMicroUsd: 150_000,
    });
    expect(v.numbers).toEqual({
      startCreditMicroUsd: 3_500_000,
      lowBalanceMicroUsd: 7_000_000,
      hourlyReviewLimit: 30,
      startCreditStored: true,
      lowBalanceStored: true,
      hourlyReviewLimitStored: true,
    });
    const stored = await createInstanceSettingsRepository(s.portal.db).get(
      "billing_settings",
    );
    expect(stored).toMatchObject({
      factorA: 50_000,
      minuteRateMicroUsd: { diff: 13_000, dynamic: 16_000 },
      startCreditMicroUsd: 3_500_000,
    });
  });

  // #504-T09
  it("changes one field later and leaves the others, the switch and the adapter as they are", async () => {
    const s = await start();
    await s.put({ adapter: "stripe" });
    await s.saveRates();
    await s.saveRates({ minuteRateMicroUsd: { dynamic: 20_000 } });

    const v = await s.view();

    expect(v.adapter).toBe("stripe");
    expect(v.rates).toMatchObject({
      factorA: 50_000,
      diffMinuteRateMicroUsd: 13_000,
      dynamicMinuteRateMicroUsd: 20_000,
    });
  });

  // #504-T09
  it("takes 0 as the start credit, which switches the grant off, and keeps it stored as 0", async () => {
    const s = await start();

    await s.saveRates({ startCreditMicroUsd: 0 });

    expect((await s.view()).numbers).toMatchObject({
      startCreditMicroUsd: 0,
      startCreditStored: true,
    });
  });

  // #504-T09
  it.each([
    [{ factorA: 100 }, "factor_invalid", "factorA"],
    [{ factorA: 1.5 }, "factor_invalid", "factorA"],
    [
      { minuteRateMicroUsd: { diff: -1 } },
      "rate_invalid",
      "minuteRateMicroUsd.diff",
    ],
    [
      { minuteRateMicroUsd: { dynamic: "x" } },
      "rate_invalid",
      "minuteRateMicroUsd.dynamic",
    ],
    [
      { diffAiReserveMicroUsd: 60_000_000 },
      "reserve_invalid",
      "diffAiReserveMicroUsd",
    ],
    [
      { startCreditMicroUsd: -5 },
      "start_credit_invalid",
      "startCreditMicroUsd",
    ],
    [{ lowBalanceMicroUsd: 1.5 }, "low_balance_invalid", "lowBalanceMicroUsd"],
    [{ hourlyReviewLimit: 0 }, "hourly_limit_invalid", "hourlyReviewLimit"],
  ])("refuses %j with %s and stores nothing", async (rates, code, field) => {
    const s = await start();
    await s.saveRates();

    const response = await s.saveRates(rates);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_input",
      issues: [{ field, code }],
    });
    expect((await s.view()).rates.factorA).toBe(50_000);
  });
});

describe("the manual credit and correction", () => {
  let requests = 0;
  /** The form always sends a request id; a test that wants none says `requestId: undefined`. */
  const credit = (
    s: Awaited<ReturnType<typeof start>>,
    workspaceId: string,
    body: Record<string, unknown>,
  ) =>
    s.call(`/api/admin/billing/workspaces/${workspaceId}/credit`, {
      method: "POST",
      body: { requestId: `form-${(requests += 1)}`, ...body },
    });

  // #504-T10
  it("writes a credit of 10 and a correction of -2 as two entries with the admin and the note, and the balance is 8", async () => {
    const s = await start();
    const workspaceId = await s.workspace();

    const granted = await credit(s, workspaceId, {
      type: "credit",
      amountMicroUsd: 10_000_000,
      note: "Pilot customer",
    });
    const corrected = await credit(s, workspaceId, {
      type: "correction",
      amountMicroUsd: -2_000_000,
      note: "Refunded outside Stripe",
    });

    expect(granted.status).toBe(200);
    expect(corrected.status).toBe(200);
    const journal = createBillingJournalRepository(s.portal.db, workspaceId);
    const { entries } = await journal.entries({ limit: 10 });
    expect(entries.map((e) => [e.type, e.amountMicroUsd])).toEqual([
      ["correction", -2_000_000],
      ["top_up", 10_000_000],
    ]);
    for (const entry of entries) {
      expect(entry.actorUserId).toBe(s.portal.adminId);
      expect(entry.provider).toBe("manual");
    }
    expect(entries.map((e) => e.note)).toEqual([
      "Refunded outside Stripe",
      "Pilot customer",
    ]);
    expect((await journal.balance()).balanceMicroUsd).toBe(8_000_000);
    const shown = (await (
      await s.call(`/api/admin/billing/workspaces/${workspaceId}`)
    ).json()) as Json;
    expect(shown).toMatchObject({
      workspace: { id: workspaceId, name: "Acme" },
      balanceMicroUsd: 8_000_000,
    });
    expect(shown.entries).toHaveLength(2);
    expect(shown.entries[0]).toMatchObject({
      type: "correction",
      amountMicroUsd: -2_000_000,
      note: "Refunded outside Stripe",
    });
  });

  // #504-T10
  it("refuses a credit without a note, and writes nothing", async () => {
    const s = await start();
    const workspaceId = await s.workspace();

    const response = await credit(s, workspaceId, {
      type: "credit",
      amountMicroUsd: 10_000_000,
      note: "   ",
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "note", code: "note_required" }],
    });
    const journal = createBillingJournalRepository(s.portal.db, workspaceId);
    expect((await journal.entries({ limit: 10 })).entries).toEqual([]);
  });

  // #504-T10
  it.each([
    [
      { type: "credit", amountMicroUsd: -1_000_000, note: "x" },
      "amountMicroUsd",
      "amount_invalid",
    ],
    [
      { type: "credit", amountMicroUsd: 0, note: "x" },
      "amountMicroUsd",
      "amount_invalid",
    ],
    [
      { type: "correction", amountMicroUsd: 0, note: "x" },
      "amountMicroUsd",
      "amount_invalid",
    ],
    [
      { type: "credit", amountMicroUsd: 1.5, note: "x" },
      "amountMicroUsd",
      "amount_invalid",
    ],
    [
      { type: "credit", amountMicroUsd: "10", note: "x" },
      "amountMicroUsd",
      "amount_invalid",
    ],
    [
      { type: "credit", amountMicroUsd: 20_000_000_000, note: "x" },
      "amountMicroUsd",
      "amount_out_of_range",
    ],
    [
      { type: "gift", amountMicroUsd: 1_000_000, note: "x" },
      "type",
      "type_invalid",
    ],
    [
      { type: "credit", amountMicroUsd: 1_000_000, note: "x".repeat(501) },
      "note",
      "note_too_long",
    ],
    [
      {
        type: "credit",
        amountMicroUsd: 1_000_000,
        note: "x",
        requestId: "no spaces",
      },
      "requestId",
      "request_id_invalid",
    ],
  ])("refuses %j", async (body, field, code) => {
    const s = await start();
    const workspaceId = await s.workspace();

    const response = await credit(s, workspaceId, body);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_input",
      issues: [{ field, code }],
    });
  });

  // #504-T10
  it("makes one entry for one request id however often it is submitted, and refuses the same id with another amount", async () => {
    const s = await start();
    const workspaceId = await s.workspace();
    const body = {
      type: "credit",
      amountMicroUsd: 5_000_000,
      note: "once",
      requestId: "form-token-1",
    };

    await credit(s, workspaceId, body);
    await credit(s, workspaceId, body);
    const conflict = await credit(s, workspaceId, {
      ...body,
      amountMicroUsd: 6_000_000,
    });

    const journal = createBillingJournalRepository(s.portal.db, workspaceId);
    expect((await journal.entries({ limit: 10 })).entries).toHaveLength(1);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "request_conflict" });
  });

  // #504-T21
  it("requires a request id and writes nothing without one, so a retry cannot double a credit", async () => {
    const s = await start();
    const workspaceId = await s.workspace();
    const body = {
      type: "credit",
      amountMicroUsd: 5_000_000,
      note: "once",
      requestId: undefined,
    };

    const first = await credit(s, workspaceId, body);
    const retry = await credit(s, workspaceId, body);

    for (const response of [first, retry]) {
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "invalid_input",
        issues: [{ field: "requestId", code: "request_id_required" }],
      });
    }
    const journal = createBillingJournalRepository(s.portal.db, workspaceId);
    expect((await journal.entries({ limit: 10 })).entries).toEqual([]);
  });

  // #504-T21
  it("makes one entry when the same request with its request id is retried", async () => {
    const s = await start();
    const workspaceId = await s.workspace();
    const body = {
      type: "credit",
      amountMicroUsd: 5_000_000,
      note: "once",
      requestId: "form-token-retry",
    };

    const first = await credit(s, workspaceId, body);
    const retry = await credit(s, workspaceId, body);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    const journal = createBillingJournalRepository(s.portal.db, workspaceId);
    expect((await journal.entries({ limit: 10 })).entries).toHaveLength(1);
    expect((await journal.balance()).balanceMicroUsd).toBe(5_000_000);
  });

  // #504-T10
  it("answers a workspace that does not exist with workspace_not_found", async () => {
    const s = await start();

    const credited = await credit(s, "missing", {
      type: "credit",
      amountMicroUsd: 1_000_000,
      note: "x",
    });
    const shown = await s.call("/api/admin/billing/workspaces/missing");

    expect(credited.status).toBe(404);
    expect(await credited.json()).toEqual({ error: "workspace_not_found" });
    expect(shown.status).toBe(404);
  });

  // #504-T10
  it("works with either adapter, and while billing is off", async () => {
    const s = await start();
    const workspaceId = await s.workspace();
    await s.put({ adapter: "stripe" });

    const response = await credit(s, workspaceId, {
      type: "credit",
      amountMicroUsd: 2_000_000,
      note: "while off",
    });

    expect(response.status).toBe(200);
    expect(s.stripe.requests()).toEqual([]);
  });

  // #504-T10
  it("finds a workspace by a part of its name", async () => {
    const s = await start();
    await s.workspace("Acme");
    await s.workspace("Beta");

    const found = (await (
      await s.call("/api/admin/billing/workspaces?q=acm")
    ).json()) as Json;
    const none = (await (
      await s.call("/api/admin/billing/workspaces?q=zzz")
    ).json()) as Json;

    expect(found.workspaces).toEqual([
      { id: "ws-Acme", name: "Acme", slug: "acme" },
    ]);
    expect(none.workspaces).toEqual([]);
  });

  // #504-T10
  it("logs a manual credit by workspace and entry id, never the note", async () => {
    const s = await start();
    const workspaceId = await s.workspace();

    await credit(s, workspaceId, {
      type: "credit",
      amountMicroUsd: 1_000_000,
      note: "A secret remark",
    });

    expect(s.portal.billingCreditLog).toHaveLength(1);
    expect(s.portal.billingCreditLog.join("\n")).not.toContain(
      "A secret remark",
    );
  });
});

describe("who may use the billing routes", () => {
  const ROUTES: Array<[string, string, unknown?]> = [
    ["GET", "/api/admin/billing"],
    ["PUT", "/api/admin/billing", { enabled: false }],
    // #626-T09
    [
      "PUT",
      "/api/admin/billing",
      { legal: { termsUrl: "https://example.com/terms" } },
    ],
    ["POST", "/api/admin/billing/check", {}],
    ["POST", "/api/admin/billing/webhook-endpoint", {}],
    ["GET", "/api/admin/billing/workspaces?q=a"],
    ["GET", "/api/admin/billing/workspaces/ws-1"],
    [
      "POST",
      "/api/admin/billing/workspaces/ws-1/credit",
      { type: "credit", amountMicroUsd: 1_000_000, note: "x" },
    ],
  ];

  // #504-T11
  it("answers nobody without a session with 401, and never reaches the service", async () => {
    const s = await start();

    for (const [method, path, body] of ROUTES) {
      const response = await s.portal.visit(path, { method, body });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    expect(s.stripe.requests()).toEqual([]);
  });

  // #504-T11
  it("answers a member who is not an admin like a path that does not exist", async () => {
    const s = await start();
    await s.portal.createUser({ id: "member", ...MEMBER });
    const cookies = await s.portal.signIn(MEMBER.email, MEMBER.password);

    for (const [method, path, body] of ROUTES) {
      const response = await s.portal.visit(path, { method, body, cookies });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(response.headers.get("x-answer-of-a-missing-path")).toBe("1");
    }
    expect(s.stripe.requests()).toEqual([]);
    expect(
      await createInstanceSettingsRepository(s.portal.db).get(
        "billing_settings",
      ),
    ).toBeUndefined();
  });

  // #504-T11
  it("refuses a cross-site write and a body that is not JSON, and an unknown or doubled change", async () => {
    const s = await start();

    const cross = await s.portal.visit("/api/admin/billing", {
      method: "PUT",
      body: { enabled: false },
      cookies: s.portal.adminCookies,
      headers: {
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
      },
    });
    const text = await s.portal.visit("/api/admin/billing", {
      method: "PUT",
      body: "enabled=false",
      cookies: s.portal.adminCookies,
      headers: { "content-type": "text/plain" },
    });
    const doubled = await s.put({ enabled: false, adapter: "manual" });
    const unknown = await s.put({ price: 1 });

    expect(cross.status).toBe(403);
    expect(await cross.json()).toEqual({ error: "cross_site_request" });
    expect(text.status).toBe(415);
    expect(doubled.status).toBe(422);
    expect(unknown.status).toBe(422);
  });

  // #504-T11
  it("sends no-store with every answer", async () => {
    const s = await start();
    const workspaceId = await s.workspace();

    const responses = [
      await s.call("/api/admin/billing"),
      await s.put({ enabled: true }),
      await s.put({ rates: {} }),
      await s.post("/check"),
      await s.call("/api/admin/billing/workspaces?q=a"),
      await s.call(`/api/admin/billing/workspaces/${workspaceId}`),
    ];

    for (const response of responses)
      expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("what is never in an answer or a log", () => {
  // #504-T12
  it("keeps the API key and the webhook secret out of every answer, the page data and every log line of a whole journey", async () => {
    const lines: string[] = [];
    for (const name of ["info", "warn", "error", "log"] as const)
      vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    const s = await start();
    const secret = "whsec_JourneySecret0123456789abcdef";
    await s.put({ adapter: "stripe" });
    await s.saveRates();
    await s.saveStripe({ apiKey: s.stripe.apiKey, webhookSecret: secret });
    await s.post("/check");
    await s.saveStripe({ apiKey: "sk_test_ARejectedKey0123456789012345" });
    await s.post("/check");
    await s.post("/webhook-endpoint");
    await s.saveStripe({ apiKey: s.stripe.apiKey });
    await s.post("/check");
    await s.put({ enabled: true });
    await s.put({ removeSecret: "webhookSecret" });
    await s.view();
    const endpointSecrets = s.stripe
      .webhookEndpoints()
      .map((e) => s.stripe.secretOf(String(e.id)))
      .filter((value): value is string => value !== undefined);

    const everything = [...s.answers, ...lines, ...s.portal.billingLog].join(
      "\n",
    );

    for (const hidden of [
      s.stripe.apiKey,
      "sk_test_ARejectedKey0123456789012345",
      secret,
      ...endpointSecrets,
    ])
      expect(everything).not.toContain(hidden);
    expect(s.answers.length).toBeGreaterThan(10);
  });

  // #504-T12
  it("shows an unreadable credential as unreadable, with no value and no cause", async () => {
    const s = await start();
    await s.saveStripe({ apiKey: s.stripe.apiKey });
    await s.portal.db
      .updateTable("secrets")
      .set({ ciphertext: "AAAA" })
      .where("name", "=", "stripe_api_key")
      .execute();

    const v = await s.view();
    const check = await s.post("/check");

    expect(v.stripe.apiKey).toEqual({ state: "unreadable" });
    expect(v.stripe.environment).toBeNull();
    expect(await check.json()).toEqual({
      ok: false,
      error: "api_key_unreadable",
    });
  });
});
