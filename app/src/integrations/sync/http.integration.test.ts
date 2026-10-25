// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the handler behind `POST /api/integrations/sync` (the "Sync from GitHub" button): a
// signed in user runs the sync against the fake GitHub and learns how many repositories are new, a
// request from another site is refused, and the user is asked for before GitHub is called. Real
// Postgres and the real provider against the fake GitHub; only the user check is passed in.
import { describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth/access-policy.ts";
import { startSyncHarness } from "../../test-support/integration-sync-harness.ts";
import { createSyncRouteHandler } from "./http.ts";

const USER = { id: "u1", githubLogin: "octocat" } as unknown as SessionUser;
const ACME = { login: "acme", id: 5001, type: "Organization" } as const;

async function startHandler() {
  const h = await startSyncHarness();
  let asked = 0;
  const handle = createSyncRouteHandler({
    requireUser: async () => {
      asked += 1;
      return USER;
    },
    sync: h.sync,
  });
  function post(headers: Record<string, string> = {}) {
    return handle(
      new Request("https://app.test/api/integrations/sync", {
        method: "POST",
        headers,
      }),
    );
  }
  return { ...h, post, asked: () => asked };
}

describe("the sync handler", () => {
  // CR-21-T03
  it("stores a repository that only exists at GitHub and answers with the number of new repositories", async () => {
    const app = await startHandler();
    app.fake.addInstallation({ id: 4242, account: ACME });
    app.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);

    const response = await app.post();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ added: 1, errors: [] });
    expect(
      (await app.repositories.list()).map((repo) => repo.fullName),
    ).toEqual(["acme/widgets"]);
  });

  it("answers with no new repositories when the second run finds nothing new", async () => {
    const app = await startHandler();
    app.fake.addInstallation({ id: 4242, account: ACME });
    app.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
    await app.post();

    const response = await app.post();

    expect(await response.json()).toEqual({ added: 0, errors: [] });
  });

  it("reports what went wrong at GitHub by stage and code, without a credential, and changes nothing", async () => {
    const app = await startHandler();
    app.fake.addInstallation({ id: 4242, account: ACME });
    app.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
    await app.post();
    app.fake.rejectAppJwts(true);

    const response = await app.post();
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      added: 0,
      errors: [{ stage: "discover", code: "GITHUB_APP_AUTH_FAILED" }],
    });
    for (const credential of app.fake.seenCredentials())
      expect(text).not.toContain(credential);
    expect((await app.repositories.list()).map((repo) => repo.active)).toEqual([
      true,
    ]);
  });

  it("refuses a request that comes from another site and does not call GitHub", async () => {
    const app = await startHandler();

    const response = await app.post({ "sec-fetch-site": "cross-site" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "SYNC_CROSS_SITE_REQUEST" });
    expect(app.fake.requests()).toEqual([]);
  });

  it("asks for the user before anything else, and a refusal reaches the caller", async () => {
    const h = await startSyncHarness();
    const refusal = new Error("NEXT_REDIRECT");
    const handle = createSyncRouteHandler({
      requireUser: () => Promise.reject(refusal),
      sync: h.sync,
    });

    await expect(
      handle(
        new Request("https://app.test/api/integrations/sync", {
          method: "POST",
          headers: { "sec-fetch-site": "cross-site" },
        }),
      ),
    ).rejects.toBe(refusal);

    expect(h.fake.requests()).toEqual([]);
  });
});
