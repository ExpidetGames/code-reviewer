// SPDX-License-Identifier: Apache-2.0

// The real route file `POST /api/billing/webhook` (#441) with the wiring the running server uses: the database opened at start, the
// secret store with the master key from the environment, the billing switch from the settings. While billing is off the route is the
// 404 of a path that does not exist and the handler is never reached; when it is on, the access proxy lets a request without a
// session through (the signature is the credential), and a signed delivery changes the state.
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDeliveries } from "../../../fakes/paddle/webhooks.ts";
import { createAccessProxy } from "../../src/auth/access-proxy.ts";
import { createBillingWebhookEventsRepository } from "../../src/db/repositories/billing-webhook-events-repository.ts";
import {
  closeDatabase,
  getDatabase,
  initializeDatabaseOnStart,
} from "../../src/db/startup.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createAuthHarness } from "../../src/test-support/auth-harness.ts";
import {
  setBillingSwitch,
  TEST_BILLING_SETTINGS,
} from "../../src/test-support/billing-switch.ts";
import {
  WEBHOOK_SECRET,
  WEBHOOK_URL,
  event,
  priceData,
} from "../../src/test-support/billing-webhook-harness.ts";
import { createInstanceSettingsRepository } from "../../src/db/repositories/instance-settings-repository.ts";
import { openGates } from "../../src/test-support/open-gates.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";

type Route = typeof import("../../src/app/api/billing/webhook/route.ts");

const APP_SECRET = "route-file-app-secret-0123456789-abcdefghijklmn";
const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };

async function startRoute(options: { billing: "off" | "switched-off" | "on" }) {
  vi.stubEnv("APP_SECRET", APP_SECRET);
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(await createTestDirectory(), "app.db") },
  });
  const db = getDatabase();
  if (options.billing !== "off") {
    const secrets = createSecretStore({ db, appSecret: APP_SECRET });
    await secrets.save("paddle_webhook_secret", WEBHOOK_SECRET, {
      updatedBy: null,
    });
    await secrets.save("paddle_api_key", "pdl_sdbx_apikey_0123456789abcdef", {
      updatedBy: null,
    });
    await createInstanceSettingsRepository(db).set(
      "billing_settings",
      {
        ...TEST_BILLING_SETTINGS,
        enabled: options.billing === "on",
      },
      null,
    );
    await setBillingSwitch(db, options.billing === "on");
  }
  vi.resetModules();
  const route: Route =
    await import("../../src/app/api/billing/webhook/route.ts");
  const signed = (secret = WEBHOOK_SECRET) => {
    const [delivery] = buildDeliveries(
      [
        event("price.updated", priceData("pri_nobody"), {
          id: "evt_route_file",
        }),
      ],
      { secret },
    );
    return new Request(WEBHOOK_URL, {
      method: "POST",
      headers: delivery?.headers ?? {},
      body: delivery?.body ?? "",
    });
  };
  return { db, route, signed };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
});

describe("the billing webhook route file", () => {
  // #441-T01 (regression found by the build in CI): the app builds with `cacheComponents`, which refuses a route segment config such as
  // `runtime`. Node is the default runtime, and the handler needs raw text and `node:crypto`, which it has there.
  it("exports no route segment config, which the build of this app refuses", () => {
    const source = readFileSync(
      join(import.meta.dirname, "../../src/app/api/billing/webhook/route.ts"),
      "utf8",
    );

    expect(source).not.toMatch(
      /export\s+const\s+(runtime|dynamic|revalidate|fetchCache|maxDuration|preferredRegion|dynamicParams)\b/,
    );
  });

  // #441-T01
  it("is the 404 of a path that does not exist while billing was never configured", async () => {
    const { db, route, signed } = await startRoute({ billing: "off" });

    await expect(route.POST(signed())).rejects.toMatchObject(NOT_FOUND);

    expect(
      await db.selectFrom("billing_webhook_events").selectAll().execute(),
    ).toEqual([]);
  });

  // #441-T01
  it("is the 404 of a path that does not exist while billing is switched off, even for a validly signed delivery", async () => {
    const { db, route, signed } = await startRoute({ billing: "switched-off" });

    await expect(route.POST(signed())).rejects.toMatchObject(NOT_FOUND);

    expect(
      await createBillingWebhookEventsRepository(db).get("evt_route_file"),
    ).toBeUndefined();
  });

  // #441-T01
  it("is the 404 of a path that does not exist for an unsigned request too, so its existence is not revealed", async () => {
    const { route } = await startRoute({ billing: "off" });

    await expect(
      route.POST(new Request(WEBHOOK_URL, { method: "POST", body: "{}" })),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  // #441-T01
  it("is the 404 of a missing path for every method while billing is off, and a 405 naming POST once it is on", async () => {
    const off = await startRoute({ billing: "off" });
    const methods = [
      "GET",
      "HEAD",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ] as const;

    for (const method of methods)
      await expect(
        off.route[method](new Request(WEBHOOK_URL, { method })),
        method,
      ).rejects.toMatchObject(NOT_FOUND);
    await closeDatabase();
    const on = await startRoute({ billing: "on" });
    for (const method of methods) {
      const answer = await on.route[method](
        new Request(WEBHOOK_URL, { method }),
      );
      expect(answer.status, method).toBe(405);
      expect(answer.headers.get("allow"), method).toBe("POST");
    }
  });

  // #441-T02
  it("applies a signed delivery when billing is on, and refuses one signed with another secret", async () => {
    const { db, route, signed } = await startRoute({ billing: "on" });

    const refused = await route.POST(signed("pdl_ntfset_somebody_else"));
    const accepted = await route.POST(signed());

    expect(refused.status).toBe(401);
    expect(await refused.text()).toBe("");
    expect(accepted.status).toBe(200);
    expect(
      await createBillingWebhookEventsRepository(db).get("evt_route_file"),
    ).toMatchObject({
      eventType: "price.updated",
      outcome: "price_not_tracked",
    });
  });

  // #441-T02
  it("is reached without a session through the access proxy, which neither redirects nor answers 401", async () => {
    const { route, signed } = await startRoute({ billing: "on" });
    const harness = await createAuthHarness();
    const proxy = createAccessProxy({
      getAuth: () => harness.auth,
      getGates: () => openGates,
    });
    const request = signed();

    const guard = await proxy(
      new NextRequest(request.url, {
        method: "POST",
        headers: request.headers,
        body: await request.clone().text(),
      }),
    );

    expect(guard.headers.get("x-middleware-next")).toBe("1");
    expect((await route.POST(request)).status).toBe(200);
  });
});
