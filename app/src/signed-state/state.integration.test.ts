// SPDX-License-Identifier: LicenseRef-Proprietary

// The signed single-use state of the round trips through GitHub: it works once, for the person and the
// session that started it, for its purpose only, until it expires, and a forged value is worthless.
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-support/test-database.ts";
import { insertUser } from "../test-support/users.ts";
import {
  createSignedStates,
  purposeOfState,
  SIGNED_STATE_TTL_MS,
} from "./state.ts";

const SECRET = "test-app-secret-0123456789-0123456789-abc";

async function setup() {
  const { db } = await createTestDatabase();
  const clock = { at: new Date("2026-10-12T10:00:00.000Z") };
  const states = createSignedStates({
    db,
    appSecret: SECRET,
    now: () => clock.at,
  });
  const admin = await insertUser(db, { id: "admin-1" });
  return { db, states, clock, admin };
}

describe("a signed state", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("is accepted once for the person and the session that started it", async () => {
    const value = await ctx.states.issue({
      purpose: "github-manifest",
      userId: "admin-1",
      sessionId: "session-a",
    });

    const first = await ctx.states.consume({
      purpose: "github-manifest",
      value,
      userId: "admin-1",
      sessionId: "session-a",
    });
    const second = await ctx.states.consume({
      purpose: "github-manifest",
      value,
      userId: "admin-1",
      sessionId: "session-a",
    });

    expect(first).toEqual({
      ok: true,
      codeVerifier: null,
      data: null,
      workspaceId: null,
    });
    expect(second).toEqual({ ok: false, error: "state_invalid" });
  });

  it("hands back the PKCE verifier that was stored with it", async () => {
    const value = await ctx.states.issue({
      purpose: "github-link",
      userId: "admin-1",
      sessionId: "session-a",
      codeVerifier: "verifier-value",
    });

    const result = await ctx.states.consume({
      purpose: "github-link",
      value,
      userId: "admin-1",
      sessionId: "session-a",
    });

    expect(result).toEqual({
      ok: true,
      codeVerifier: "verifier-value",
      data: null,
      workspaceId: null,
    });
  });

  it("hands back the facts of the flow that were stored with it", async () => {
    const value = await ctx.states.issue({
      purpose: "github-manifest",
      userId: "admin-1",
      sessionId: "session-a",
      data: { privateApp: true },
    });

    const result = await ctx.states.consume({
      purpose: "github-manifest",
      value,
      userId: "admin-1",
      sessionId: "session-a",
    });

    expect(result).toEqual({
      ok: true,
      codeVerifier: null,
      data: { privateApp: true },
      workspaceId: null,
    });
  });

  it("is refused after ten minutes", async () => {
    const value = await ctx.states.issue({
      purpose: "github-manifest",
      userId: "admin-1",
      sessionId: "session-a",
    });
    ctx.clock.at = new Date(ctx.clock.at.getTime() + SIGNED_STATE_TTL_MS);

    const result = await ctx.states.consume({
      purpose: "github-manifest",
      value,
      userId: "admin-1",
      sessionId: "session-a",
    });

    expect(result).toEqual({ ok: false, error: "state_invalid" });
  });

  it("is refused for another purpose, another person or another session, and those refusals do not use it up", async () => {
    const value = await ctx.states.issue({
      purpose: "github-manifest",
      userId: "admin-1",
      sessionId: "session-a",
    });

    const refusals = await Promise.all([
      ctx.states.consume({
        purpose: "github-link",
        value,
        userId: "admin-1",
        sessionId: "session-a",
      }),
      ctx.states.consume({
        purpose: "github-manifest",
        value,
        userId: "someone-else",
        sessionId: "session-a",
      }),
      ctx.states.consume({
        purpose: "github-manifest",
        value,
        userId: "admin-1",
        sessionId: "session-b",
      }),
    ]);
    const owner = await ctx.states.consume({
      purpose: "github-manifest",
      value,
      userId: "admin-1",
      sessionId: "session-a",
    });

    expect(refusals).toEqual(
      Array(3).fill({ ok: false, error: "state_invalid" }),
    );
    expect(owner.ok).toBe(true);
  });

  it("is refused when the value was changed, signed with another secret or made up", async () => {
    const value = await ctx.states.issue({
      purpose: "github-manifest",
      userId: "admin-1",
      sessionId: "session-a",
    });
    const other = createSignedStates({
      db: ctx.db,
      appSecret: `${SECRET}-other`,
      now: () => ctx.clock.at,
    });
    const foreign = await other.issue({
      purpose: "github-manifest",
      userId: "admin-1",
      sessionId: "session-a",
    });
    const [payload = "", mac = ""] = value.split(".");

    const attempts = await Promise.all(
      [
        `${payload}x.${mac}`,
        `${payload}.${mac.slice(1)}a`,
        foreign,
        "x.y",
        "",
      ].map((candidate) =>
        ctx.states.consume({
          purpose: "github-manifest",
          value: candidate,
          userId: "admin-1",
          sessionId: "session-a",
        }),
      ),
    );

    expect(attempts.every((attempt) => !attempt.ok)).toBe(true);
  });

  it("can be used by only one of two requests that arrive together", async () => {
    const value = await ctx.states.issue({
      purpose: "github-manifest",
      userId: "admin-1",
      sessionId: "session-a",
    });
    const input = {
      purpose: "github-manifest",
      value,
      userId: "admin-1",
      sessionId: "session-a",
    } as const;

    const results = await Promise.all([
      ctx.states.consume(input),
      ctx.states.consume(input),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it("is not a secret: the value holds no credential, only the nonce, the purpose and a hash of the session", async () => {
    const value = await ctx.states.issue({
      purpose: "github-manifest",
      userId: "admin-1",
      sessionId: "session-secret-token",
    });

    expect(
      Buffer.from(value.split(".")[0] ?? "", "base64url").toString(),
    ).not.toContain("session-secret-token");
  });
});

// What the signed value says, as the browser carries it: `<base64url JSON>.<mac>`.
function payloadOf(value: string): Record<string, unknown> {
  const [payload = ""] = value.split(".");
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

describe("a signed state for a workspace", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  // #103-IB-01
  it("holds the workspace, the person, a nonce and an expiry of ten minutes in its signed value, and its signature verifies", async () => {
    const value = await ctx.states.issue({
      purpose: "github-install",
      userId: "admin-1",
      sessionId: "session-a",
      workspaceId: "workspace-1",
    });

    const payload = payloadOf(value);
    expect(payload).toMatchObject({
      p: "github-install",
      u: "admin-1",
      w: "workspace-1",
    });
    expect(payload.n).toMatch(/^[0-9a-f]{32}$/);
    expect(payload.e).toBe(ctx.clock.at.getTime() + 10 * 60 * 1000);
    expect(
      await ctx.states.consume({
        purpose: "github-install",
        value,
        userId: "admin-1",
        sessionId: "session-a",
      }),
    ).toEqual({
      ok: true,
      codeVerifier: null,
      data: null,
      workspaceId: "workspace-1",
    });
  });

  // #103-IB-01
  it("is signed with a key of its own purpose: the same payload signed for another purpose of the app does not verify", async () => {
    const value = await ctx.states.issue({
      purpose: "github-install",
      userId: "admin-1",
      sessionId: "session-a",
      workspaceId: "workspace-1",
    });
    const [payload = ""] = value.split(".");
    const otherKey = createSignedStates({
      db: ctx.db,
      appSecret: "another-secret-0123456789-0123456789-abc",
      now: () => ctx.clock.at,
    });

    const result = await otherKey.consume({
      purpose: "github-install",
      value,
      userId: "admin-1",
      sessionId: "session-a",
    });

    expect(payload).not.toBe("");
    expect(result).toEqual({ ok: false, error: "state_invalid" });
  });

  // #103-IB-01
  it("cannot be pointed at another workspace: changing the workspace in the value breaks the signature", async () => {
    const value = await ctx.states.issue({
      purpose: "github-install",
      userId: "admin-1",
      sessionId: "session-a",
      workspaceId: "workspace-1",
    });
    const [payload = "", mac = ""] = value.split(".");
    const changed = Buffer.from(
      JSON.stringify({ ...payloadOf(value), w: "workspace-2" }),
      "utf8",
    ).toString("base64url");

    const result = await ctx.states.consume({
      purpose: "github-install",
      value: `${changed}.${mac}`,
      userId: "admin-1",
      sessionId: "session-a",
    });

    expect(payload).not.toBe(changed);
    expect(result).toEqual({ ok: false, error: "state_invalid" });
  });

  // #103-IB-01
  it("can be looked at without being used up, by the person and the session it was made for only", async () => {
    const value = await ctx.states.issue({
      purpose: "github-picker",
      userId: "admin-1",
      sessionId: "session-a",
      workspaceId: "workspace-1",
      data: { installations: [] },
    });
    const input = {
      purpose: "github-picker" as const,
      value,
      userId: "admin-1",
      sessionId: "session-a",
    };

    const first = await ctx.states.peek(input);
    const second = await ctx.states.peek(input);
    const other = await ctx.states.peek({ ...input, sessionId: "session-b" });
    const used = await ctx.states.consume(input);
    const afterUse = await ctx.states.peek(input);

    expect(first).toMatchObject({ ok: true, workspaceId: "workspace-1" });
    expect(second).toEqual(first);
    expect(other).toEqual({ ok: false, error: "state_invalid" });
    expect(used).toMatchObject({ ok: true });
    expect(afterUse).toEqual({ ok: false, error: "state_invalid" });
  });

  // #103-IB-01
  it("tells which flow a value belongs to when its signature is right, and nothing for a forged one", async () => {
    const value = await ctx.states.issue({
      purpose: "github-authorize",
      userId: "admin-1",
      sessionId: "session-a",
      workspaceId: "workspace-1",
    });

    expect(purposeOfState(SECRET, value)).toBe("github-authorize");
    expect(
      purposeOfState("another-secret-0123456789-0123456789-abc", value),
    ).toBeNull();
    expect(purposeOfState(SECRET, `${value}x`)).toBeNull();
    expect(purposeOfState(SECRET, "plain-random-state")).toBeNull();
  });
});
