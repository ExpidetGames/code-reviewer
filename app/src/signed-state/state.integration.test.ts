// SPDX-License-Identifier: Apache-2.0

// The signed single-use state of the round trips through GitHub: it works once, for the person and the
// session that started it, for its purpose only, until it expires, and a forged value is worthless.
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-support/test-database.ts";
import { insertUser } from "../test-support/users.ts";
import { createSignedStates, SIGNED_STATE_TTL_MS } from "./state.ts";

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

    expect(first).toEqual({ ok: true, codeVerifier: null });
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

    expect(result).toEqual({ ok: true, codeVerifier: "verifier-value" });
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
