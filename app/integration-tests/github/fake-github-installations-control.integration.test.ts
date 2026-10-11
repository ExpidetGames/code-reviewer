// SPDX-License-Identifier: Apache-2.0

// Pins down the control endpoint with which a Playwright journey installs the GitHub App at the fake
// GitHub that runs as its own process: what it creates is what the app's real client and sync read
// back over HTTP, and calling it again replaces the repositories of the installation.
import { describe, expect, it } from "vitest";
import { startSyncHarness } from "../../src/test-support/integration-sync-harness.ts";

async function install(
  baseUrl: string,
  repositories: Array<{ id: number; fullName: string }>,
) {
  return fetch(`${baseUrl}/__fake/installations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      installation: {
        id: 4242,
        account: { login: "acme", id: 5001, type: "Organization" },
      },
      repositories,
    }),
  });
}

describe("the installations control endpoint of the fake GitHub", () => {
  it("installs the app for an account with repositories that the sync reads back", async () => {
    const h = await startSyncHarness();

    const response = await install(h.fake.baseUrl, [
      { id: 7001, fullName: "acme/widgets" },
    ]);
    const summary = await h.sync.syncAll();

    expect(response.status).toBe(201);
    expect(summary.errors).toEqual([]);
    expect(summary.repositories.added).toBe(1);
    expect((await h.repositories.list()).map((r) => r.fullName)).toEqual([
      "acme/widgets",
    ]);
  });

  it("replaces the repositories of an installation that exists when called again", async () => {
    const h = await startSyncHarness();
    await install(h.fake.baseUrl, [{ id: 7001, fullName: "acme/widgets" }]);
    await h.sync.syncAll();

    await install(h.fake.baseUrl, [
      { id: 7001, fullName: "acme/widgets" },
      { id: 7002, fullName: "acme/gadgets" },
    ]);
    const summary = await h.sync.syncAll();

    expect(summary.repositories.added).toBe(1);
    expect((await h.repositories.list()).map((r) => r.fullName).sort()).toEqual(
      ["acme/gadgets", "acme/widgets"],
    );
  });
});
