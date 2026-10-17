// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { pairToMeta, type SnapshotPair } from "./pair.ts";
import { livePair, pairOfDeployment, type VercelAuth } from "./vercel-api.ts";

const AUTH: VercelAuth = {
  token: "vercel-token-not-a-real-one-0123456789",
  teamId: "team_example01",
  projectId: "prj_example01",
};
const PAIR: SnapshotPair = {
  snapshotId: "snap_example01",
  imageDigest: `sha256:${"a".repeat(64)}`,
  commit: "1".repeat(40),
};

type Seen = { url: URL; headers: Headers; redirect: string };

function platform(routes: Record<string, () => Response | Promise<Response>>): {
  fetch: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      seen.push({ url, headers: request.headers, redirect: request.redirect });
      const route = routes[url.pathname];
      if (!route) return new Response("{}", { status: 404 });
      return route();
    },
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

const projectWith = (id: string | undefined) => () =>
  json({
    id: AUTH.projectId,
    targets: id === undefined ? {} : { production: { id } },
  });
const deploymentWith =
  (overrides: Record<string, unknown> = {}) =>
  () =>
    json({
      id: "dpl_live01",
      projectId: AUTH.projectId,
      ownerId: AUTH.teamId,
      meta: pairToMeta(PAIR),
      ...overrides,
    });

describe("the pair of the live production deployment", () => {
  // #403-T13
  it("is read from the meta of the deployment the project serves on its production domains", async () => {
    const { fetch, seen } = platform({
      [`/v9/projects/${AUTH.projectId}`]: projectWith("dpl_live01"),
      "/v13/deployments/dpl_live01": deploymentWith(),
    });

    expect(await livePair(AUTH, fetch)).toEqual({ status: "pair", pair: PAIR });

    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expect(request.url.hostname).toBe("api.vercel.com");
      expect(request.url.searchParams.get("teamId")).toBe(AUTH.teamId);
      expect(request.headers.get("authorization")).toBe(`Bearer ${AUTH.token}`);
      expect(request.redirect).toBe("manual");
    }
  });

  // #403-T13
  it("is none for a deployment made by hand, which carries no pair, and for a project that serves nothing yet", async () => {
    const byHand = platform({
      [`/v9/projects/${AUTH.projectId}`]: projectWith("dpl_live01"),
      "/v13/deployments/dpl_live01": deploymentWith({ meta: { other: "x" } }),
    });
    const nothing = platform({
      [`/v9/projects/${AUTH.projectId}`]: projectWith(undefined),
    });

    expect(await livePair(AUTH, byHand.fetch)).toEqual({ status: "none" });
    expect(await livePair(AUTH, nothing.fetch)).toEqual({ status: "none" });
  });

  // #403-T13
  it.each([
    ["a server error", () => json({}, 500)],
    ["a rate limit", () => json({}, 429)],
    [
      "a redirect",
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example" },
        }),
    ],
    [
      "something that is not JSON",
      () => new Response("<html>", { status: 200 }),
    ],
  ])(
    "is unavailable, never none, when the platform answers %s",
    async (_name, answer) => {
      const { fetch } = platform({
        [`/v9/projects/${AUTH.projectId}`]: answer,
      });

      expect(await livePair(AUTH, fetch)).toEqual({ status: "unavailable" });
    },
  );

  // #403-T13
  it("is unavailable when the platform cannot be reached", async () => {
    const failing = (() =>
      Promise.reject(new Error("offline"))) as unknown as typeof fetch;

    expect(await livePair(AUTH, failing)).toEqual({ status: "unavailable" });
  });

  // #403-T13
  it.each([
    ["another project", { projectId: "prj_other" }],
    ["another team", { ownerId: "team_other" }],
  ])(
    "is unavailable when the deployment belongs to %s",
    async (_name, overrides) => {
      const { fetch } = platform({
        [`/v9/projects/${AUTH.projectId}`]: projectWith("dpl_live01"),
        "/v13/deployments/dpl_live01": deploymentWith(overrides),
      });

      expect(await livePair(AUTH, fetch)).toEqual({ status: "unavailable" });
    },
  );

  // #403-T13
  it("reads the pair of any deployment of the project by its id or its address, for a rollback", async () => {
    const { fetch, seen } = platform({
      "/v13/deployments/dpl_old01": deploymentWith({ id: "dpl_old01" }),
    });

    expect(await pairOfDeployment(AUTH, "dpl_old01", fetch)).toEqual({
      status: "pair",
      pair: PAIR,
    });
    expect(seen[0]?.url.pathname).toBe("/v13/deployments/dpl_old01");
  });
});
