// SPDX-License-Identifier: Apache-2.0

// Pins down how the answer of GitHub's "my membership in an organization" endpoint is read: only an
// active membership of the configured organization counts, and every answer that is not a clear yes
// or a clear no (missing scope, outage, malformed body, timeout) is "unavailable", never a yes.
import { describe, expect, it, vi } from "vitest";
import { checkOrgMembership } from "./github-org.ts";

type FetchImpl = typeof fetch;

function check(
  fetchImpl: FetchImpl,
  org = "my-org",
  log: (message: string) => void = () => undefined,
) {
  return checkOrgMembership({
    log,
    apiBaseUrl: "https://api.example.test",
    org,
    accessToken: "token-value",
    timeoutMs: 1000,
    fetchImpl,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const active = {
  state: "active",
  role: "member",
  organization: { login: "my-org" },
};

describe("checking the membership of the signed in account", () => {
  it("asks for the account's own membership with the account's token", async () => {
    const fetchImpl = vi.fn<FetchImpl>(() =>
      Promise.resolve(jsonResponse(200, active)),
    );

    await check(fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.example.test/user/memberships/orgs/my-org",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer token-value");
    expect(init?.redirect).toBe("manual");
  });

  // CR-19-T09
  it("is a member for an active membership", async () => {
    expect(await check(() => Promise.resolve(jsonResponse(200, active)))).toBe(
      "member",
    );
  });

  it("compares the organization name without regard to case", async () => {
    const answer = jsonResponse(200, {
      ...active,
      organization: { login: "My-Org" },
    });

    expect(await check(() => Promise.resolve(answer))).toBe("member");
  });

  it("is not a member for a pending invitation", async () => {
    const answer = jsonResponse(200, { ...active, state: "pending" });

    expect(await check(() => Promise.resolve(answer))).toBe("not_member");
  });

  // CR-19-T10
  it("is not a member when GitHub answers 404", async () => {
    const answer = jsonResponse(404, { message: "Not Found" });

    expect(await check(() => Promise.resolve(answer))).toBe("not_member");
  });

  it("reports an invalid token on 401", async () => {
    const answer = jsonResponse(401, { message: "Bad credentials" });

    expect(await check(() => Promise.resolve(answer))).toBe("token_invalid");
  });

  // CR-19-T11
  it.each([403, 429, 500, 502, 503, 201])(
    "cannot tell on status %i",
    async (status) => {
      const answer = new Response("{}", { status });

      expect(await check(() => Promise.resolve(answer))).toBe("unavailable");
    },
  );

  // CR-19-T11
  it.each([
    ["a body that is not JSON", new Response("<html>", { status: 200 })],
    [
      "a membership of another organization",
      jsonResponse(200, { ...active, organization: { login: "other" } }),
    ],
    ["no state", jsonResponse(200, { organization: { login: "my-org" } })],
    ["an unknown state", jsonResponse(200, { ...active, state: "suspended" })],
    ["a null body", jsonResponse(200, null)],
  ])("cannot tell on a 200 with %s", async (_case, answer) => {
    expect(await check(() => Promise.resolve(answer))).toBe("unavailable");
  });

  // CR-19-T11
  it("cannot tell when the request fails or times out", async () => {
    const failing = () => Promise.reject(new TypeError("fetch failed"));
    const timingOut = () =>
      Promise.reject(new DOMException("timed out", "TimeoutError"));

    expect(await check(failing)).toBe("unavailable");
    expect(await check(timingOut)).toBe("unavailable");
  });

  it("puts the organization name in the path as one segment", async () => {
    const fetchImpl = vi.fn<FetchImpl>(() =>
      Promise.resolve(jsonResponse(404, {})),
    );

    await check(fetchImpl, "a/../b");

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://api.example.test/user/memberships/orgs/a%2F..%2Fb",
    );
  });

  // CR-19-T11
  it.each([301, 302, 307, 308])(
    "cannot tell on a redirect (%i), never follows it, and says once what to fix",
    async (status) => {
      const org = `renamed-org-${String(status)}`;
      const log = vi.fn<(message: string) => void>();
      const fetchImpl = vi.fn<FetchImpl>(() =>
        Promise.resolve(
          new Response(null, {
            status,
            headers: { location: "https://elsewhere.example/steal" },
          }),
        ),
      );

      expect(await check(fetchImpl, org, log)).toBe("unavailable");
      expect(await check(fetchImpl, org, log)).toBe("unavailable");

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).toContain("ORG_CHECK_REDIRECTED");
      expect(line).toContain("ALLOWED_GITHUB_ORG");
      expect(line).not.toContain("token-value");
      expect(line).not.toContain("elsewhere");
    },
  );

  describe("when GitHub names the scopes of the token", () => {
    function withScopes(status: number, scopes: string): Response {
      return new Response("{}", {
        status,
        headers: { "x-oauth-scopes": scopes },
      });
    }

    it.each([403, 404])(
      "reports a token without read:org as invalid on %i, not as an answer about the membership",
      async (status) => {
        const answer = withScopes(status, "read:user");

        expect(await check(() => Promise.resolve(answer))).toBe(
          "token_invalid",
        );
      },
    );

    it("reports an empty scope list the same way", async () => {
      expect(await check(() => Promise.resolve(withScopes(404, "")))).toBe(
        "token_invalid",
      );
    });

    it.each(["read:user, read:org", "admin:org", "write:org,read:user"])(
      "reads a 404 as not a member when the scopes are %j",
      async (scopes) => {
        expect(
          await check(() => Promise.resolve(withScopes(404, scopes))),
        ).toBe("not_member");
      },
    );

    it("reads a 403 with the scope as unavailable (rate limit, organization policy)", async () => {
      expect(
        await check(() => Promise.resolve(withScopes(403, "read:org"))),
      ).toBe("unavailable");
    });
  });
});
