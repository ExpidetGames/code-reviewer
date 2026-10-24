// SPDX-License-Identifier: LicenseRef-Proprietary

// Who reaches the decision on a request to link an installation, with real requests through the real proxy and
// the real route over a real database and the real Better Auth (docs/decisions/0001-editions-setup-and-
// accounts.md, sections 2.3 and 2.9): the instance admin decides; a person who is not the admin gets the 404 of a
// path that does not exist (also from the route itself when the proxy is not in front), however high their role
// in a workspace is, and nothing is decided; a visitor without a session gets 401; the body is read the one
// way every route reads it. The decision itself is proven in approvals.integration.test.ts.
import { describe, expect, it } from "vitest";
import {
  MISSING_ANSWER_MARKER,
  createAdminHarness,
} from "../test-support/admin-harness.ts";

const MEMBER = { email: "member@example.com", password: "k4Pq-v8Zm2Xw" };
const DECIDE = "/api/admin/approvals/request-1";

async function startPortal() {
  const portal = await createAdminHarness();
  await portal.createUser({ id: "member-1", ...MEMBER });
  const memberCookies = await portal.signIn(MEMBER.email, MEMBER.password);
  return { portal, memberCookies };
}

describe("the decision on a request", () => {
  // #103-IB-21
  it("is a path that does not exist for a signed in person who is not the instance admin, and nothing is decided", async () => {
    const { portal, memberCookies } = await startPortal();

    const throughTheProxy = await portal.visit(DECIDE, {
      method: "POST",
      body: { decision: "approve" },
      cookies: memberCookies,
    });
    // The proxy is not in front: the route asks for the admin itself.
    const routeAlone = await portal.callRoute(
      "/api/instance-portal/approvals/request-1",
      {
        method: "POST",
        body: { decision: "approve" },
        cookies: memberCookies,
      },
    );

    expect(throughTheProxy.status).toBe(404);
    expect(throughTheProxy.headers.get(MISSING_ANSWER_MARKER)).toBe("1");
    expect(routeAlone.status).toBe(404);
    expect(portal.approvalCalls.count).toBe(0);
  });

  // #103-IB-21
  it("answers a visitor without a session with 401 and decides nothing", async () => {
    const { portal } = await startPortal();

    const response = await portal.visit(DECIDE, {
      method: "POST",
      body: { decision: "deny" },
    });

    expect(response.status).toBe(401);
    expect(portal.approvalCalls.count).toBe(0);
  });

  // #103-IB-21
  it.each(["approve", "deny"] as const)(
    "reaches the decision for the instance admin (%s)",
    async (decision) => {
      const { portal } = await startPortal();

      const response = await portal.visit(DECIDE, {
        method: "POST",
        body: { decision },
        cookies: portal.adminCookies,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(portal.approvalCalls.count).toBe(1);
    },
  );

  // #103-IB-21
  it("reads the body like every JSON route: same site, application/json, one object with the one field", async () => {
    const { portal } = await startPortal();
    const decide = (init: {
      body?: unknown;
      headers?: Record<string, string>;
    }) =>
      portal.visit(DECIDE, {
        method: "POST",
        cookies: portal.adminCookies,
        ...init,
      });

    const crossSite = await decide({
      body: { decision: "approve" },
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    });
    const text = await decide({
      body: '{"decision":"approve"}',
      headers: { "content-type": "text/plain" },
    });
    const notAnObject = await decide({ body: "[1]" });
    const unknownDecision = await decide({ body: { decision: "maybe" } });
    const extraField = await decide({
      body: { decision: "approve", workspaceId: "other" },
    });

    expect(crossSite.status).toBe(403);
    expect(text.status).toBe(415);
    expect(notAnObject.status).toBe(422);
    expect(unknownDecision.status).toBe(422);
    expect(extraField.status).toBe(422);
    expect(portal.approvalCalls.count).toBe(0);
  });
});
