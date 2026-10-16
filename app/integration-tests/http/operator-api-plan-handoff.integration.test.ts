// SPDX-License-Identifier: Apache-2.0

// The operator API of the plan handoff (#284) against a real database: redeeming the token an Owner or Admin was
// handed over with, and the setting of the operator-configured page. The format is checked against the contract file in
// compatibility/operator-api-contract.integration.test.ts, the route files in operator-api-route-files.integration.test.ts.
import { describe, expect, it } from "vitest";
import {
  createHandoffToken,
  hashHandoffToken,
} from "../../src/plan-handoff/token.ts";
import {
  NotFoundMarker,
  startOperatorApiHarness,
} from "../../src/test-support/operator-api-harness.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";

const FIVE_MINUTES = 5 * 60 * 1000;
const REDEEM = "/api/operator/v1/handoff/redeem";
const SETTING = "/api/operator/v1/plan-management";

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function start() {
  const h = await startOperatorApiHarness();
  await signedInMember(h.db, {
    id: "owner-1",
    workspaceId: h.workspaceId,
    role: "owner",
  });
  await signedInMember(h.db, {
    id: "admin-1",
    workspaceId: h.workspaceId,
    role: "admin",
  });
  /** Makes a token the way the route does and returns what the browser carries. */
  async function handoff(userId: string, role: "owner" | "admin") {
    const token = createHandoffToken();
    await h.handoffTokens(h.workspaceId).issue({
      tokenHash: hashHandoffToken(token),
      userId,
      role,
      ttlMs: FIVE_MINUTES,
    });
    return token;
  }
  return { ...h, handoff };
}

describe("redeeming a handoff token", () => {
  // #284-T03
  it.each([
    ["owner-1", "owner"],
    ["admin-1", "admin"],
  ] as const)(
    "answers the workspace, the role and an opaque user id for %s, and uses the token up",
    async (userId, role) => {
      const h = await start();
      const token = await h.handoff(userId, role);

      const response = await h.call("POST", REDEEM, { body: { token } });

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await json(response)).toEqual({
        version: 1,
        workspaceId: h.workspaceId,
        workspaceSlug: "default",
        userId,
        role,
      });
      const again = await h.call("POST", REDEEM, { body: { token } });
      expect(again.status).toBe(422);
      expect(await json(again)).toEqual({ version: 1, error: "invalid_token" });
    },
  );

  // #284-T04
  it("gives one answer to an unknown, used, expired and malformed token", async () => {
    const h = await start();
    const used = await h.handoff("owner-1", "owner");
    await h.call("POST", REDEEM, { body: { token: used } });
    const expired = await h.handoff("admin-1", "admin");
    // The harness starts at 12:00:00 and the tokens above were made then.
    h.setNow(new Date("2026-10-14T12:05:00.000Z"));
    const answers: Array<[number, string]> = [];

    for (const token of [
      createHandoffToken(),
      used,
      expired,
      "short",
      "x".repeat(500),
    ]) {
      const response = await h.call("POST", REDEEM, { body: { token } });
      answers.push([response.status, JSON.stringify(await json(response))]);
    }

    expect(answers).toHaveLength(5);
    expect(new Set(answers.map((answer) => answer.join(" "))).size).toBe(1);
    expect(answers[0]).toEqual([
      422,
      JSON.stringify({ version: 1, error: "invalid_token" }),
    ]);
  });

  // #284-T04
  it("honours a token for the whole five minutes and not a moment longer", async () => {
    const h = await start();
    const early = await h.handoff("owner-1", "owner");
    const late = await h.handoff("admin-1", "admin");

    h.setNow(new Date("2026-10-14T12:04:59.999Z"));
    expect(
      (await h.call("POST", REDEEM, { body: { token: early } })).status,
    ).toBe(200);
    h.setNow(new Date("2026-10-14T12:05:00.000Z"));
    expect(
      (await h.call("POST", REDEEM, { body: { token: late } })).status,
    ).toBe(422);
  });

  // #284-T05
  it("answers invalid_token when the Owner was demoted or removed within the five minutes", async () => {
    const h = await start();
    const demoted = await h.handoff("owner-1", "owner");
    const removed = await h.handoff("admin-1", "admin");
    const members = (
      await import("../../src/db/repositories/workspace-members-repository.ts")
    ).createWorkspaceMembersRepository(h.db, h.workspaceId);
    await members.setRole("owner-1", "member");
    await members.remove("admin-1");

    for (const token of [demoted, removed]) {
      const response = await h.call("POST", REDEEM, { body: { token } });
      expect(response.status).toBe(422);
      expect(await json(response)).toEqual({
        version: 1,
        error: "invalid_token",
      });
    }
  });

  // #284-T12
  it("answers invalid_token for the older token of a person who clicked again", async () => {
    const h = await start();
    const older = await h.handoff("owner-1", "owner");
    const newer = await h.handoff("owner-1", "owner");

    expect(
      (await h.call("POST", REDEEM, { body: { token: older } })).status,
    ).toBe(422);
    expect(
      (await h.call("POST", REDEEM, { body: { token: newer } })).status,
    ).toBe(200);
  });

  // #284-T09
  it("needs the operator token: a missing or wrong one is 401, and no token is used up", async () => {
    const h = await start();
    const token = await h.handoff("owner-1", "owner");

    for (const options of [
      { token: null },
      { token: "wrong-token-0123456789-0123456789" },
    ]) {
      const response = await h.call("POST", REDEEM, {
        ...options,
        body: { token },
      });
      expect(response.status).toBe(401);
      expect(await json(response)).toEqual({
        version: 1,
        error: "unauthorized",
      });
    }
    expect((await h.call("POST", REDEEM, { body: { token } })).status).toBe(
      200,
    );
  });

  // #284-T09
  it("is a path that does not exist while the operator API is off", async () => {
    const h = await startOperatorApiHarness({ token: undefined });

    await expect(
      h.call("POST", REDEEM, { body: { token: "x" } }),
    ).rejects.toBeInstanceOf(NotFoundMarker);
    await expect(h.call("GET", SETTING)).rejects.toBeInstanceOf(NotFoundMarker);
    expect(h.lines).toEqual([]);
  });

  // #284-T09
  it("takes a POST only, with a JSON body of the allowed size", async () => {
    const h = await start();

    const get = await h.call("GET", REDEEM);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(
      (
        await h.call("POST", REDEEM, {
          rawBody: "{}",
          contentType: "text/plain",
        })
      ).status,
    ).toBe(415);
    expect(
      (await h.call("POST", REDEEM, { rawBody: "x".repeat(20_000) })).status,
    ).toBe(413);
    for (const rawBody of [
      "not json",
      "[]",
      "{}",
      '{"token":7}',
      '{"token":null}',
    ])
      expect((await h.call("POST", REDEEM, { rawBody })).status).toBe(400);
  });

  // #284-T10
  it("holds no email, name, repository or token anywhere in its answers and its logs", async () => {
    const h = await start();
    const token = await h.handoff("owner-1", "owner");
    const unknown = createHandoffToken();

    const ok = await h.call("POST", REDEEM, { body: { token } });
    const refused = await h.call("POST", REDEEM, { body: { token: unknown } });
    const okText = await ok.text();
    const text = `${okText}${await refused.text()}`;
    const everything = `${text}\n${h.lines.join("\n")}\n${h.errors.join("\n")}`;

    expect(Object.keys(JSON.parse(okText) as object)).toEqual([
      "version",
      "workspaceId",
      "workspaceSlug",
      "userId",
      "role",
    ]);
    expect(everything).not.toContain("@");
    expect(everything).not.toContain("owner-1@");
    for (const secret of [token, unknown]) {
      expect(everything).not.toContain(secret);
      expect(everything).not.toContain(hashHandoffToken(secret));
    }
    expect(h.lines).toContain(
      `[operator-api] handoff workspace=${h.workspaceId} result=ok`,
    );
    expect(h.lines).toContain(
      "[operator-api] handoff workspace=- result=invalid_token",
    );
  });
});

describe("the plan management page setting", () => {
  // #284-T01
  it("reads as null on an instance that never set it", async () => {
    const h = await start();

    const response = await h.call("GET", SETTING);

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      version: 1,
      planManagementUrl: null,
    });
  });

  // #284-T11
  it("saves a valid https address in its normal form, replaces it and removes it", async () => {
    const h = await start();

    const saved = await h.call("PUT", SETTING, {
      body: { url: "https://plans.example" },
    });
    expect(saved.status).toBe(200);
    expect(await json(saved)).toEqual({
      version: 1,
      planManagementUrl: "https://plans.example/",
    });
    expect(await json(await h.call("GET", SETTING))).toMatchObject({
      planManagementUrl: "https://plans.example/",
    });
    expect(
      (
        await h.db
          .selectFrom("instance_settings")
          .select("updated_by")
          .where("key", "=", "plan_management_url")
          .executeTakeFirstOrThrow()
      ).updated_by,
    ).toBeNull();

    const removed = await h.call("DELETE", SETTING);
    expect(await json(removed)).toEqual({
      version: 1,
      planManagementUrl: null,
    });
    expect(await json(await h.call("GET", SETTING))).toMatchObject({
      planManagementUrl: null,
    });
  });

  // #284-T11
  it.each([
    ["http:", "http://plans.example/", "url_not_https"],
    ["credentials", "https://user:pw@plans.example/", "url_has_credentials"],
    ["a fragment", "https://plans.example/#x", "url_has_fragment"],
    ["a relative address", "/plans", "url_invalid"],
    ["not a string", 7, "url_invalid"],
  ])("refuses %s with 422 and %s stays unchanged", async (_name, url, code) => {
    const h = await start();
    await h.call("PUT", SETTING, { body: { url: "https://plans.example/" } });

    const response = await h.call("PUT", SETTING, { body: { url } });

    expect(response.status).toBe(422);
    expect(await json(response)).toEqual({ version: 1, error: code });
    expect(await json(await h.call("GET", SETTING))).toMatchObject({
      planManagementUrl: "https://plans.example/",
    });
  });

  // #284-T09
  it("needs the operator token and a body of the right shape", async () => {
    const h = await start();

    expect((await h.call("GET", SETTING, { token: null })).status).toBe(401);
    expect(
      (
        await h.call("PUT", SETTING, {
          token: null,
          body: { url: "https://x.example/" },
        })
      ).status,
    ).toBe(401);
    for (const rawBody of [
      "[]",
      "{}",
      '{"url":"https://x.example/","other":1}',
    ])
      expect((await h.call("PUT", SETTING, { rawBody })).status).toBe(400);
    expect((await h.call("POST", SETTING, { body: {} })).status).toBe(405);
  });

  it("logs the action and the result code, never the address", async () => {
    const h = await start();

    await h.call("PUT", SETTING, {
      body: { url: "https://plans.example/secret-path" },
    });
    await h.call("PUT", SETTING, { body: { url: "http://plans.example/x" } });
    await h.call("DELETE", SETTING);

    expect(h.lines).toEqual([
      "[operator-api] put plan-management result=ok",
      "[operator-api] put plan-management result=url_not_https",
      "[operator-api] delete plan-management result=ok",
    ]);
  });
});
