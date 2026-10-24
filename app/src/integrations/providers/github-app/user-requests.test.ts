// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls made with a person's own GitHub token (the binding of an installation to a workspace): whose token
// it is, which installations it can use (every page), and the person's role in an organization. A 401 is "the
// authorization is no good", GitHub that cannot be asked is something else, a 403 on the role is "unreadable",
// and neither the token nor a response body appears in anything the calls return.
import { describe, expect, it, vi } from "vitest";
import {
  listUserInstallations,
  readOrganizationRole,
  readUser,
} from "./user-requests.ts";

const TOKEN = "gho_dummy-user-token-0123456789";

function answer(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function options(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const fetchMock = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) =>
      respond(String(url), init ?? {}),
  );
  return {
    options: {
      apiBaseUrl: "https://api.github.test",
      fetch: fetchMock as unknown as typeof fetch,
    },
    fetchMock,
  };
}

describe("whose token it is", () => {
  // #103-IB-08
  it("reads the id and the login, sending the token as a bearer token and following no redirect", async () => {
    const { options: o, fetchMock } = options(() =>
      answer(200, { id: 1001, login: "octo", name: "Octo" }),
    );

    const result = await readUser(o, TOKEN);

    expect(result).toEqual({ ok: true, user: { id: 1001, login: "octo" } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.github.test/user");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(init.redirect).toBe("error");
  });

  // #103-IB-09
  it.each([
    [401, "authorization_invalid"],
    [403, "authorization_invalid"],
    [500, "unavailable"],
    [429, "unavailable"],
    [404, "unavailable"],
  ] as const)("answers %s with %s", async (status, error) => {
    const { options: o } = options(() => answer(status));

    expect(await readUser(o, TOKEN)).toEqual({ ok: false, error });
  });

  // #103-IB-09
  it("does not trust an answer without an id or a login, and survives a network failure", async () => {
    const odd = options(() => answer(200, { id: "1001", login: "octo" }));
    const down = options(() => {
      throw new TypeError(`fetch failed for ${TOKEN}`);
    });

    expect(await readUser(odd.options, TOKEN)).toEqual({
      ok: false,
      error: "unavailable",
    });
    const failed = await readUser(down.options, TOKEN);
    expect(failed).toEqual({ ok: false, error: "unavailable" });
    expect(JSON.stringify(failed)).not.toContain(TOKEN);
  });
});

describe("the installations a token can use", () => {
  const installation = (id: number, login: string, type = "Organization") => ({
    id,
    account: { login, id: id * 10, type },
    suspended_at: null,
  });

  // #103-IB-05
  it("reads every page and maps the installations", async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      installation(index + 1, `org-${String(index + 1)}`),
    );
    const { options: o, fetchMock } = options((url) => {
      const page = new URL(url).searchParams.get("page");
      return page === "1"
        ? answer(200, { total_count: 101, installations: first })
        : answer(200, {
            total_count: 101,
            installations: [
              {
                ...installation(101, "last", "User"),
                suspended_at: "2026-10-01T00:00:00Z",
              },
            ],
          });
    });

    const result = await listUserInstallations(o, TOKEN);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.installations).toHaveLength(101);
    expect(result.installations.at(-1)).toEqual({
      id: "101",
      accountLogin: "last",
      accountId: 1010,
      accountType: "User",
      suspended: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // #103-IB-05
  it("leaves out a record whose account has no login or type, and keeps the others", async () => {
    const { options: o } = options(() =>
      answer(200, {
        installations: [
          installation(1, "acme"),
          { id: 2, account: { id: 20 } },
        ],
      }),
    );

    const result = await listUserInstallations(o, TOKEN);

    expect(result).toEqual({
      ok: true,
      installations: [
        expect.objectContaining({ id: "1", accountLogin: "acme" }),
      ],
    });
  });

  // #103-IB-09
  it("fails as a whole when a page cannot be read, or the answer is not a listing", async () => {
    const second = options((url) =>
      new URL(url).searchParams.get("page") === "1"
        ? answer(200, {
            installations: Array.from({ length: 100 }, (_, i) =>
              installation(i + 1, "x"),
            ),
          })
        : answer(503),
    );
    const odd = options(() => answer(200, { installations: "nope" }));
    const revoked = options(() => answer(401));

    expect(await listUserInstallations(second.options, TOKEN)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(await listUserInstallations(odd.options, TOKEN)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(await listUserInstallations(revoked.options, TOKEN)).toEqual({
      ok: false,
      error: "authorization_invalid",
    });
  });

  // #103-IB-09
  it("stops at a hard limit of pages instead of looping, and reports it as a failure", async () => {
    const { options: o, fetchMock } = options(() =>
      answer(200, {
        installations: Array.from({ length: 100 }, (_, i) =>
          installation(i + 1, "x"),
        ),
      }),
    );

    const result = await listUserInstallations(o, TOKEN);

    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(20);
  });
});

describe("the role in an organization", () => {
  // #103-IB-03
  it("takes only an active admin for an owner", async () => {
    const owner = options(() =>
      answer(200, { state: "active", role: "admin" }),
    );
    const member = options(() =>
      answer(200, { state: "active", role: "member" }),
    );
    const billing = options(() =>
      answer(200, { state: "active", role: "billing_manager" }),
    );
    const invited = options(() =>
      answer(200, { state: "pending", role: "admin" }),
    );

    expect(await readOrganizationRole(owner.options, TOKEN, "acme")).toEqual({
      ok: true,
      role: { kind: "admin" },
    });
    for (const h of [member, billing, invited])
      expect(await readOrganizationRole(h.options, TOKEN, "acme")).toEqual({
        ok: true,
        role: { kind: "member" },
      });
  });

  // #103-IB-04
  it("says that a person GitHub does not know as a member is not one", async () => {
    const { options: o } = options(() => answer(404));

    expect(await readOrganizationRole(o, TOKEN, "acme")).toEqual({
      ok: true,
      role: { kind: "not_a_member" },
    });
  });

  // #103-IB-19
  it.each([
    [403, "forbidden"],
    [422, "unexpected"],
  ] as const)("calls a %s an unreadable role (%s)", async (status, detail) => {
    const { options: o } = options(() => answer(status));

    expect(await readOrganizationRole(o, TOKEN, "acme")).toEqual({
      ok: true,
      role: { kind: "unreadable", detail },
    });
  });

  // #103-IB-19
  it("calls an answer it cannot read an unreadable role", async () => {
    const { options: o } = options(() => answer(200, { role: 5 }));

    expect(await readOrganizationRole(o, TOKEN, "acme")).toEqual({
      ok: true,
      role: { kind: "unreadable", detail: "unexpected" },
    });
  });

  // #103-IB-09
  it("tells a refused authorization and GitHub that cannot be asked from a role it cannot read", async () => {
    const revoked = options(() => answer(401));
    const down = options(() => answer(503));

    expect(await readOrganizationRole(revoked.options, TOKEN, "acme")).toEqual({
      ok: false,
      error: "authorization_invalid",
    });
    expect(await readOrganizationRole(down.options, TOKEN, "acme")).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  // #103-IB-16
  it("puts only a well formed organization name into the address", async () => {
    const { options: o, fetchMock } = options(() =>
      answer(200, { state: "active", role: "admin" }),
    );

    const result = await readOrganizationRole(o, TOKEN, "../user");

    expect(result).toEqual({
      ok: true,
      role: { kind: "unreadable", detail: "unexpected" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await readOrganizationRole(o, TOKEN, "acme-inc");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.test/user/memberships/orgs/acme-inc",
    );
  });
});
