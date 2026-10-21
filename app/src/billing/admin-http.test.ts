// SPDX-License-Identifier: Apache-2.0

// The second guard of the billing data routes (#504): the proxy turns anonymous and non-admin callers away before a route
// runs, but each handler checks the caller itself, first, and reaches nothing behind it for anybody who is not the instance
// admin. The handlers are called directly (no proxy in front) with a service that fails the test if it is touched.
import { describe, expect, it, vi } from "vitest";
import type { AdminAccess } from "../admin/access.ts";
import type { BillingCreditService } from "./admin-credit-service.ts";
import { createBillingRouteHandlers } from "./admin-http.ts";
import type { BillingReviewService } from "./admin-review-service.ts";
import type { BillingAdminService } from "./admin-service.ts";

class NotFoundSignal extends Error {}

function untouchable<T extends object>(reached: string[] = []): T {
  return new Proxy(
    {},
    {
      get(_target, name) {
        return () => {
          reached.push(String(name));
          throw new Error(`the service was reached: ${String(name)}`);
        };
      },
    },
  ) as T;
}

function handlersFor(access: AdminAccess) {
  const reached: string[] = [];
  const service = untouchable<BillingAdminService>(reached);
  const credit = untouchable<BillingCreditService>(reached);
  const reviews = untouchable<BillingReviewService>(reached);
  const notFound = vi.fn((): never => {
    throw new NotFoundSignal("not found");
  });
  const handlers = createBillingRouteHandlers({
    access: () => Promise.resolve(access),
    notFound,
    service,
    credit,
    reviews,
  });
  return { handlers, notFound, reached };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://reviews.example.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://reviews.example.test",
    },
    body: JSON.stringify(body),
  });
}

const CALLS = [
  ["get", (h: Handlers) => h.get(new Request("https://x.test/api"))],
  [
    "put",
    (h: Handlers) =>
      h.put(
        new Request("https://x.test/api", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        }),
      ),
  ],
  ["check", (h: Handlers) => h.check(post("/check", {}))],
  [
    "webhookEndpoint",
    (h: Handlers) => h.webhookEndpoint(post("/webhook-endpoint", {})),
  ],
  [
    "searchWorkspaces",
    (h: Handlers) =>
      h.searchWorkspaces(new Request("https://x.test/api?q=acme")),
  ],
  [
    "workspace",
    (h: Handlers) => h.workspace(new Request("https://x.test/api"), "ws-1"),
  ],
  [
    "credit",
    (h: Handlers) =>
      h.credit(
        post("/credit", {
          type: "credit",
          amountMicroUsd: 1_000_000,
          note: "gift",
          requestId: "r-1",
        }),
        "ws-1",
      ),
  ],
  // #603-T03
  ["reviews", (h: Handlers) => h.reviews(new Request("https://x.test/api"))],
  [
    "resolveReview",
    (h: Handlers) =>
      h.resolveReview(
        post("/reviews/resolve", {
          provider: "stripe",
          eventId: "evt_1",
          note: "done",
        }),
      ),
  ],
  [
    "checkReview",
    (h: Handlers) =>
      h.checkReview(
        post("/reviews/check", { provider: "stripe", eventId: "evt_1" }),
      ),
  ],
] as const;
type Handlers = ReturnType<typeof createBillingRouteHandlers>;

describe("the handlers of the billing data routes check the caller themselves", () => {
  // #504-T17
  it.each(CALLS)(
    "%s answers 401 to nobody signed in and reaches no service",
    async (_name, call) => {
      const { handlers, notFound, reached } = handlersFor({
        kind: "anonymous",
      });

      const response = await call(handlers);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(notFound).not.toHaveBeenCalled();
      expect(reached).toEqual([]);
    },
  );

  // #504-T17
  it.each(CALLS)(
    "%s answers the missing path to somebody who is not an admin and reaches no service",
    async (_name, call) => {
      const { handlers, notFound, reached } = handlersFor({
        kind: "not_admin",
      });

      await expect(call(handlers)).rejects.toBeInstanceOf(NotFoundSignal);

      expect(notFound).toHaveBeenCalledTimes(1);
      expect(reached).toEqual([]);
    },
  );

  // #504-T17
  it("serves the instance admin, whose id the service sees", async () => {
    const view = vi.fn(() => Promise.resolve({ enabled: false }));
    const handlers = createBillingRouteHandlers({
      access: () =>
        Promise.resolve({
          kind: "admin",
          user: { id: "admin-1" } as Extract<
            AdminAccess,
            { kind: "admin" }
          >["user"],
        }),
      notFound: () => {
        throw new NotFoundSignal("not found");
      },
      service: { view } as unknown as BillingAdminService,
      credit: untouchable<BillingCreditService>(),
      reviews: untouchable<BillingReviewService>(),
    });

    const response = await handlers.get(new Request("https://x.test/api"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
    expect(view).toHaveBeenCalledTimes(1);
  });
});
