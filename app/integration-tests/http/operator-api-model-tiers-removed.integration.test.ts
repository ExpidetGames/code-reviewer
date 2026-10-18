// SPDX-License-Identifier: Apache-2.0

// #434-T09: the operator API no longer has `/model-tiers` (ADR 0005, decision C1: a documented breaking change of the
// operator API, `contracts/README.md`). A client that still calls it gets the answer of any path the API does not have;
// nothing it sends is stored, and no other route changed.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROUTE_METHODS } from "../../src/operator-api/contract.ts";
import { startOperatorApiHarness } from "../../src/test-support/operator-api-harness.ts";

const PATH = "/api/operator/v1/model-tiers";

describe("the removed /model-tiers route", () => {
  // #434-T09
  it.each(["GET", "PUT", "POST", "DELETE"])(
    "answers the missing path to %s, with the token, and stores nothing",
    async (method) => {
      const h = await startOperatorApiHarness();

      const response = await h.call(method, PATH, {
        body:
          method === "GET" || method === "DELETE"
            ? undefined
            : { tiers: { high: { diff: "vendor/high-diff" } } },
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        version: 1,
        error: "not_found",
      });
      expect(
        await h.db
          .selectFrom("instance_settings")
          .select("key")
          .where("key", "=", ["managed", "model", "tiers"].join("_"))
          .execute(),
      ).toEqual([]);
    },
  );

  // #434-T09
  it("has no route file any more", () => {
    expect(
      existsSync(
        fileURLToPath(
          new URL(
            "../../src/app/api/operator/v1/model-tiers/route.ts",
            import.meta.url,
          ),
        ),
      ),
    ).toBe(false);
  });

  // #434-T09
  it("leaves every other route as it was", () => {
    expect(ROUTE_METHODS).toEqual({
      workspaces: ["GET"],
      "workspace-entitlements": ["GET", "PUT", "DELETE"],
      "default-entitlements": ["GET", "PUT"],
      usage: ["GET"],
      "usage-unknown-cost": ["GET"],
      "workspace-usage": ["GET"],
      "workspace-usage-summary": ["GET"],
      "plan-management": ["GET", "PUT", "DELETE"],
      "handoff-redeem": ["POST"],
      unknown: [],
    });
  });
});
