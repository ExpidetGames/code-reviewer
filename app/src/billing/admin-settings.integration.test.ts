// SPDX-License-Identifier: Apache-2.0

// The billing settings of the admin portal (#437, epic #421), end to end over a real database, the real proxy
// and the real data routes, with the fake Paddle (fakes/paddle) behind the connection check and the creation of the
// notification destination: nothing is on until the admin switches it on, the Paddle credentials are write-only
// and stored encrypted, only the instance admin reaches any of it, and no answer and no log line holds a secret.
import type { KyselyPlugin } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startPaddleFake } from "../../../fakes/paddle/server.ts";
import {
  MISSING_ANSWER_MARKER,
  NotFoundSignal,
  createAdminHarness,
  type AdminHarness,
} from "../test-support/admin-harness.ts";
import { cleanUpAfterTest } from "../test-support/test-database.ts";
import { guardBillingRoute } from "./enabled.ts";
import { PADDLE_WEBHOOK_EVENTS } from "./webhook-events.ts";

const API_KEY = "pdl_sdbx_apikey_fake_key_for_tests";
const LIVE_KEY = "pdl_live_apikey_0123456789abcdef_wxyz";
const WEBHOOK_SECRET = "pdl_ntfset_0123456789abcdef_secret_abcd";
const CLIENT_TOKEN = "test_0123456789abcdef0123456789a";
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

function post(portal: AdminHarness, path: string) {
  return portal.visit(`/api/admin/billing${path}`, {
    method: "POST",
    body: {},
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
        isOn: () => isBillingOn(portal.db.withPlugin(recorder)),
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
      settings: settings({ environment: "live" }),
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
      settings: settings({ environment: "live", apiKey: undefined }),
    });
    const together = await put(portal, {
      settings: settings({ environment: "live", apiKey: LIVE_KEY }),
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
        destination: "http://localhost:3000/api/billing/webhook",
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
      settings: settings({ environment: "live", apiKey: LIVE_KEY }),
    });
    const removal = await put(portal, { removeSecret: "apiKey" });
    const rotation = await put(portal, {
      settings: settings({ apiKey: "pdl_sdbx_apikey_rotated_0123456789" }),
    });

    for (const response of [environment, removal]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "billing_disable_first" });
    }
    expect(rotation.status).toBe(200);
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
    // The first try runs at Paddle and its answer is lost; the second one succeeds and stores the secret.
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
    expect(endpointSecrets).toHaveLength(2);
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
      settings: settings({ environment: "live", apiKey: LIVE_KEY }),
    });
    const check = await post(portal, "/check");

    expect(response.status).toBe(200);
    expect(await check.json()).toEqual({ ok: true });
  });
});
