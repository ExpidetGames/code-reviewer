// SPDX-License-Identifier: LicenseRef-Proprietary

// The operator API against a real database: the credential, the stored and effective entitlements of a workspace,
// the default, removal, the refusals and what the answers and logs may contain. The format is checked against the
// contract file in compatibility/operator-api-contract.integration.test.ts; the route files in
// operator-api-route-files.integration.test.ts.
import { describe, expect, it } from "vitest";
import { createSecretStore } from "../../src/secrets/store.ts";
import { DEFAULT_LLM_PROVIDER } from "../../src/llm/providers/index.ts";
import { createFakeAdapter } from "../../src/llm/providers/fake-adapter.ts";
import { openrouterDescriptor } from "../../src/llm/providers/openrouter/descriptor.ts";
import { createProviderRegistry } from "../../src/llm/providers/registry.ts";
import type { SecretName } from "../../src/secrets/names.ts";
import {
  NotFoundMarker,
  startOperatorApiHarness,
  TEST_OPERATOR_TOKEN,
} from "../../src/test-support/operator-api-harness.ts";
import { markWorkspaceDeleted } from "../../src/test-support/workspaces.ts";

const ENTITLEMENTS = {
  planLabel: "team",
  keyMode: "managed",
  limits: {
    diffRunsPerPeriod: 100,
    dynamicRunsPerPeriod: null,
    managedCostLimitMicroUsd: 5_000_000,
    ownKeyCostLimitMicroUsd: null,
  },
  periodStart: "2026-10-01T00:00:00.000Z",
  suspended: false,
  suspensionCode: null,
};

const PATHS = (id: string) =>
  [
    ["GET", "/api/operator/v1/workspaces"],
    ["GET", `/api/operator/v1/workspaces/${id}/entitlements`],
    ["PUT", `/api/operator/v1/workspaces/${id}/entitlements`],
    ["DELETE", `/api/operator/v1/workspaces/${id}/entitlements`],
    ["GET", "/api/operator/v1/entitlements/default"],
    ["PUT", "/api/operator/v1/entitlements/default"],
    ["GET", "/api/operator/v1/nothing"],
  ] as const;

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("the operator API while it is off", () => {
  // #275-T01
  it.each([undefined])(
    "answers every route and method like a path that does not exist, before touching anything",
    async (token) => {
      const h = await startOperatorApiHarness({ token });

      for (const method of ["GET", "PUT", "DELETE", "POST", "HEAD"])
        for (const [, path] of PATHS(h.workspaceId))
          await expect(
            h.call(method, path, {
              body: method === "PUT" ? ENTITLEMENTS : undefined,
            }),
          ).rejects.toBeInstanceOf(NotFoundMarker);
      // Not even a request with the right credential or a bad body is told anything.
      await expect(
        h.call("GET", "/api/operator/v1/workspaces", { token: "x" }),
      ).rejects.toBeInstanceOf(NotFoundMarker);
      expect(h.lines).toEqual([]);
    },
  );
});

describe("the credential", () => {
  // #275-T03
  it("answers a missing, wrong, non-bearer or empty credential with one body", async () => {
    const h = await startOperatorApiHarness();
    const bodies: string[] = [];

    for (const options of [
      { token: null },
      { token: "wrong-token-value-0123456789-0123456789" },
      { token: "" },
      { authorization: `Basic ${TEST_OPERATOR_TOKEN}` },
      { authorization: "Bearer" },
      { authorization: TEST_OPERATOR_TOKEN },
      { token: `${TEST_OPERATOR_TOKEN}x` },
      { token: TEST_OPERATOR_TOKEN.slice(0, -1) },
      { headers: { cookie: "better-auth.session_token=abc" }, token: null },
    ]) {
      const response = await h.call(
        "GET",
        "/api/operator/v1/workspaces",
        options,
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      bodies.push(await response.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] ?? "")).toEqual({
      version: 1,
      error: "unauthorized",
    });
  });

  // #275-T03
  it("checks the credential before the method, the body and the workspace", async () => {
    const h = await startOperatorApiHarness();

    for (const [method, path] of [
      ["PUT", "/api/operator/v1/workspaces/does-not-exist/entitlements"],
      ["POST", "/api/operator/v1/workspaces"],
      ["GET", "/api/operator/v1/nothing"],
    ] as const)
      expect(
        (await h.call(method, path, { token: null, rawBody: "{" })).status,
      ).toBe(401);
  });

  // #275-T09
  it("never logs the token, the wrong token or a body", async () => {
    const h = await startOperatorApiHarness();
    const wrong = "wrong-token-value-0123456789-0123456789";

    await h.call("GET", "/api/operator/v1/workspaces", { token: wrong });
    await h.call(
      "PUT",
      `/api/operator/v1/workspaces/${h.workspaceId}/entitlements`,
      { body: { ...ENTITLEMENTS, planLabel: "secret-label-value" } },
    );

    const log = [...h.lines, ...h.errors].join("\n");
    expect(log).not.toContain(TEST_OPERATOR_TOKEN);
    expect(log).not.toContain(wrong);
    expect(log).not.toContain("secret-label-value");
  });
});

describe("listing workspaces", () => {
  // #275-T09
  it("lists id, slug and creation time only, in pages", async () => {
    const h = await startOperatorApiHarness();
    for (const slug of ["alpha", "beta", "gamma"]) await h.addWorkspace(slug);

    const first = await h.call("GET", "/api/operator/v1/workspaces?limit=3");
    const firstBody = await json(first);
    const workspaces = firstBody.workspaces as Array<Record<string, unknown>>;
    const second = await json(
      await h.call(
        "GET",
        `/api/operator/v1/workspaces?limit=3&after=${String(workspaces[2]?.id)}`,
      ),
    );

    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(workspaces).toHaveLength(3);
    for (const workspace of workspaces)
      expect(Object.keys(workspace).sort()).toEqual([
        "createdAt",
        "id",
        "slug",
      ]);
    expect(firstBody.nextAfter).toBe(workspaces[2]?.id);
    expect(second.workspaces).toHaveLength(1);
    expect(second.nextAfter).toBeNull();
  });

  // #658-T03
  it("does not list a deleted workspace, and the cursor walks past it", async () => {
    const h = await startOperatorApiHarness();
    const gone = await h.addWorkspace("gone");
    const kept = await h.addWorkspace("kept");
    await markWorkspaceDeleted(h.db, gone);

    const answer = await json(
      await h.call("GET", "/api/operator/v1/workspaces?limit=10"),
    );

    const ids = (answer.workspaces as Array<{ id: string }>).map(
      (workspace) => workspace.id,
    );
    expect(ids).toContain(kept);
    expect(ids).toContain(h.workspaceId);
    expect(ids).not.toContain(gone);
    expect(JSON.stringify(answer)).not.toContain(`deleted-${gone}`);
  });

  // #275-T12
  it("refuses a limit or cursor that is not valid", async () => {
    const h = await startOperatorApiHarness();

    for (const query of [
      "limit=0",
      "limit=201",
      "limit=abc",
      "limit=1.5",
      "after=a%20b",
      `after=${"a".repeat(65)}`,
      "after=",
    ]) {
      const response = await h.call(
        "GET",
        `/api/operator/v1/workspaces?${query}`,
      );
      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        version: 1,
        error: "request_invalid",
      });
    }
  });
});

describe("the entitlements of a workspace", () => {
  const path = (id: string) => `/api/operator/v1/workspaces/${id}/entitlements`;

  // #275-T05
  it("stores a row and reads back the same stored and effective values", async () => {
    const h = await startOperatorApiHarness();

    const put = await h.call("PUT", path(h.workspaceId), {
      body: ENTITLEMENTS,
    });
    const get = await h.call("GET", path(h.workspaceId));

    expect(put.status).toBe(200);
    expect(put.headers.get("cache-control")).toBe("no-store");
    const body = await json(get);
    expect(body).toMatchObject({
      version: 1,
      workspaceId: h.workspaceId,
      stored: { ...ENTITLEMENTS, updatedAt: "2026-10-14T12:00:00.000Z" },
      effective: { kind: "limited", source: "workspace", ...ENTITLEMENTS },
    });
    expect(await json(put)).toEqual(body);
    // Who saved it is not part of the answer.
    expect(JSON.stringify(body)).not.toContain("updatedBy");
  });

  // #361-T12
  it("stores the own-key cost limit with either key mode and reads it back, 0 and null included", async () => {
    const h = await startOperatorApiHarness();
    for (const [keyMode, managed, own] of [
      ["own", null, 2_000_000],
      ["own", null, 0],
      ["managed", 5_000_000, 2_000_000],
      ["managed", 5_000_000, null],
    ] as const) {
      const body = {
        ...ENTITLEMENTS,
        keyMode,
        limits: {
          ...ENTITLEMENTS.limits,
          managedCostLimitMicroUsd: managed,
          ownKeyCostLimitMicroUsd: own,
        },
      };

      const put = await h.call("PUT", path(h.workspaceId), { body });
      const read = await json(await h.call("GET", path(h.workspaceId)));

      expect(put.status).toBe(200);
      expect(read).toMatchObject({
        stored: { limits: { ownKeyCostLimitMicroUsd: own } },
        effective: { limits: { ownKeyCostLimitMicroUsd: own } },
      });
    }
  });

  // #361-T01
  it("reads a row stored before the own-key limit existed as unlimited on that limit", async () => {
    const h = await startOperatorApiHarness();
    await h.call("PUT", path(h.workspaceId), { body: ENTITLEMENTS });
    await h.db
      .updateTable("workspace_entitlements")
      .set({
        limits: JSON.stringify({
          diffRunsPerPeriod: 100,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: 5_000_000,
        }),
      })
      .execute();

    const read = await json(await h.call("GET", path(h.workspaceId)));

    expect(read).toMatchObject({
      stored: {
        limits: {
          managedCostLimitMicroUsd: 5_000_000,
          ownKeyCostLimitMicroUsd: null,
        },
      },
      effective: { kind: "limited" },
    });
  });

  // #275-T05
  it("records the operator API as the actor and changes nothing when the same body comes twice", async () => {
    const h = await startOperatorApiHarness();
    await h.call("PUT", path(h.workspaceId), { body: ENTITLEMENTS });
    const row = () =>
      h.db
        .selectFrom("workspace_entitlements")
        .select(["updated_by", "plan_label", "limits", "period_start"])
        .execute();
    const before = await row();

    const again = await h.call("PUT", path(h.workspaceId), {
      body: ENTITLEMENTS,
    });

    expect(again.status).toBe(200);
    expect(await row()).toEqual(before);
    expect(before[0]?.updated_by).toBeNull();
  });

  // #275-T06
  it("reads a workspace without a row as the default, or as unlimited without one", async () => {
    const h = await startOperatorApiHarness();
    const none = await json(await h.call("GET", path(h.workspaceId)));
    await h.call("PUT", "/api/operator/v1/entitlements/default", {
      body: ENTITLEMENTS,
    });
    const withDefault = await json(await h.call("GET", path(h.workspaceId)));

    expect(none).toMatchObject({
      stored: null,
      effective: { kind: "unlimited" },
    });
    expect(withDefault).toMatchObject({
      stored: null,
      effective: { kind: "limited", source: "default", planLabel: "team" },
    });
  });

  // #275-T06
  it.each([
    [{ ...ENTITLEMENTS, planLabel: "" }, "plan_label_invalid"],
    [{ ...ENTITLEMENTS, keyMode: "shared" }, "key_mode_invalid"],
    // #277: the cost limit only counts runs on the operator's key
    [{ ...ENTITLEMENTS, keyMode: "own" }, "cost_limit_requires_managed_key"],
    [{ ...ENTITLEMENTS, limits: { diffRunsPerPeriod: 1 } }, "limits_invalid"],
    // #361: a write states the own-key cost limit too, and it is a count or null
    [
      {
        ...ENTITLEMENTS,
        limits: {
          diffRunsPerPeriod: 1,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
        },
      },
      "limits_invalid",
    ],
    [
      {
        ...ENTITLEMENTS,
        limits: { ...ENTITLEMENTS.limits, ownKeyCostLimitMicroUsd: -1 },
      },
      "limit_invalid",
    ],
    [
      {
        ...ENTITLEMENTS,
        limits: { ...ENTITLEMENTS.limits, diffRunsPerPeriod: -1 },
      },
      "limit_invalid",
    ],
    [
      {
        ...ENTITLEMENTS,
        limits: { ...ENTITLEMENTS.limits, diffRunsPerPeriod: 1.5 },
      },
      "limit_invalid",
    ],
    [{ ...ENTITLEMENTS, periodStart: "yesterday" }, "period_start_invalid"],
    [
      { ...ENTITLEMENTS, periodStart: "2027-01-01T00:00:00.000Z" },
      "period_start_in_future",
    ],
    [{ ...ENTITLEMENTS, suspended: "no" }, "suspended_invalid"],
    [
      { ...ENTITLEMENTS, suspended: true, suspensionCode: "Not A Code" },
      "suspension_code_invalid",
    ],
    [{ ...ENTITLEMENTS, extra: true }, "entitlements_invalid"],
    [[1, 2], "entitlements_invalid"],
    [null, "entitlements_invalid"],
  ])(
    "refuses invalid entitlements with 422 and the code of the validation",
    async (body, code) => {
      const h = await startOperatorApiHarness();

      const response = await h.call("PUT", path(h.workspaceId), { body });

      expect(response.status).toBe(422);
      expect(await json(response)).toMatchObject({ version: 1, error: code });
      expect(
        await h.db.selectFrom("workspace_entitlements").selectAll().execute(),
      ).toEqual([]);
    },
  );

  // #275-T06
  it("refuses a limit above 2^53 instead of storing a rounded number", async () => {
    const h = await startOperatorApiHarness();

    for (const digits of [
      "9007199254740992",
      "9007199254740993",
      "18446744073709551616",
      "1e400",
    ]) {
      const response = await h.call("PUT", path(h.workspaceId), {
        rawBody: JSON.stringify(ENTITLEMENTS).replace(
          '"diffRunsPerPeriod":100',
          `"diffRunsPerPeriod":${digits}`,
        ),
      });
      expect(response.status).toBe(422);
      expect(await json(response)).toMatchObject({
        error: "limit_invalid",
        field: "diffRunsPerPeriod",
      });
    }
  });

  // #275-T06
  it("refuses a period start that goes backwards with 409 and keeps the row", async () => {
    const h = await startOperatorApiHarness();
    await h.call("PUT", path(h.workspaceId), { body: ENTITLEMENTS });

    const response = await h.call("PUT", path(h.workspaceId), {
      body: { ...ENTITLEMENTS, periodStart: "2026-09-01T00:00:00.000Z" },
    });

    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({
      version: 1,
      error: "period_start_backwards",
    });
    expect(await json(await h.call("GET", path(h.workspaceId)))).toMatchObject({
      stored: { periodStart: "2026-10-01T00:00:00.000Z" },
    });
  });

  // #275-T06 (follow-up of #271: a stale start must not block an unrelated update)
  it("keeps the stored period start when the body leaves it out, so a partial update is not refused", async () => {
    const h = await startOperatorApiHarness();
    await h.call("PUT", path(h.workspaceId), { body: ENTITLEMENTS });
    h.setNow(new Date("2026-10-20T00:00:00.000Z"));
    const { periodStart: _omitted, ...withoutStart } = ENTITLEMENTS;
    void _omitted;

    const response = await h.call("PUT", path(h.workspaceId), {
      body: { ...withoutStart, suspended: true, suspensionCode: "unpaid" },
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      stored: {
        periodStart: "2026-10-01T00:00:00.000Z",
        suspended: true,
        suspensionCode: "unpaid",
      },
    });
  });

  // #275-T06
  it("starts the period now when there is no row and the body leaves the start out", async () => {
    const h = await startOperatorApiHarness();
    const { periodStart: _omitted, ...withoutStart } = ENTITLEMENTS;
    void _omitted;

    const response = await h.call("PUT", path(h.workspaceId), {
      body: withoutStart,
    });

    expect(await json(response)).toMatchObject({
      stored: { periodStart: "2026-10-14T12:00:00.000Z" },
    });
  });

  // #275-T07
  it("removes the row so that the default applies, and removing again is harmless", async () => {
    const h = await startOperatorApiHarness();
    await h.call("PUT", "/api/operator/v1/entitlements/default", {
      body: { ...ENTITLEMENTS, planLabel: "base" },
    });
    await h.call("PUT", path(h.workspaceId), { body: ENTITLEMENTS });

    const removed = await h.call("DELETE", path(h.workspaceId));
    const removedAgain = await h.call("DELETE", path(h.workspaceId));
    const get = await json(await h.call("GET", path(h.workspaceId)));

    expect(removed.status).toBe(200);
    expect(removedAgain.status).toBe(200);
    expect(get).toMatchObject({
      stored: null,
      effective: { kind: "limited", source: "default", planLabel: "base" },
    });
  });

  // #275-T07
  it("lets a removed workspace start over: a put without a start begins now", async () => {
    const h = await startOperatorApiHarness();
    await h.call("PUT", path(h.workspaceId), { body: ENTITLEMENTS });
    await h.call("DELETE", path(h.workspaceId));
    h.setNow(new Date("2026-10-20T00:00:00.000Z"));
    const { periodStart: _omitted, ...withoutStart } = ENTITLEMENTS;
    void _omitted;

    const response = await h.call("PUT", path(h.workspaceId), {
      body: withoutStart,
    });

    expect(await json(response)).toMatchObject({
      stored: { periodStart: "2026-10-20T00:00:00.000Z" },
    });
  });

  // #275-T11
  it("answers an unknown workspace with 404 and a code, not a stack", async () => {
    const h = await startOperatorApiHarness();

    for (const method of ["GET", "PUT", "DELETE"]) {
      for (const id of ["no-such-workspace", "a b", "x".repeat(200)]) {
        const response = await h.call(
          method,
          `/api/operator/v1/workspaces/${encodeURIComponent(id)}/entitlements`,
          { body: method === "PUT" ? ENTITLEMENTS : undefined },
        );
        expect(response.status).toBe(404);
        expect(await json(response)).toEqual({
          version: 1,
          error: "workspace_not_found",
        });
      }
    }
  });

  // #658-T03
  it("answers a deleted workspace like an unknown one on every method, and writes nothing", async () => {
    const h = await startOperatorApiHarness();
    const gone = await h.addWorkspace("gone");
    await h.call("PUT", path(gone), { body: ENTITLEMENTS });
    await markWorkspaceDeleted(h.db, gone);

    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await h.call(method, path(gone), {
        body: method === "PUT" ? ENTITLEMENTS : undefined,
      });
      expect(response.status, method).toBe(404);
      expect(await json(response)).toEqual({
        version: 1,
        error: "workspace_not_found",
      });
    }
    expect(
      await h.db
        .selectFrom("workspace_entitlements")
        .select("plan_label")
        .where("workspace_id", "=", gone)
        .execute(),
    ).toHaveLength(1);
  });

  // #275-T11
  it("does not touch another workspace", async () => {
    const h = await startOperatorApiHarness();
    const other = await h.addWorkspace("other");
    await h.call("PUT", path(other), { body: ENTITLEMENTS });

    await h.call("DELETE", path(h.workspaceId));

    expect(await json(await h.call("GET", path(other)))).toMatchObject({
      stored: { planLabel: "team" },
    });
  });

  // #275-T10
  it("reports a stored row that cannot be read as invalid, and a valid put repairs it", async () => {
    const h = await startOperatorApiHarness();
    await h.call("PUT", path(h.workspaceId), { body: ENTITLEMENTS });
    await h.db
      .updateTable("workspace_entitlements")
      .set({ limits: "not json" })
      .execute();

    const damaged = await json(await h.call("GET", path(h.workspaceId)));
    const repaired = await h.call("PUT", path(h.workspaceId), {
      body: ENTITLEMENTS,
    });

    expect(damaged).toMatchObject({
      stored: { invalid: true },
      effective: { kind: "invalid", code: "entitlements_invalid" },
    });
    expect(repaired.status).toBe(200);
    expect(await json(repaired)).toMatchObject({ stored: ENTITLEMENTS });
  });
});

describe("the default entitlements", () => {
  const path = "/api/operator/v1/entitlements/default";

  // #275-T08
  it("reads null before one is set, stores one and reads it back", async () => {
    const h = await startOperatorApiHarness();

    const before = await json(await h.call("GET", path));
    const put = await h.call("PUT", path, { body: ENTITLEMENTS });
    const after = await json(await h.call("GET", path));

    expect(before).toEqual({ version: 1, default: null });
    expect(put.status).toBe(200);
    // #428: the answer always carries the model access, every released entry when none was stated.
    expect(after).toEqual({
      version: 1,
      default: { ...ENTITLEMENTS, modelAccess: { catalogEntries: null } },
    });
    expect(await json(put)).toEqual(after);
  });

  // #275-T06
  it("refuses invalid entitlements and a start that goes backwards", async () => {
    const h = await startOperatorApiHarness();
    await h.call("PUT", path, { body: ENTITLEMENTS });

    const invalid = await h.call("PUT", path, {
      body: { ...ENTITLEMENTS, keyMode: "x" },
    });
    const backwards = await h.call("PUT", path, {
      body: { ...ENTITLEMENTS, periodStart: "2026-09-01T00:00:00.000Z" },
    });

    expect(invalid.status).toBe(422);
    expect(await json(invalid)).toMatchObject({ error: "key_mode_invalid" });
    expect(backwards.status).toBe(409);
    expect(await json(backwards)).toMatchObject({
      error: "period_start_backwards",
    });
  });

  // #275-T06
  it("keeps the stored start when the body leaves it out", async () => {
    const h = await startOperatorApiHarness();
    await h.call("PUT", path, { body: ENTITLEMENTS });
    h.setNow(new Date("2026-10-20T00:00:00.000Z"));
    const { periodStart: _omitted, ...withoutStart } = ENTITLEMENTS;
    void _omitted;

    const response = await h.call("PUT", path, {
      body: { ...withoutStart, planLabel: "renamed" },
    });

    expect(await json(response)).toMatchObject({
      default: {
        planLabel: "renamed",
        periodStart: "2026-10-01T00:00:00.000Z",
      },
    });
  });

  // #275-T08
  it("has no delete: removing the default would end the guard of its period start", async () => {
    const h = await startOperatorApiHarness();
    await h.call("PUT", path, { body: ENTITLEMENTS });

    const response = await h.call("DELETE", path);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, PUT");
    expect((await json(await h.call("GET", path))).default).not.toBeNull();
  });
});

describe("what the API refuses before it works", () => {
  const path = (id: string) => `/api/operator/v1/workspaces/${id}/entitlements`;

  // #275-T12
  it("refuses a method a route does not offer with 405 and the allowed methods", async () => {
    const h = await startOperatorApiHarness();

    const post = await h.call("POST", "/api/operator/v1/workspaces");
    const put = await h.call("PUT", "/api/operator/v1/workspaces");

    for (const response of [post, put]) {
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
      expect(await json(response)).toEqual({
        version: 1,
        error: "method_not_allowed",
      });
    }
  });

  // #275-T12
  it("answers an unknown path with a JSON 404 once the credential is right", async () => {
    const h = await startOperatorApiHarness();

    const response = await h.call("GET", "/api/operator/v1/nothing");

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ version: 1, error: "not_found" });
  });

  // #275-T12
  it("leaves out the field of a refusal when the name is longer than the contract allows", async () => {
    const h = await startOperatorApiHarness();

    const response = await h.call("PUT", path(h.workspaceId), {
      body: { ...ENTITLEMENTS, ["k".repeat(5000)]: 1 },
    });

    expect(response.status).toBe(422);
    expect(await json(response)).toEqual({
      version: 1,
      error: "entitlements_invalid",
    });
  });

  // #275-T11
  it("looks the workspace up before it reads the body of a PUT", async () => {
    const h = await startOperatorApiHarness();

    const response = await h.call("PUT", path("no-such-workspace"), {
      rawBody: "x",
      contentType: "text/plain",
    });

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      version: 1,
      error: "workspace_not_found",
    });
  });

  // #275-T12
  it("refuses a body over the limit with 413, declared or not", async () => {
    const h = await startOperatorApiHarness();
    const huge = JSON.stringify({
      ...ENTITLEMENTS,
      planLabel: "x".repeat(20_000),
    });

    const response = await h.call("PUT", path(h.workspaceId), {
      rawBody: huge,
    });

    expect(response.status).toBe(413);
    expect(await json(response)).toEqual({
      version: 1,
      error: "body_too_large",
    });
  });

  // #275-T12
  it("refuses a content type other than application/json with 415, and accepts a charset", async () => {
    const h = await startOperatorApiHarness();
    const raw = JSON.stringify(ENTITLEMENTS);

    for (const contentType of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "application/jsonx",
      null,
    ]) {
      const response = await h.call("PUT", path(h.workspaceId), {
        rawBody: raw,
        contentType,
      });
      expect(response.status).toBe(415);
      expect(await json(response)).toEqual({
        version: 1,
        error: "unsupported_media_type",
      });
    }
    const ok = await h.call("PUT", path(h.workspaceId), {
      rawBody: raw,
      contentType: "Application/JSON; charset=utf-8",
    });
    expect(ok.status).toBe(200);
  });

  // #275-T12
  it("refuses a body that is not JSON, or empty, with 400", async () => {
    const h = await startOperatorApiHarness();

    for (const rawBody of ["{", "", "not json", '{"a":1}{"b":2}']) {
      const response = await h.call("PUT", path(h.workspaceId), { rawBody });
      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        version: 1,
        error: "request_invalid",
      });
    }
  });

  // #275-T12
  it("refuses a GET or DELETE that carries a body", async () => {
    const h = await startOperatorApiHarness();

    for (const [method, target] of [
      ["GET", "/api/operator/v1/workspaces"],
      ["GET", path(h.workspaceId)],
      ["DELETE", path(h.workspaceId)],
      ["GET", "/api/operator/v1/entitlements/default"],
    ] as const) {
      const response = await h.call(method, target, { rawBody: "{}" });
      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        version: 1,
        error: "body_not_allowed",
      });
    }
  });
});

describe("what the writes log", () => {
  const path = (id: string) => `/api/operator/v1/workspaces/${id}/entitlements`;

  // #275-T09
  it("logs the workspace id, the names of the changed fields and the result, never a value", async () => {
    const h = await startOperatorApiHarness();
    await h.call("PUT", path(h.workspaceId), {
      body: { ...ENTITLEMENTS, planLabel: "label-that-is-a-value" },
    });
    await h.call("PUT", path(h.workspaceId), {
      body: {
        ...ENTITLEMENTS,
        planLabel: "label-that-is-a-value",
        suspended: true,
        suspensionCode: "unpaid",
      },
    });
    await h.call("PUT", path(h.workspaceId), {
      body: { ...ENTITLEMENTS, keyMode: "bogus" },
    });
    await h.call("DELETE", path(h.workspaceId));
    await h.call("PUT", "/api/operator/v1/entitlements/default", {
      body: ENTITLEMENTS,
    });

    expect(h.lines).toEqual([
      `[operator-api] put workspace=${h.workspaceId} fields=planLabel,keyMode,periodStart,suspended,suspensionCode,limits.diffRunsPerPeriod,limits.dynamicRunsPerPeriod,limits.managedCostLimitMicroUsd,limits.ownKeyCostLimitMicroUsd result=ok`,
      `[operator-api] put workspace=${h.workspaceId} fields=suspended,suspensionCode result=ok`,
      `[operator-api] put workspace=${h.workspaceId} fields=- result=key_mode_invalid`,
      `[operator-api] delete workspace=${h.workspaceId} fields=- result=ok`,
      `[operator-api] put workspace=default fields=planLabel,keyMode,periodStart,suspended,suspensionCode,limits.diffRunsPerPeriod,limits.dynamicRunsPerPeriod,limits.managedCostLimitMicroUsd,limits.ownKeyCostLimitMicroUsd result=ok`,
    ]);
    expect(h.lines.join("\n")).not.toContain("label-that-is-a-value");
    expect(h.lines.join("\n")).not.toContain("unpaid");
  });

  // #275-T09
  it("contains no email, repository name or key in any answer", async () => {
    const h = await startOperatorApiHarness();
    await h.db
      .updateTable("workspaces")
      .set({ name: "Acme Corp (ceo@acme.example)" })
      .execute();
    await h.call("PUT", path(h.workspaceId), { body: ENTITLEMENTS });

    const text = [
      await (await h.call("GET", "/api/operator/v1/workspaces")).text(),
      await (await h.call("GET", path(h.workspaceId))).text(),
      await (
        await h.call("GET", "/api/operator/v1/entitlements/default")
      ).text(),
    ].join("\n");

    expect(text).not.toContain("@");
    expect(text).not.toContain("Acme");
    expect(text).not.toContain(TEST_OPERATOR_TOKEN);
  });
});

describe("the operator's own LLM key", () => {
  const KEY = "sk-or-v1-operator-key-0123456789abcdef-wxyz";
  const path = (id: string) => `/api/operator/v1/workspaces/${id}/entitlements`;

  // #276-T07
  it("has no call at all: whoever holds the API token can neither read nor write it", async () => {
    const h = await startOperatorApiHarness();
    await createSecretStore({
      db: h.db,
      appSecret: "operator-api-test-app-secret-0123456789-01",
    }).save("operator_llm_key", KEY, { updatedBy: null, showLastFour: true });
    const answers: string[] = [];

    for (const path of [
      "/api/operator/v1/llm-key",
      "/api/operator/v1/operator-llm-key",
      "/api/operator/v1/secrets",
      "/api/operator/v1/settings",
      `/api/operator/v1/workspaces/${h.workspaceId}/llm-key`,
    ])
      for (const method of ["GET", "PUT", "POST", "DELETE"]) {
        const response = await h.call(method, path, {
          body:
            method === "PUT" || method === "POST" ? { apiKey: KEY } : undefined,
        });
        expect(response.status).toBe(404);
        answers.push(await response.text());
      }

    // Nothing the API reads or answers holds the key or says that there is one.
    await h.call("PUT", path(h.workspaceId), { body: ENTITLEMENTS });
    for (const read of [
      "/api/operator/v1/workspaces",
      path(h.workspaceId),
      "/api/operator/v1/entitlements/default",
      "/api/operator/v1/usage",
      `/api/operator/v1/workspaces/${h.workspaceId}/usage`,
    ])
      answers.push(await (await h.call("GET", read)).text());
    expect(answers.join("\n")).not.toContain(KEY);
    expect(answers.join("\n")).not.toContain("wxyz");
    expect(answers.join("\n")).not.toContain("operator_llm_key");
    expect(h.lines.join("\n")).not.toContain(KEY);
  });

  // #427-T03
  it("has no call for the key of any provider either, and no answer holds the key of either provider: whoever holds the API token can neither read nor write one", async () => {
    const h = await startOperatorApiHarness();
    const secrets = createSecretStore({
      db: h.db,
      appSecret: "operator-api-test-app-secret-0123456789-01",
    });
    // Two providers, each with a key of its own under the name its adapter gives it. The second one exists only in
    // this test registry, so a leak that is written for "the" provider (the first one) is not enough to pass.
    const registry = createProviderRegistry([
      openrouterDescriptor,
      createFakeAdapter(),
    ]);
    const sentinels = registry.providers.map((provider) => ({
      id: provider.id,
      name: provider.secretNames.operator,
      key: `${KEY}-${provider.id}`,
    }));
    for (const { name, key } of sentinels)
      await secrets.save(name as SecretName, key, {
        updatedBy: null,
        showLastFour: true,
      });
    const answers: string[] = [];

    // A tripwire only: the router answers 404 for every path it does not know, so this fails if someone adds a call
    // for a key. The proof that no key leaves the API is the reading below and `no-operator-keys.test.ts`.
    for (const path of [
      "/api/operator/v1/llm-keys",
      ...registry.ids.flatMap((id) => [
        `/api/operator/v1/llm-keys/${id}`,
        `/api/operator/v1/llm-keys/${id}/test`,
      ]),
    ])
      for (const method of ["GET", "PUT", "POST", "DELETE"]) {
        const response = await h.call(method, path, {
          body:
            method === "PUT" || method === "POST" ? { apiKey: KEY } : undefined,
        });
        expect(response.status, `${method} ${path}`).toBe(404);
        answers.push(await response.text());
      }

    // The proof: every answer the API gives with both keys stored holds neither key.
    for (const read of [
      "/api/operator/v1/workspaces",
      path(h.workspaceId),
      "/api/operator/v1/entitlements/default",
      "/api/operator/v1/usage",
    ])
      answers.push(await (await h.call("GET", read)).text());
    expect(answers.length).toBeGreaterThan(5);
    for (const { key, name } of sentinels) {
      expect(answers.join("\n")).not.toContain(key);
      expect(answers.join("\n")).not.toContain(name);
    }
    expect(h.lines.join("\n")).not.toContain(KEY);
  });

  // #427-T03
  it("cannot set the key of a provider through the entitlements either: nothing is stored", async () => {
    const h = await startOperatorApiHarness();

    for (const extra of [
      { operatorLlmKeys: { [DEFAULT_LLM_PROVIDER]: { apiKey: KEY } } },
      { llmKeys: { [DEFAULT_LLM_PROVIDER]: KEY } },
    ]) {
      const response = await h.call("PUT", path(h.workspaceId), {
        body: { ...ENTITLEMENTS, ...extra },
      });
      expect(response.status).toBe(422);
      expect(await response.text()).not.toContain(KEY);
    }
    expect(await h.db.selectFrom("secrets").select("name").execute()).toEqual(
      [],
    );
  });

  // #276-T07
  it("cannot be set through the entitlements either: a field that is no entitlement is refused", async () => {
    const h = await startOperatorApiHarness();

    for (const extra of [
      { operatorLlmKey: KEY },
      { apiKey: KEY },
      { llmKey: { apiKey: KEY } },
    ]) {
      const response = await h.call("PUT", path(h.workspaceId), {
        body: { ...ENTITLEMENTS, ...extra },
      });
      expect(response.status).toBe(422);
      expect(await response.text()).not.toContain(KEY);
    }
    expect(await h.db.selectFrom("secrets").select("name").execute()).toEqual(
      [],
    );
  });
});

describe("the model access (#428)", () => {
  const path = (id: string) => `/api/operator/v1/workspaces/${id}/entitlements`;
  const DEFAULT_PATH = "/api/operator/v1/entitlements/default";
  const ID_A = "mce_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const ID_B = "mce_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const { periodStart: _omitted, ...WITHOUT_START } = ENTITLEMENTS;
  void _omitted;

  async function stored(
    h: Awaited<ReturnType<typeof startOperatorApiHarness>>,
  ) {
    return json(await h.call("GET", path(h.workspaceId)));
  }

  // #428-T02
  it("answers a write with a model access and no credential like any other write, and stores nothing", async () => {
    const h = await startOperatorApiHarness();

    for (const target of [path(h.workspaceId), DEFAULT_PATH]) {
      const response = await h.call("PUT", target, {
        token: null,
        body: { ...ENTITLEMENTS, modelAccess: { catalogEntries: [ID_A] } },
      });

      expect(response.status).toBe(401);
      expect(await json(response)).toEqual({
        version: 1,
        error: "unauthorized",
      });
    }
    expect(
      await h.db.selectFrom("workspace_entitlements").selectAll().execute(),
    ).toEqual([]);
    expect(
      await h.db.selectFrom("instance_settings").selectAll().execute(),
    ).toEqual([]);
  });

  // #428-T02
  it("is not there at all while the API is off", async () => {
    const h = await startOperatorApiHarness({ token: undefined });

    await expect(
      h.call("PUT", path(h.workspaceId), {
        body: { ...ENTITLEMENTS, modelAccess: { catalogEntries: [ID_A] } },
      }),
    ).rejects.toBeInstanceOf(NotFoundMarker);
  });

  // #428-T06
  it("stores a list, reads it back as stored and effective, and says every released entry when none was stated", async () => {
    const h = await startOperatorApiHarness();

    const put = await h.call("PUT", path(h.workspaceId), {
      body: { ...ENTITLEMENTS, modelAccess: { catalogEntries: [ID_A, ID_B] } },
    });

    expect(put.status).toBe(200);
    expect(await stored(h)).toMatchObject({
      stored: { modelAccess: { catalogEntries: [ID_A, ID_B] } },
      effective: { modelAccess: { catalogEntries: [ID_A, ID_B] } },
    });
    const plain = await startOperatorApiHarness();
    await plain.call("PUT", path(plain.workspaceId), { body: ENTITLEMENTS });
    expect(await stored(plain)).toMatchObject({
      stored: { modelAccess: { catalogEntries: null } },
      effective: { modelAccess: { catalogEntries: null } },
    });
  });

  // #428-T06
  it("keeps the stored list when a write leaves the field out, like the period start", async () => {
    const h = await startOperatorApiHarness();
    await h.call("PUT", path(h.workspaceId), {
      body: { ...ENTITLEMENTS, modelAccess: { catalogEntries: [ID_A] } },
    });

    const response = await h.call("PUT", path(h.workspaceId), {
      body: { ...WITHOUT_START, suspended: true, suspensionCode: "unpaid" },
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      stored: {
        suspended: true,
        modelAccess: { catalogEntries: [ID_A] },
      },
    });
  });

  // #428-T06
  it("clears the list only when the write says null, and stores none for an empty list", async () => {
    const h = await startOperatorApiHarness();
    await h.call("PUT", path(h.workspaceId), {
      body: { ...ENTITLEMENTS, modelAccess: { catalogEntries: [ID_A] } },
    });

    await h.call("PUT", path(h.workspaceId), {
      body: { ...ENTITLEMENTS, modelAccess: { catalogEntries: [] } },
    });
    expect(await stored(h)).toMatchObject({
      stored: { modelAccess: { catalogEntries: [] } },
    });
    await h.call("PUT", path(h.workspaceId), {
      body: { ...ENTITLEMENTS, modelAccess: { catalogEntries: null } },
    });
    expect(await stored(h)).toMatchObject({
      stored: { modelAccess: { catalogEntries: null } },
    });
  });

  // #428-T06
  it("does the same for the default of the instance", async () => {
    const h = await startOperatorApiHarness();
    await h.call("PUT", DEFAULT_PATH, {
      body: { ...ENTITLEMENTS, modelAccess: { catalogEntries: [ID_B] } },
    });

    const kept = await h.call("PUT", DEFAULT_PATH, {
      body: { ...WITHOUT_START, planLabel: "renamed" },
    });
    expect(await json(kept)).toMatchObject({
      default: {
        planLabel: "renamed",
        modelAccess: { catalogEntries: [ID_B] },
      },
    });
    const cleared = await h.call("PUT", DEFAULT_PATH, {
      body: { ...WITHOUT_START, modelAccess: { catalogEntries: null } },
    });
    expect(await json(cleared)).toMatchObject({
      default: { modelAccess: { catalogEntries: null } },
    });
  });

  // #428-T03
  it.each([
    ["a string", "all", "modelAccess"],
    ["null", null, "modelAccess"],
    ["a list instead of the object", [ID_A], "modelAccess"],
    [
      "a key it does not know",
      { catalogEntries: null, extra: 1 },
      "modelAccess",
    ],
    ["no list", {}, "modelAccess.catalogEntries"],
    [
      "a list that is not an array",
      { catalogEntries: ID_A },
      "modelAccess.catalogEntries",
    ],
    [
      "a number as an id",
      { catalogEntries: [1] },
      "modelAccess.catalogEntries",
    ],
    [
      "an id of a bad shape",
      { catalogEntries: ["gpt-5"] },
      "modelAccess.catalogEntries",
    ],
    [
      "more than 100 ids",
      {
        catalogEntries: Array.from(
          { length: 101 },
          (_unused, index) => `mce_${String(index)}`,
        ),
      },
      "modelAccess.catalogEntries",
    ],
  ])(
    "refuses %s with 422 catalog_entry_invalid and stores nothing",
    async (_name, modelAccess, field) => {
      const h = await startOperatorApiHarness();

      for (const target of [path(h.workspaceId), DEFAULT_PATH]) {
        const response = await h.call("PUT", target, {
          body: { ...ENTITLEMENTS, modelAccess },
        });

        expect(response.status).toBe(422);
        expect(await json(response)).toEqual({
          version: 1,
          error: "catalog_entry_invalid",
          field,
        });
      }
      expect(
        await h.db.selectFrom("workspace_entitlements").selectAll().execute(),
      ).toEqual([]);
      expect(
        await h.db.selectFrom("instance_settings").selectAll().execute(),
      ).toEqual([]);
    },
  );

  // #428-T03
  it("accepts exactly 100 ids and ids that no entry has", async () => {
    const h = await startOperatorApiHarness();
    const ids = Array.from(
      { length: 100 },
      (_unused, index) => `mce_${String(index).padStart(32, "0")}`,
    );

    const response = await h.call("PUT", path(h.workspaceId), {
      body: { ...ENTITLEMENTS, modelAccess: { catalogEntries: ids } },
    });

    expect(response.status).toBe(200);
  });

  // #428-T10
  it("stores and returns a list next to the own key unchanged", async () => {
    const h = await startOperatorApiHarness();
    const own = {
      ...ENTITLEMENTS,
      keyMode: "own",
      limits: { ...ENTITLEMENTS.limits, managedCostLimitMicroUsd: null },
      modelAccess: { catalogEntries: [ID_A] },
    };

    const put = await h.call("PUT", path(h.workspaceId), { body: own });

    expect(put.status).toBe(200);
    expect(await stored(h)).toMatchObject({
      stored: { keyMode: "own", modelAccess: { catalogEntries: [ID_A] } },
      effective: {
        kind: "limited",
        keyMode: "own",
        modelAccess: { catalogEntries: [ID_A] },
      },
    });
    // Switching back to the operator's key finds the list again.
    await h.call("PUT", path(h.workspaceId), {
      body: { ...WITHOUT_START, keyMode: "managed" },
    });
    expect(await stored(h)).toMatchObject({
      stored: { keyMode: "managed", modelAccess: { catalogEntries: [ID_A] } },
    });
  });

  // #428-T05
  it("reads a row stored before the field existed as every released entry", async () => {
    const h = await startOperatorApiHarness();
    await h.call("PUT", path(h.workspaceId), { body: ENTITLEMENTS });
    await h.db
      .updateTable("workspace_entitlements")
      .set({ model_access: null })
      .execute();

    expect(await stored(h)).toMatchObject({
      stored: { modelAccess: { catalogEntries: null } },
      effective: { kind: "limited" },
    });
  });

  // #428-T06
  it("logs the name of the field when it changed and never an id", async () => {
    const h = await startOperatorApiHarness();
    await h.call("PUT", path(h.workspaceId), { body: ENTITLEMENTS });
    await h.call("PUT", path(h.workspaceId), {
      body: { ...ENTITLEMENTS, modelAccess: { catalogEntries: [ID_A] } },
    });
    await h.call("PUT", path(h.workspaceId), {
      body: { ...ENTITLEMENTS, modelAccess: { catalogEntries: [ID_A] } },
    });

    expect(h.lines.at(1)).toBe(
      `[operator-api] put workspace=${h.workspaceId} fields=modelAccess result=ok`,
    );
    expect(h.lines.at(2)).toBe(
      `[operator-api] put workspace=${h.workspaceId} fields=- result=ok`,
    );
    expect(h.lines.join("\n")).not.toContain(ID_A);
  });
});
