// SPDX-License-Identifier: Apache-2.0

// The billing settings of the admin portal (#437, epic #421), end to end over a real database, the real proxy
// and the real data routes, with the fake Paddle (fakes/paddle) behind the connection check and the creation of the
// notification destination: nothing is on until the admin switches it on, the Paddle credentials are write-only
// and stored encrypted, only the instance admin reaches any of it, and no answer and no log line holds a secret.
import type { KyselyPlugin } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startPaddleFake } from "../../../fakes/paddle/server.ts";
import {
  BILLING_TEST_PUBLIC_URL,
  MISSING_ANSWER_MARKER,
  NotFoundSignal,
  createAdminHarness,
  type AdminHarness,
} from "../test-support/admin-harness.ts";
import { cleanUpAfterTest } from "../test-support/test-database.ts";
import { guardBillingRoute } from "./enabled.ts";
import { createPaddleClient } from "./paddle-client.ts";
import {
  createBillingSettingsService,
  type BillingSettingsService,
} from "./settings-service.ts";
import { PADDLE_WEBHOOK_EVENTS } from "./webhook-events.ts";

const API_KEY = "pdl_sdbx_apikey_fake_key_for_tests";
const LIVE_KEY = "pdl_live_apikey_0123456789abcdef_wxyz";
const WEBHOOK_SECRET = "pdl_ntfset_0123456789abcdef_secret_abcd";
const CLIENT_TOKEN = "test_0123456789abcdef0123456789a";
const LIVE_TOKEN = "live_0123456789abcdef0123456789a";
const WEBHOOK_URL = `${BILLING_TEST_PUBLIC_URL}/api/billing/webhook`;
const MEMBER = { email: "member@example.com", password: "k4Pq-v8Zm2Xw" };

type Body = Record<string, unknown>;

function get(portal: AdminHarness, cookies = portal.adminCookies) {
  return portal.visit("/api/admin/billing", { cookies });
}

function put(
  portal: AdminHarness,
  body: unknown,
  extra: { cookies?: AdminHarness["adminCookies"]; headers?: Body } = {},
) {
  return portal.visit("/api/admin/billing", {
    method: "PUT",
    body,
    cookies: extra.cookies ?? portal.adminCookies,
    ...(extra.headers === undefined
      ? {}
      : { headers: extra.headers as Record<string, string> }),
  });
}

function post(portal: AdminHarness, path: string, body: Body = {}) {
  return portal.visit(`/api/admin/billing${path}`, {
    method: "POST",
    body,
    cookies: portal.adminCookies,
  });
}

/** The settings of a sandbox account, complete but for the switch. */
function settings(overrides: Body = {}): Body {
  return {
    environment: "sandbox",
    clientToken: CLIENT_TOKEN,
    graceDays: 7,
    apiKey: API_KEY,
    webhookSecret: WEBHOOK_SECRET,
    ...overrides,
  };
}

async function saved(portal: AdminHarness, overrides: Body = {}) {
  const response = await put(portal, { settings: settings(overrides) });
  expect(response.status).toBe(200);
  return response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("billing that was never configured", () => {
  // #437-T01
  it("is off: a billing route answers the missing path, reads no billing table and calls Paddle never", async () => {
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();
    const statements: string[] = [];
    const recorder: KyselyPlugin = {
      transformQuery: ({ node }) => {
        statements.push(JSON.stringify(node));
        return node;
      },
      transformResult: (args) => Promise.resolve(args.result),
    };
    const { isBillingOn } = await import("./enabled.ts");
    const handler = vi.fn<(request: Request) => Promise<Response>>(() =>
      Promise.resolve(new Response("billing")),
    );
    const guarded = guardBillingRoute(
      {
        isOn: () => isBillingOn(portal.db.withPlugin(recorder), portal.secrets),
        notFound: () => {
          throw new NotFoundSignal();
        },
      },
      handler,
    );

    await expect(
      guarded(new Request("http://localhost:3000/x")),
    ).rejects.toBeInstanceOf(NotFoundSignal);

    expect(handler).not.toHaveBeenCalled();
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((text) => /"name":"billing_/.test(text))).toEqual(
      [],
    );
    expect(paddle.requests()).toEqual([]);
    expect(await portal.isBillingOn()).toBe(false);
  });

  // #437-T01
  it("shows the admin an empty page and still makes no outbound call", async () => {
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();

    const response = await get(portal);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      environment: "sandbox",
      graceDays: 7,
      clientToken: "",
      enabled: false,
      apiKey: { state: "not_configured" },
      webhookSecret: { state: "not_configured" },
      ownKeyWorkspaces: 0,
    });
    expect(paddle.requests()).toEqual([]);
    expect(await portal.isBillingOn()).toBe(false);
  });

  // #437-T01
  it("stays off while the switch is on but a credential is gone", async () => {
    const portal = await createAdminHarness();
    await saved(portal);
    expect((await put(portal, { enabled: true })).status).toBe(200);
    expect(await portal.isBillingOn()).toBe(true);

    await portal.db
      .deleteFrom("secrets")
      .where("name", "=", "paddle_webhook_secret")
      .execute();

    expect(await portal.isBillingOn()).toBe(false);
  });
});

describe("saving the credentials", () => {
  // #437-T02
  it("stores both secrets encrypted and answers with configured and the last four characters only", async () => {
    const portal = await createAdminHarness();

    const response = await saved(portal);
    const answer = await response.text();

    expect(response.headers.get("cache-control")).toBe("no-store");
    for (const secret of [API_KEY, WEBHOOK_SECRET])
      expect(answer).not.toContain(secret.slice(0, -4));
    expect(JSON.parse(answer).billing).toMatchObject({
      apiKey: { state: "configured", lastFour: "ests" },
      webhookSecret: { state: "configured", lastFour: "abcd" },
      clientToken: CLIENT_TOKEN,
    });
    const read = await (await get(portal)).text();
    for (const secret of [API_KEY, WEBHOOK_SECRET])
      expect(read).not.toContain(secret.slice(0, -4));
    const stored = await portal.db.selectFrom("secrets").selectAll().execute();
    expect(stored.map((row) => row.name).sort()).toEqual([
      "paddle_api_key",
      "paddle_webhook_secret",
    ]);
    expect(JSON.stringify(stored)).not.toContain(API_KEY.slice(0, -4));
    expect(JSON.stringify(stored)).not.toContain(WEBHOOK_SECRET.slice(0, -4));
    const key = await portal.secrets.use("paddle_api_key");
    expect(key.ok && key.value.reveal()).toBe(API_KEY);
    const secret = await portal.secrets.use("paddle_webhook_secret");
    expect(secret.ok && secret.value.reveal()).toBe(WEBHOOK_SECRET);
    const setting = await portal.db
      .selectFrom("instance_settings")
      .select("value")
      .where("key", "=", "billing_settings")
      .executeTakeFirstOrThrow();
    expect(setting.value).not.toContain(API_KEY.slice(0, -4));
    expect(JSON.parse(setting.value)).toEqual({
      environment: "sandbox",
      clientToken: CLIENT_TOKEN,
      graceDays: 7,
      enabled: false,
    });
  });

  // #437-T02
  it("keeps a stored secret when the field is left empty, and removes one only on request", async () => {
    const portal = await createAdminHarness();
    await saved(portal);

    await saved(portal, {
      apiKey: "",
      webhookSecret: undefined,
      graceDays: 10,
    });
    const key = await portal.secrets.use("paddle_api_key");
    expect(key.ok && key.value.reveal()).toBe(API_KEY);
    expect(await (await get(portal)).json()).toMatchObject({ graceDays: 10 });

    const removed = await put(portal, { removeSecret: "webhookSecret" });
    expect(removed.status).toBe(200);
    expect((await portal.secrets.status("paddle_webhook_secret")).state).toBe(
      "not_configured",
    );
  });

  // #437-T03
  it("refuses a sandbox key with live, and a live key with sandbox", async () => {
    const portal = await createAdminHarness();

    const sandboxKeyLive = await put(portal, {
      settings: settings({ environment: "live", clientToken: LIVE_TOKEN }),
    });
    const liveKeySandbox = await put(portal, {
      settings: settings({ apiKey: LIVE_KEY }),
    });

    for (const response of [sandboxKeyLive, liveKeySandbox]) {
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "billing_environment_mismatch",
      });
    }
    expect(await portal.db.selectFrom("secrets").selectAll().execute()).toEqual(
      [],
    );
    expect(
      await portal.db
        .selectFrom("instance_settings")
        .selectAll()
        .where("key", "=", "billing_settings")
        .execute(),
    ).toEqual([]);
  });

  // #437-T03
  it("refuses to switch the environment under a stored key of the other one, and accepts it together with a new key", async () => {
    const portal = await createAdminHarness();
    await saved(portal);

    const alone = await put(portal, {
      settings: settings({
        environment: "live",
        clientToken: LIVE_TOKEN,
        apiKey: undefined,
      }),
    });
    const together = await put(portal, {
      settings: settings({
        environment: "live",
        clientToken: LIVE_TOKEN,
        apiKey: LIVE_KEY,
      }),
    });

    expect(alone.status).toBe(422);
    expect(await alone.json()).toEqual({
      error: "billing_environment_mismatch",
    });
    expect(together.status).toBe(200);
    expect(await (await get(portal)).json()).toMatchObject({
      environment: "live",
    });
  });

  // #437-T03
  it("refuses a key that is no Paddle key at all, naming the field", async () => {
    const portal = await createAdminHarness();

    const response = await put(portal, {
      settings: settings({ apiKey: "sk-not-a-paddle-key-0123456789" }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "apiKey", code: "api_key_invalid" }],
    });
  });

  // #437-T03
  it.each([
    [{ graceDays: 0.5 }, "graceDays", "grace_days_invalid"],
    [{ graceDays: 400 }, "graceDays", "grace_days_invalid"],
    [{ environment: "staging" }, "environment", "environment_invalid"],
    [{ clientToken: "has a space" }, "clientToken", "client_token_invalid"],
  ])("refuses invalid settings %j", async (overrides, field, code) => {
    const portal = await createAdminHarness();

    const response = await put(portal, { settings: settings(overrides) });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_input",
      issues: [{ field, code }],
    });
  });
});

describe("the connection check", () => {
  // #437-T04
  it("passes with a key that Paddle accepts, by one harmless read", async () => {
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();
    await saved(portal);

    const response = await post(portal, "/check");

    expect(await response.json()).toEqual({ ok: true });
    expect(
      paddle
        .requests()
        .map(({ method, authenticated }) => [method, authenticated]),
    ).toEqual([["GET", true]]);
  });

  // #437-T04
  it("gives a stable code for a key Paddle rejects, for a missing key and for a Paddle that fails", async () => {
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();
    expect(await (await post(portal, "/check")).json()).toEqual({
      ok: false,
      error: "api_key_missing",
    });

    await saved(portal, { apiKey: "pdl_sdbx_apikey_some_other_key_0000" });
    expect(await (await post(portal, "/check")).json()).toEqual({
      ok: false,
      error: "paddle_key_rejected",
    });

    await saved(portal);
    paddle.faults.failWith({ method: "GET" }, 500);
    expect(await (await post(portal, "/check")).json()).toEqual({
      ok: false,
      error: "paddle_unavailable",
    });
  });
});

describe("the notification destination", () => {
  // #437-T05
  it("is created with the address of this app and the handled events, and the returned secret is stored", async () => {
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();
    await saved(portal, { webhookSecret: undefined });

    const response = await post(portal, "/notification-destination");
    const answer = await response.text();

    expect(response.status).toBe(200);
    const created = paddle.requests().filter(({ method }) => method === "POST");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      path: "/notification-settings",
      body: {
        type: "url",
        destination: WEBHOOK_URL,
        subscribed_events: [...PADDLE_WEBHOOK_EVENTS],
      },
    });
    const [setting] = paddle.notificationSettings();
    const endpointSecret = (
      setting as unknown as { endpoint_secret_key: string }
    ).endpoint_secret_key;
    expect(endpointSecret.length).toBeGreaterThan(8);
    const stored = await portal.secrets.use("paddle_webhook_secret");
    expect(stored.ok && stored.value.reveal()).toBe(endpointSecret);
    expect(answer).not.toContain(endpointSecret);
    expect(JSON.parse(answer).billing.webhookSecret).toMatchObject({
      state: "configured",
    });
    const row = await portal.db
      .selectFrom("secrets")
      .selectAll()
      .where("name", "=", "paddle_webhook_secret")
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(endpointSecret);
  });

  // #437-T05
  it("is not created a second time while a webhook secret is stored, and not without a key", async () => {
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();

    const noKey = await post(portal, "/notification-destination");
    await saved(portal, { webhookSecret: undefined });
    await post(portal, "/notification-destination");
    const again = await post(portal, "/notification-destination");

    expect(noKey.status).toBe(409);
    expect(await noKey.json()).toEqual({ error: "api_key_missing" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "webhook_secret_exists" });
    expect(paddle.notificationSettings()).toHaveLength(1);
  });

  // #437-T05
  it("gives a stable code when Paddle refuses and stores nothing", async () => {
    const portal = await createAdminHarness();
    await saved(portal, {
      webhookSecret: undefined,
      apiKey: "pdl_sdbx_apikey_some_other_key_0000",
    });

    const response = await post(portal, "/notification-destination");

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "paddle_key_rejected" });
    expect((await portal.secrets.status("paddle_webhook_secret")).state).toBe(
      "not_configured",
    );
  });
});

describe("switching billing on", () => {
  // #437-T06
  it("is refused with every missing item named by code", async () => {
    const portal = await createAdminHarness();

    const nothing = await put(portal, { enabled: true });
    await saved(portal, { clientToken: "", webhookSecret: undefined });
    const partial = await put(portal, { enabled: true });

    expect(nothing.status).toBe(409);
    expect(await nothing.json()).toEqual({
      error: "billing_incomplete",
      missing: [
        "api_key_missing",
        "webhook_secret_missing",
        "client_token_missing",
      ],
    });
    expect(await partial.json()).toEqual({
      error: "billing_incomplete",
      missing: ["webhook_secret_missing", "client_token_missing"],
    });
    expect(await portal.isBillingOn()).toBe(false);
  });

  // #437-T06
  it("is refused without a passing check, and the check is made then and not remembered", async () => {
    const portal = await createAdminHarness();
    await saved(portal, { apiKey: "pdl_sdbx_apikey_some_other_key_0000" });

    const response = await put(portal, { enabled: true });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "billing_incomplete",
      missing: ["connection_check_failed"],
    });
    expect(await portal.isBillingOn()).toBe(false);
  });

  // #437-T06
  it("switches on with everything in place, and off again at any time", async () => {
    const portal = await createAdminHarness();
    await saved(portal);

    const on = await put(portal, { enabled: true });
    expect(on.status).toBe(200);
    expect(await portal.isBillingOn()).toBe(true);
    expect((await on.json()).billing).toMatchObject({ enabled: true });

    const off = await put(portal, { enabled: false });
    expect(off.status).toBe(200);
    expect(await portal.isBillingOn()).toBe(false);
  });

  // #437-T06
  it("keeps the credentials and the environment in place while it is on", async () => {
    const portal = await createAdminHarness();
    await saved(portal);
    await put(portal, { enabled: true });

    const environment = await put(portal, {
      settings: settings({
        environment: "live",
        clientToken: LIVE_TOKEN,
        apiKey: LIVE_KEY,
      }),
    });
    const removal = await put(portal, { removeSecret: "apiKey" });
    const sameKeyAgain = await put(portal, { settings: settings() });

    for (const response of [environment, removal]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "billing_disable_first" });
    }
    expect(sameKeyAgain.status).toBe(200);
  });

  // #437-T06
  it("checks a replacement key before it is stored while billing is on, and keeps the old one when Paddle refuses it", async () => {
    const portal = await createAdminHarness();
    await saved(portal);
    await put(portal, { enabled: true });

    const refused = await put(portal, {
      settings: settings({ apiKey: "pdl_sdbx_apikey_rotated_0123456789" }),
    });

    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "paddle_key_rejected" });
    const stored = await portal.secrets.use("paddle_api_key");
    expect(stored.ok && stored.value.reveal()).toBe(API_KEY);
    expect(await portal.isBillingOn()).toBe(true);
  });

  // #437-T06
  it("counts the workspaces with a stored own key that would stop reviewing on it", async () => {
    const portal = await createAdminHarness();
    const workspace = await portal.db
      .selectFrom("workspaces")
      .select("id")
      .executeTakeFirstOrThrow();
    const at = "2026-10-11T08:00:00.000Z";
    await portal.db
      .insertInto("workspace_secrets")
      .values({
        workspace_id: workspace.id,
        name: "llm_api_key",
        binding: "openrouter",
        ciphertext: "x",
        nonce: "y",
        key_version: 1,
        last_four: null,
        updated_by: null,
        updated_at: at,
      })
      .execute();

    expect(await (await get(portal)).json()).toMatchObject({
      ownKeyWorkspaces: 1,
    });

    // A workspace the operator set entitlements for by hand is not affected: its key mode is the operator's.
    await portal.db
      .insertInto("workspace_entitlements")
      .values({
        workspace_id: workspace.id,
        plan_label: "manual",
        key_mode: "own",
        limits: "{}",
        period_start: at,
        suspended: 0,
        suspension_code: null,
        updated_at: at,
        updated_by: null,
      })
      .execute();

    expect(await (await get(portal)).json()).toMatchObject({
      ownKeyWorkspaces: 0,
    });
  });
});

describe("who reaches the billing routes", () => {
  const ROUTES: Array<[string, string]> = [
    ["GET", "/api/admin/billing"],
    ["PUT", "/api/admin/billing"],
    ["POST", "/api/admin/billing/check"],
    ["POST", "/api/admin/billing/notification-destination"],
  ];

  // #437-T07
  it.each(ROUTES)(
    "%s %s: nobody is told that it exists, and nothing is read or sent",
    async (method, path) => {
      const portal = await createAdminHarness();
      const paddle = await portal.fakePaddle();
      await portal.createUser({ id: "member-1", ...MEMBER });
      const member = await portal.signIn(MEMBER.email, MEMBER.password);
      const init = {
        method,
        body: method === "GET" ? undefined : { enabled: true },
      };

      const anonymous = await portal.visit(path, init);
      const asMember = await portal.visit(path, { ...init, cookies: member });
      // Without the proxy in front: the handler asks for the admin itself.
      const file = path.replace("/api/admin", "/api/instance-portal");
      const bareAnonymous = await portal.callRoute(file, init);
      const bareMember = await portal.callRoute(file, {
        ...init,
        cookies: member,
      });

      expect(anonymous.status).toBe(401);
      expect(asMember.status).toBe(404);
      expect(asMember.headers.get(MISSING_ANSWER_MARKER)).toBe("1");
      expect(bareAnonymous.status).toBe(401);
      expect(bareMember.status).toBe(404);
      expect(paddle.requests()).toEqual([]);
      expect(
        await portal.db
          .selectFrom("instance_settings")
          .selectAll()
          .where("key", "=", "billing_settings")
          .execute(),
      ).toEqual([]);
    },
  );

  // #437-T07
  it("refuses a change that comes from another site", async () => {
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();

    const change = await put(
      portal,
      { settings: settings() },
      { headers: { "sec-fetch-site": "cross-site" } },
    );
    const check = await portal.visit("/api/admin/billing/check", {
      method: "POST",
      body: {},
      cookies: portal.adminCookies,
      headers: { "sec-fetch-site": "cross-site" },
    });

    for (const response of [change, check]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "cross_site_request" });
    }
    expect(paddle.requests()).toEqual([]);
    expect(await portal.db.selectFrom("secrets").selectAll().execute()).toEqual(
      [],
    );
  });

  // #437-T07
  it("refuses a body that is no JSON object with exactly one change", async () => {
    const portal = await createAdminHarness();

    const two = await put(portal, { enabled: false, removeSecret: "apiKey" });
    const none = await put(portal, {});
    const text = await portal.visit("/api/admin/billing", {
      method: "PUT",
      body: "nope",
      cookies: portal.adminCookies,
      headers: { "content-type": "text/plain" },
    });

    expect(two.status).toBe(422);
    expect(none.status).toBe(422);
    expect(text.status).toBe(415);
  });
});

describe("secrets in answers and logs", () => {
  // #437-T08
  it("never reach an answer or a log line, through every route and every failure", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();
    const answers: string[] = [];
    const remember = async (response: Response) => {
      answers.push(await response.text());
    };

    await remember(
      await put(portal, {
        settings: settings({ apiKey: "bad key with a space and 0123456789" }),
      }),
    );
    await remember(
      await put(portal, {
        settings: settings({ webhookSecret: "x".repeat(70_000) }),
      }),
    );
    await remember(await saved(portal));
    await remember(await post(portal, "/check"));
    paddle.faults.failWith({ method: "GET" }, 500);
    await remember(await post(portal, "/check"));
    await remember(await put(portal, { removeSecret: "webhookSecret" }));
    // The first try runs at Paddle and its answer is lost; the second one finds that destination and stores its secret.
    paddle.faults.dropResponse({ method: "POST" }, { mode: "reset" });
    await remember(await post(portal, "/notification-destination"));
    await remember(await post(portal, "/notification-destination"));
    await remember(await put(portal, { enabled: true }));
    await remember(await get(portal));
    await portal.db.updateTable("secrets").set({ nonce: "AAAA" }).execute();
    await remember(await get(portal));
    await remember(await post(portal, "/check"));

    const endpointSecrets = paddle
      .notificationSettings()
      .map(
        (setting) =>
          (setting as unknown as { endpoint_secret_key: string })
            .endpoint_secret_key,
      );
    expect(endpointSecrets).toHaveLength(1);
    const secrets = [
      API_KEY,
      WEBHOOK_SECRET,
      "bad key with a space",
      ...endpointSecrets,
    ];
    const everything = [...answers, ...lines].join("\n");
    for (const secret of secrets) {
      expect(everything).not.toContain(secret);
      expect(everything).not.toContain(secret.slice(0, -4));
    }
    expect(paddle.requests().length).toBeGreaterThan(0);
  });
});

describe("a Paddle of the live environment", () => {
  // #437-T03
  it("takes a live key with live, and the check goes to Paddle with it", async () => {
    const paddle = await startPaddleFake({ apiKey: LIVE_KEY });
    cleanUpAfterTest(() => paddle.close());
    const portal = await createAdminHarness({ paddle });

    const response = await put(portal, {
      settings: settings({
        environment: "live",
        clientToken: LIVE_TOKEN,
        apiKey: LIVE_KEY,
      }),
    });
    const check = await post(portal, "/check");

    expect(response.status).toBe(200);
    expect(await check.json()).toEqual({ ok: true });
  });
});

type SecretStore = AdminHarness["secrets"];
type ServiceHooks = {
  /**
   * Runs before the n-th read (`use`) of a secret by this service (1 counts from the first): the other tab gets its
   * turn there. `setEnabled` reads the key at 1 and again for the connection check at 2.
   */
  beforeUse?: { n: number; run: () => Promise<unknown> };
  /** Replaces the save of the webhook secret. */
  saveWebhookSecret?: SecretStore["save"];
};

/** A second service over the same database and the same fake Paddle, with a hook where a test interleaves. */
async function serviceOver(
  portal: AdminHarness,
  hooks: ServiceHooks = {},
): Promise<BillingSettingsService> {
  const paddle = await portal.fakePaddle();
  let uses = 0;
  const secrets: SecretStore = {
    ...portal.secrets,
    use: async (name) => {
      uses += 1;
      if (uses === hooks.beforeUse?.n) await hooks.beforeUse.run();
      return portal.secrets.use(name);
    },
    save: (name, value, options) =>
      name === "paddle_webhook_secret" && hooks.saveWebhookSecret !== undefined
        ? hooks.saveWebhookSecret(name, value, options)
        : portal.secrets.save(name, value, options),
  };
  return createBillingSettingsService({
    db: portal.db,
    secrets,
    clientFor: (apiKey) =>
      createPaddleClient({
        apiKey,
        baseUrl: paddle.baseUrl,
        sleep: () => Promise.resolve(),
      }),
    publicUrl: BILLING_TEST_PUBLIC_URL,
  });
}

describe("the notification destination, idempotent", () => {
  // #437-T05
  it("leaves exactly one destination at Paddle when two creates arrive at once", async () => {
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();
    await saved(portal, { webhookSecret: undefined });

    const answers = await Promise.all([
      post(portal, "/notification-destination"),
      post(portal, "/notification-destination"),
    ]);

    const statuses = answers.map(({ status }) => status);
    expect(statuses).toContain(200);
    expect(statuses.filter((status) => status >= 500)).toEqual([]);
    expect(paddle.notificationSettings()).toHaveLength(1);
    const [setting] = paddle.notificationSettings();
    const stored = await portal.secrets.use("paddle_webhook_secret");
    expect(stored.ok && stored.value.reveal()).toBe(
      (setting as unknown as { endpoint_secret_key: string })
        .endpoint_secret_key,
    );
  });

  // #437-T05
  it("answers with a stable code while another create is running, and takes over a lock that has run out", async () => {
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();
    await saved(portal, { webhookSecret: undefined });
    const lock = (updatedAt: string) =>
      portal.db
        .insertInto("instance_settings")
        .values({
          key: "billing_destination_lock",
          value: "{}",
          updated_by: null,
          updated_at: updatedAt,
        })
        .onConflict((conflict) =>
          conflict.column("key").doUpdateSet({ updated_at: updatedAt }),
        )
        .execute();

    await lock(new Date().toISOString());
    const busy = await post(portal, "/notification-destination");
    await lock(new Date(Date.now() - 10 * 60_000).toISOString());
    const later = await post(portal, "/notification-destination");

    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({
      error: "webhook_destination_in_progress",
    });
    expect(later.status).toBe(200);
    expect(paddle.notificationSettings()).toHaveLength(1);
  });

  // #437-T05
  it("finds the destination again after a lost answer and leaves one", async () => {
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();
    await saved(portal, { webhookSecret: undefined });
    paddle.faults.dropResponse(
      { method: "POST", path: "/notification-settings" },
      { mode: "reset" },
    );

    const lost = await post(portal, "/notification-destination");
    const retry = await post(portal, "/notification-destination");

    expect(lost.status).toBe(502);
    expect(await lost.json()).toEqual({ error: "paddle_unreachable" });
    expect(retry.status).toBe(200);
    expect(paddle.notificationSettings()).toHaveLength(1);
    const [setting] = paddle.notificationSettings();
    const stored = await portal.secrets.use("paddle_webhook_secret");
    expect(stored.ok && stored.value.reveal()).toBe(
      (setting as unknown as { endpoint_secret_key: string })
        .endpoint_secret_key,
    );
    expect(
      paddle.requests().filter(({ method }) => method === "POST"),
    ).toHaveLength(1);
  });

  // #437-T05
  it("adopts a destination at its own address and creates nothing, and leaves destinations of other addresses alone", async () => {
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();
    await saved(portal, { webhookSecret: undefined });
    const client = createPaddleClient({
      apiKey: API_KEY,
      baseUrl: paddle.baseUrl,
      sleep: () => Promise.resolve(),
    });
    const other = await client.createNotificationSetting({
      description: "Somebody else",
      destination: "https://elsewhere.example.test/hook",
      subscribed_events: ["subscription.updated"],
    });
    const ours = await client.createNotificationSetting({
      description: "Code Reviewer",
      destination: WEBHOOK_URL,
      subscribed_events: ["subscription.updated"],
    });
    const baseline = paddle.requests().length;

    const response = await post(portal, "/notification-destination");

    expect(response.status).toBe(200);
    expect(
      paddle
        .requests()
        .slice(baseline)
        .filter(({ method }) => method !== "GET"),
    ).toEqual([]);
    const stored = await portal.secrets.use("paddle_webhook_secret");
    expect(stored.ok && stored.value.reveal()).toBe(ours.endpoint_secret_key);
    expect(
      paddle
        .notificationSettings()
        .map(({ id }) => id)
        .sort(),
    ).toEqual([other.id, ours.id].sort());
  });

  // #437-T05
  it("refuses a destination whose secret it cannot get, tells to delete it or recreate, and recreates it on request", async () => {
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();
    await saved(portal, { webhookSecret: undefined });
    const client = createPaddleClient({
      apiKey: API_KEY,
      baseUrl: paddle.baseUrl,
      sleep: () => Promise.resolve(),
    });
    const old = await client.createNotificationSetting({
      description: "Code Reviewer",
      destination: WEBHOOK_URL,
      subscribed_events: ["subscription.updated"],
    });
    paddle.hideSecretsInList();

    const refused = await post(portal, "/notification-destination");
    const recreated = await post(portal, "/notification-destination", {
      recreate: true,
    });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "webhook_destination_exists",
    });
    expect(recreated.status).toBe(200);
    const [only, ...rest] = paddle.notificationSettings();
    expect(rest).toEqual([]);
    expect(only?.id).not.toBe(old.id);
    const stored = await portal.secrets.use("paddle_webhook_secret");
    expect(stored.ok && stored.value.reveal()).toBe(
      (only as unknown as { endpoint_secret_key: string }).endpoint_secret_key,
    );
  });

  // #437-T05
  it("recreates: the old destination and the old secret are replaced, and not while billing is on", async () => {
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();
    await saved(portal, { webhookSecret: undefined });
    await post(portal, "/notification-destination");
    const [first] = paddle.notificationSettings();
    const firstSecret = await portal.secrets.use("paddle_webhook_secret");

    const plain = await post(portal, "/notification-destination");
    const recreated = await post(portal, "/notification-destination", {
      recreate: true,
    });

    expect(plain.status).toBe(409);
    expect(await plain.json()).toEqual({ error: "webhook_secret_exists" });
    expect(recreated.status).toBe(200);
    const [second, ...rest] = paddle.notificationSettings();
    expect(rest).toEqual([]);
    expect(second?.id).not.toBe(first?.id);
    const secondSecret = await portal.secrets.use("paddle_webhook_secret");
    expect(secondSecret.ok && secondSecret.value.reveal()).toBe(
      (second as unknown as { endpoint_secret_key: string })
        .endpoint_secret_key,
    );
    expect(secondSecret.ok && secondSecret.value.reveal()).not.toBe(
      firstSecret.ok && firstSecret.value.reveal(),
    );

    await put(portal, { enabled: true });
    const whileOn = await post(portal, "/notification-destination", {
      recreate: true,
    });
    expect(whileOn.status).toBe(409);
    expect(await whileOn.json()).toEqual({ error: "billing_disable_first" });
    expect(paddle.notificationSettings()).toHaveLength(1);
  });

  // #437-T05
  it("refuses a recreate flag that is no boolean", async () => {
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();
    await saved(portal, { webhookSecret: undefined });

    const response = await post(portal, "/notification-destination", {
      recreate: "yes",
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid_input" });
    expect(paddle.notificationSettings()).toEqual([]);
  });

  // #437-T05
  it("reports the destination when the secret could not be stored, and adopts it on the next try", async () => {
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();
    await saved(portal, { webhookSecret: undefined });
    const failing = await serviceOver(portal, {
      saveWebhookSecret: () => Promise.reject(new Error("the store is down")),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const failed = await failing.createNotificationDestination(portal.adminId);
    const [created] = paddle.notificationSettings();
    const healthy = await serviceOver(portal);
    const retry = await healthy.createNotificationDestination(portal.adminId);

    expect(failed).toEqual({
      ok: false,
      error: "webhook_secret_not_stored",
      destinationId: created?.id,
    });
    expect(retry).toEqual({ ok: true });
    expect(paddle.notificationSettings()).toHaveLength(1);
    const stored = await portal.secrets.use("paddle_webhook_secret");
    expect(stored.ok && stored.value.reveal()).toBe(
      (created as unknown as { endpoint_secret_key: string })
        .endpoint_secret_key,
    );
  });

  // #437-T05
  it("tells the destination in the answer of the route when the secret could not be stored", async () => {
    const portal = await createAdminHarness();
    const paddle = await portal.fakePaddle();
    await saved(portal, { webhookSecret: undefined });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(portal.secrets, "save").mockImplementation((name) =>
      name === "paddle_webhook_secret"
        ? Promise.resolve({ ok: false, error: "secret_empty" })
        : Promise.reject(new Error("unexpected")),
    );

    const response = await post(portal, "/notification-destination");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "webhook_secret_not_stored",
      destinationId: paddle.notificationSettings()[0]?.id,
    });
  });
});

describe("the public address of the webhook", () => {
  // #437-T05
  it.each([
    "http://localhost:3000",
    "http://reviews.example.test",
    "https://localhost",
    "https://192.168.1.20",
    "https://10.0.0.5",
    "https://[::1]",
  ])("refuses %s before anything is sent to Paddle", async (publicUrl) => {
    const portal = await createAdminHarness({ billingPublicUrl: publicUrl });
    const paddle = await portal.fakePaddle();
    await saved(portal, { webhookSecret: undefined });
    const baseline = paddle.requests().length;

    const response = await post(portal, "/notification-destination");

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "webhook_url_not_public" });
    expect(paddle.requests().slice(baseline)).toEqual([]);
    expect((await portal.secrets.status("paddle_webhook_secret")).state).toBe(
      "not_configured",
    );
  });
});

describe("two tabs changing the settings", () => {
  const changedToken = "test_changedtoken0123456789abcdef";

  // #437-T06
  it("does not write the switch from a stale read when another tab switched billing off", async () => {
    const portal = await createAdminHarness();
    await saved(portal);
    await put(portal, { enabled: true });
    const otherTab = await serviceOver(portal);
    const racing = await serviceOver(portal, {
      beforeUse: {
        n: 1,
        run: () => otherTab.setEnabled(portal.adminId, false),
      },
    });

    const result = await racing.saveSettings(
      portal.adminId,
      settings({ apiKey: undefined, graceDays: 14 }),
    );

    expect(result).toEqual({ ok: false, error: "billing_settings_changed" });
    expect(await portal.isBillingOn()).toBe(false);
    expect(await (await get(portal)).json()).toMatchObject({
      enabled: false,
      graceDays: 7,
    });
  });

  // #437-T06
  it("enables exactly the configuration it checked: a change in between refuses the switch", async () => {
    const portal = await createAdminHarness();
    await saved(portal);
    const otherTab = await serviceOver(portal);
    const racing = await serviceOver(portal, {
      beforeUse: {
        n: 1,
        run: () =>
          otherTab.saveSettings(
            portal.adminId,
            settings({ apiKey: undefined, clientToken: changedToken }),
          ),
      },
    });

    const result = await racing.setEnabled(portal.adminId, true);

    expect(result).toEqual({ ok: false, error: "billing_settings_changed" });
    expect(await portal.isBillingOn()).toBe(false);
    expect(await (await get(portal)).json()).toMatchObject({
      enabled: false,
      clientToken: changedToken,
    });
  });

  // #437-T06
  it("refuses the switch when a secret was removed after the check began", async () => {
    const portal = await createAdminHarness();
    await saved(portal);
    const otherTab = await serviceOver(portal);
    const racing = await serviceOver(portal, {
      beforeUse: {
        n: 2,
        run: () => otherTab.removeSecret(portal.adminId, "webhookSecret"),
      },
    });

    const result = await racing.setEnabled(portal.adminId, true);

    expect(result).toEqual({ ok: false, error: "billing_settings_changed" });
    expect(await portal.isBillingOn()).toBe(false);
  });

  // #437-T06
  it("lets two saves that do not overlap both through", async () => {
    const portal = await createAdminHarness();
    const service = await serviceOver(portal);

    const first = await service.saveSettings(portal.adminId, settings());
    const second = await service.saveSettings(
      portal.adminId,
      settings({ graceDays: 3 }),
    );

    expect([first, second]).toEqual([{ ok: true }, { ok: true }]);
    expect(await (await get(portal)).json()).toMatchObject({ graceDays: 3 });
  });
});

describe("one environment for every credential", () => {
  async function setSettingsRow(portal: AdminHarness, value: Body) {
    await portal.db
      .updateTable("instance_settings")
      .set({ value: JSON.stringify(value) })
      .where("key", "=", "billing_settings")
      .execute();
  }

  // #437-T03
  it("forgets the webhook secret of the other environment when the environment is switched, and keeps one that comes with the switch", async () => {
    const portal = await createAdminHarness();
    await saved(portal);
    const live = {
      environment: "live",
      clientToken: LIVE_TOKEN,
      apiKey: LIVE_KEY,
    };

    const switched = await put(portal, {
      settings: settings({ ...live, webhookSecret: undefined }),
    });
    await saved(portal);
    const withSecret = await put(portal, {
      settings: settings({
        ...live,
        webhookSecret: "pdl_ntfset_live_secret_0123456789",
      }),
    });

    expect(switched.status).toBe(200);
    expect((await switched.json()).billing.webhookSecret).toEqual({
      state: "not_configured",
    });
    expect(withSecret.status).toBe(200);
    expect((await withSecret.json()).billing.webhookSecret).toMatchObject({
      state: "configured",
    });
  });

  // #437-T03
  it("refuses a client token of the other environment, and one that is no token of Paddle", async () => {
    const portal = await createAdminHarness();

    const liveTokenSandbox = await put(portal, {
      settings: settings({ clientToken: LIVE_TOKEN }),
    });
    const sandboxTokenLive = await put(portal, {
      settings: settings({
        environment: "live",
        apiKey: LIVE_KEY,
        clientToken: CLIENT_TOKEN,
      }),
    });
    const noToken = await put(portal, {
      settings: settings({ clientToken: "abcdef0123456789" }),
    });

    for (const [response, code] of [
      [liveTokenSandbox, "client_token_environment_mismatch"],
      [sandboxTokenLive, "client_token_environment_mismatch"],
      [noToken, "client_token_invalid"],
    ] as const) {
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "invalid_input",
        issues: [{ field: "clientToken", code }],
      });
    }
  });

  // #437-T06
  it("refuses to switch on when a stored credential belongs to another environment than the settings", async () => {
    const portal = await createAdminHarness();
    await saved(portal);
    const base = {
      environment: "sandbox",
      clientToken: CLIENT_TOKEN,
      graceDays: 7,
      enabled: false,
    };

    await setSettingsRow(portal, { ...base, environment: "live" });
    const keyOfOther = await put(portal, { enabled: true });
    await setSettingsRow(portal, { ...base, clientToken: LIVE_TOKEN });
    const tokenOfOther = await put(portal, { enabled: true });

    for (const response of [keyOfOther, tokenOfOther]) {
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "billing_environment_mismatch",
      });
    }
    expect(await portal.isBillingOn()).toBe(false);
  });

  // #437-T03
  it("does not let the environment switch through under a stored key that cannot be read", async () => {
    const portal = await createAdminHarness();
    await saved(portal);
    await portal.db
      .updateTable("secrets")
      .set({ nonce: "AAAA" })
      .where("name", "=", "paddle_api_key")
      .execute();

    const alone = await put(portal, {
      settings: settings({
        environment: "live",
        clientToken: LIVE_TOKEN,
        apiKey: undefined,
        webhookSecret: undefined,
      }),
    });
    expect(alone.status).toBe(409);
    expect(await alone.json()).toEqual({ error: "api_key_unreadable" });
    expect(await (await get(portal)).json()).toMatchObject({
      environment: "sandbox",
    });
    const together = await put(portal, {
      settings: settings({
        environment: "live",
        clientToken: LIVE_TOKEN,
        apiKey: LIVE_KEY,
      }),
    });
    expect(together.status).toBe(200);
    expect(await (await get(portal)).json()).toMatchObject({
      environment: "live",
    });
  });
});

describe("billing that is on", () => {
  // #437-T06
  it("is off when a stored secret can no longer be read", async () => {
    const portal = await createAdminHarness();
    await saved(portal);
    await put(portal, { enabled: true });
    expect(await portal.isBillingOn()).toBe(true);

    await portal.db
      .updateTable("secrets")
      .set({ nonce: "AAAA" })
      .where("name", "=", "paddle_webhook_secret")
      .execute();
    const webhookUnreadable = await portal.isBillingOn();
    await portal.db
      .updateTable("secrets")
      .set({ nonce: "AAAA" })
      .where("name", "=", "paddle_api_key")
      .execute();

    expect(webhookUnreadable).toBe(false);
    expect(await portal.isBillingOn()).toBe(false);
  });
});
