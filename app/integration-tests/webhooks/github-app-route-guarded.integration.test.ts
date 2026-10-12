// SPDX-License-Identifier: Apache-2.0

// Pins down that the login protection and the webhook route work together: the access proxy (real
// Better Auth, real database) lets a request without a session reach `/api/webhooks/github-app`, and
// the real route file answers it exactly as it does without the protection in front. The guard must
// neither redirect nor answer 401 for it; only the route's own signature check may refuse.
import { NextRequest } from "next/server";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  webhookDelivery,
  webhookFixture,
  type WebhookDeliveryOptions,
} from "../../../fakes/github/webhooks.ts";
import { createAccessProxy } from "../../src/auth/access-proxy.ts";
import {
  closeDatabase,
  getDatabase,
  initializeDatabaseOnStart,
} from "../../src/db/startup.ts";
import { createAuthHarness } from "../../src/test-support/auth-harness.ts";
import {
  TEST_WEBHOOK_SECRET,
  testGithubAppEnv,
} from "../../src/test-support/github-app.ts";
import { saveGithubAppFromEnv } from "../../src/test-support/server-credentials.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import { openGates } from "../../src/test-support/open-gates.ts";

type Route = typeof import("../../src/app/api/webhooks/github-app/route.ts");

const WEBHOOK_URL = "https://app.test/api/webhooks/github-app";

async function startGuardedRoute() {
  const harness = await createAuthHarness();
  const proxy = createAccessProxy({
    getAuth: () => harness.auth,
    getGates: () => openGates,
  });
  const env = testGithubAppEnv();
  for (const [name, value] of Object.entries(env))
    if (value !== undefined) vi.stubEnv(name, value);
  await initializeDatabaseOnStart({
    env: {
      DATABASE_PATH: join(await createTestDirectory(), "app.db"),
    },
  });
  await saveGithubAppFromEnv(getDatabase(), env);
  vi.resetModules();
  const route: Route =
    await import("../../src/app/api/webhooks/github-app/route.ts");

  /** What the server does with a request: the proxy first, the route only if the proxy lets it by. */
  async function send(options: Partial<WebhookDeliveryOptions> = {}) {
    const build = () =>
      webhookDelivery({
        event: "ping",
        payload: webhookFixture("ping"),
        secret: TEST_WEBHOOK_SECRET,
        url: WEBHOOK_URL,
        ...options,
      });
    const guardRequest = build();
    const guard = await proxy(
      new NextRequest(guardRequest.url, {
        method: "POST",
        headers: guardRequest.headers,
        body: await guardRequest.text(),
      }),
    );
    const passed = guard.headers.get("x-middleware-next") === "1";
    return {
      guard,
      passed,
      response: passed ? await route.POST(build()) : guard,
      direct: await route.POST(build()),
    };
  }
  return { send };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
});

// #102-GH-10 (regression): unchanged by the move of the GitHub App into the database.
describe("the webhook route behind the login protection", () => {
  // CR-43-T02
  it("is reached by a signed delivery without a session and answers as it does without the protection", async () => {
    const { send } = await startGuardedRoute();

    const { guard, passed, response, direct } = await send();

    expect(passed).toBe(true);
    expect(guard.status).toBe(200);
    expect(response.status).toBe(direct.status);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(await direct.json());
  });

  // CR-43-T02
  it("leaves the refusal of a wrong signature to the route, not to the protection", async () => {
    const { send } = await startGuardedRoute();

    const { passed, response } = await send({ signature: "sha256=00" });

    expect(passed).toBe(true);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "WEBHOOK_SIGNATURE_INVALID",
    });
  });
});
