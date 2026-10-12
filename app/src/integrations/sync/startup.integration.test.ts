// SPDX-License-Identifier: Apache-2.0

// Pins down the sync that runs when the server starts: it fills the tables, and whatever goes wrong
// (GitHub down, settings missing, no database) is logged and never stops the start.
import { describe, expect, it } from "vitest";
import { startSyncHarness } from "../../test-support/integration-sync-harness.ts";
import { runStartupSync } from "./startup.ts";

const ACME = { login: "acme", id: 5001, type: "Organization" } as const;

describe("the sync at server start", () => {
  // CR-21-T01
  it("reads the installations and repositories of an empty database", async () => {
    const h = await startSyncHarness();
    h.fake.addInstallation({ id: 4242, account: ACME });
    h.fake.setRepositories(4242, [
      { id: 7001, fullName: "acme/widgets" },
      { id: 7002, fullName: "acme/gadgets" },
    ]);
    const lines: string[] = [];

    const summary = await runStartupSync({
      getDb: () => h.db,
      registry: h.registry,
      placeNewConnection: async () => h.workspaceId,
      log: (line) => lines.push(line),
    });

    expect(summary?.repositories.added).toBe(2);
    expect(await h.repositories.list({ active: true })).toHaveLength(2);
    expect(lines.at(-1)).toContain("2 repositories added");
  });

  // CR-21-T09
  it("starts anyway when GitHub answers with a server error, logs it and keeps the repositories", async () => {
    const h = await startSyncHarness();
    h.fake.addInstallation({ id: 4242, account: ACME });
    h.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
    await h.sync.syncAll();
    h.fake.fail({ status: 500 });
    const lines: Array<[string, string]> = [];

    const summary = await runStartupSync({
      getDb: () => h.db,
      registry: h.registry,
      log: (line, level) => lines.push([level, line]),
    });

    expect(summary?.errors.map((error) => error.code)).toEqual([
      "GITHUB_APP_UNAVAILABLE",
    ]);
    expect(lines.length).toBeGreaterThan(0);
    // Failures are logged as errors, not as information.
    expect(lines.every(([level]) => level === "error")).toBe(true);
    expect(lines.map(([, line]) => line).join("\n")).toContain(
      "GITHUB_APP_UNAVAILABLE",
    );
    expect(await h.repositories.list({ active: true })).toHaveLength(1);
  });

  it("starts anyway when the GitHub App settings are missing", async () => {
    const h = await startSyncHarness({ env: { GITHUB_APP_SLUG: undefined } });
    const lines: string[] = [];

    const summary = await runStartupSync({
      getDb: () => h.db,
      registry: h.registry,
      log: (line) => lines.push(line),
    });

    expect(summary?.errors).toEqual([
      expect.objectContaining({ code: "GITHUB_APP_CONFIG_INVALID" }),
    ]);
    expect(lines.join("\n")).toContain("GITHUB_APP_SLUG");
  });

  it("resolves with null instead of throwing when there is no database", async () => {
    const lines: string[] = [];

    const summary = await runStartupSync({
      getDb: () => {
        throw new Error("The database is not initialized");
      },
      log: (line) => lines.push(line),
    });

    expect(summary).toBeNull();
    expect(lines).toHaveLength(1);
  });
});
