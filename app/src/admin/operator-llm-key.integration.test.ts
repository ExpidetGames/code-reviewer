// SPDX-License-Identifier: Apache-2.0

// The operator's own LLM key in the admin portal (#276), end to end over a real database, the real proxy and the
// real data route: only an instance admin saves or removes it, it is write-only (the settings carry the status
// and the last four characters, nothing else), it is stored encrypted, and it is in no answer, page or log line.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceLlm } from "../llm/assemble.ts";
import {
  createAdminHarness,
  type AdminHarness,
} from "../test-support/admin-harness.ts";
import { SETUP_TEST_SECRET } from "../test-support/setup-harness.ts";

const KEY = "sk-or-v1-operator-key-0123456789abcdef-wxyz";
const OTHER_KEY = "sk-or-v1-operator-key-fedcba9876543210-abcd";
const MEMBER = { email: "member@example.com", password: "k4Pq-v8Zm2Xw" };

function put(
  portal: AdminHarness,
  body: unknown,
  cookies = portal.adminCookies,
) {
  return portal.visit("/api/admin/settings", { method: "PUT", body, cookies });
}

async function statusOf(portal: AdminHarness) {
  const read = await portal.visit("/api/admin/settings", {
    cookies: portal.adminCookies,
  });
  return (await read.json()) as {
    operatorLlmKey: Record<string, unknown>;
    secrets: Array<Record<string, unknown>>;
  };
}

/** What the resolver would get, with the master key of the harness. */
function operatorKeyOf(portal: AdminHarness) {
  return createWorkspaceLlm({
    db: portal.db,
    appSecret: () => SETUP_TEST_SECRET,
    env: () => ({}),
  })
    .operatorKey()
    .forJob();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("saving the operator's key", () => {
  // #276-T06
  it("stores it encrypted, and every answer carries the status and the last four characters only", async () => {
    const portal = await createAdminHarness();
    expect(await statusOf(portal)).toMatchObject({
      operatorLlmKey: { state: "not_configured" },
    });

    const response = await put(portal, { operatorLlmKey: { apiKey: KEY } });
    const answer = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(answer).not.toContain(KEY);
    expect(answer).not.toContain(KEY.slice(0, -4));
    expect(JSON.parse(answer).settings.operatorLlmKey).toMatchObject({
      state: "configured",
      lastFour: "wxyz",
    });
    const read = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });
    const text = await read.text();
    expect(text).not.toContain(KEY.slice(0, -4));
    expect(JSON.parse(text).secrets).toContainEqual(
      expect.objectContaining({
        name: "operator_llm_key",
        state: "configured",
        lastFour: "wxyz",
      }),
    );
    const stored = await portal.db.selectFrom("secrets").selectAll().execute();
    expect(JSON.stringify(stored)).not.toContain(KEY.slice(0, -4));
    expect(stored.map((row) => row.name)).toContain("operator_llm_key");
    // What the app reads back with its master key is the key.
    expect(await operatorKeyOf(portal)).toEqual({ state: "key", apiKey: KEY });
  });

  // #276-T06
  it("writes the key into no log line, not even while it cannot be read", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    const portal = await createAdminHarness();

    await put(portal, { operatorLlmKey: { apiKey: KEY } });
    await put(portal, { operatorLlmKey: { apiKey: "has a space" } });
    await portal.db.updateTable("secrets").set({ nonce: "AAAA" }).execute();
    const broken = await statusOf(portal);

    expect(broken.operatorLlmKey).toMatchObject({ state: "unreadable" });
    expect(JSON.stringify(broken)).not.toContain(KEY.slice(0, -4));
    expect(lines.join("\n")).not.toContain(KEY.slice(0, -4));
    expect(lines.join("\n")).not.toContain("has a space");
  });

  // #276-T06
  it("replaces the key, and removes it with null", async () => {
    const portal = await createAdminHarness();
    await put(portal, { operatorLlmKey: { apiKey: KEY } });

    await put(portal, { operatorLlmKey: { apiKey: OTHER_KEY } });
    expect(await operatorKeyOf(portal)).toEqual({
      state: "key",
      apiKey: OTHER_KEY,
    });
    expect((await statusOf(portal)).operatorLlmKey).toMatchObject({
      lastFour: "abcd",
    });

    const removed = await put(portal, { operatorLlmKey: null });

    expect(removed.status).toBe(200);
    expect(await operatorKeyOf(portal)).toEqual({ state: "none" });
    expect((await statusOf(portal)).operatorLlmKey).toEqual({
      state: "not_configured",
    });
    // Removing what is not there is not an error.
    expect((await put(portal, { operatorLlmKey: null })).status).toBe(200);
  });

  // #276-T06
  it("refuses a key that is empty or has a space, and a value that is no key, with the names of the fields and nothing changes", async () => {
    const portal = await createAdminHarness();
    await put(portal, { operatorLlmKey: { apiKey: KEY } });

    for (const [body, issues] of [
      [
        { operatorLlmKey: { apiKey: "" } },
        [{ field: "apiKey", code: "api_key_required" }],
      ],
      [{ operatorLlmKey: {} }, [{ field: "apiKey", code: "api_key_required" }]],
      [
        { operatorLlmKey: { apiKey: "with space inside" } },
        [{ field: "apiKey", code: "api_key_invalid" }],
      ],
      [
        { operatorLlmKey: { apiKey: 12345 } },
        [{ field: "apiKey", code: "api_key_invalid" }],
      ],
      [
        { operatorLlmKey: "sk-or-v1-as-a-bare-string-0123456789" },
        [{ field: "operatorLlmKey", code: "operator_llm_key_invalid" }],
      ],
      [
        { operatorLlmKey: ["a"] },
        [{ field: "operatorLlmKey", code: "operator_llm_key_invalid" }],
      ],
    ] as const) {
      const response = await put(portal, body);
      const text = await response.text();

      expect(response.status).toBe(422);
      expect(JSON.parse(text)).toEqual({ error: "invalid_input", issues });
      expect(text).not.toContain("with space inside");
      expect(text).not.toContain("bare-string");
    }
    expect(await operatorKeyOf(portal)).toEqual({ state: "key", apiKey: KEY });
  });

  // #276-T06
  it("refuses a request from another site", async () => {
    const portal = await createAdminHarness();

    const response = await portal.visit("/api/admin/settings", {
      method: "PUT",
      body: { operatorLlmKey: { apiKey: KEY } },
      cookies: portal.adminCookies,
      headers: { "sec-fetch-site": "cross-site", origin: "https://evil.test" },
    });

    expect(response.status).toBe(403);
    expect(await operatorKeyOf(portal)).toEqual({ state: "none" });
  });
});

describe("who can read or write the operator's key", () => {
  // #276-T07
  it("is nobody but an instance admin: a person who is not an admin gets the answer of a missing path and nothing changes", async () => {
    const portal = await createAdminHarness();
    await put(portal, { operatorLlmKey: { apiKey: KEY } });
    await portal.createUser({ id: "member-1", ...MEMBER });
    const memberCookies = await portal.signIn(MEMBER.email, MEMBER.password);
    const before = await portal.db.selectFrom("secrets").selectAll().execute();

    const read = await portal.visit("/api/admin/settings", {
      cookies: memberCookies,
    });
    const write = await put(portal, { operatorLlmKey: null }, memberCookies);
    const overwrite = await put(
      portal,
      { operatorLlmKey: { apiKey: OTHER_KEY } },
      memberCookies,
    );
    const page = await portal.visit("/admin/llm", { cookies: memberCookies });

    for (const response of [read, write, overwrite, page]) {
      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).not.toContain(KEY.slice(0, -4));
      expect(text).not.toContain("operator_llm_key");
    }
    expect(await portal.db.selectFrom("secrets").selectAll().execute()).toEqual(
      before,
    );
  });

  // #276-T07
  it("is not reachable without a session: nobody gets a status, and a bearer token (the operator API's) is no session", async () => {
    const portal = await createAdminHarness();
    await put(portal, { operatorLlmKey: { apiKey: KEY } });

    for (const headers of [
      {} as Record<string, string>,
      { authorization: "Bearer test-operator-token-3b8e1d-6a40f2c97e15" },
      { authorization: "Bearer test-runner-token-4f9c2a7e1b-0d58a3c6e9f2" },
    ]) {
      const read = await portal.visit("/api/admin/settings", { headers });
      const write = await portal.visit("/api/admin/settings", {
        method: "PUT",
        body: { operatorLlmKey: null },
        headers,
      });

      for (const response of [read, write]) {
        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain("operator_llm_key");
      }
    }
    expect(await operatorKeyOf(portal)).toEqual({ state: "key", apiKey: KEY });
  });
});
