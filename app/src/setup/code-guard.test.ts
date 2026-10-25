// SPDX-License-Identifier: LicenseRef-Proprietary

// Which setup code store a runtime mode uses (#321): a server keeps its code in memory, as before, and
// never opens the database for it; a serverless deployment reads it from the database.
import { describe, expect, it, vi } from "vitest";
import type { SetupCodeGuard } from "./code-store.ts";
import { selectSetupCodeGuard } from "./code-guard.ts";

function guard(): SetupCodeGuard {
  return {
    attempt: () => ({ ok: false, error: "setup_unavailable" }),
    currentIssueId: () => null,
    invalidate: () => undefined,
  };
}

describe("selectSetupCodeGuard", () => {
  // #321-T04
  it("uses the store in memory on a server and never builds the database store", () => {
    const memory = guard();
    const database = vi.fn(guard);

    const chosen = selectSetupCodeGuard({
      env: { APP_RUNTIME: "server" },
      memory: () => memory,
      database,
    });

    expect(chosen).toBe(memory);
    expect(database).not.toHaveBeenCalled();
  });

  // #321-T04
  it("uses the store in memory without any setting, as before", () => {
    const memory = guard();

    const chosen = selectSetupCodeGuard({
      env: {},
      memory: () => memory,
      database: () => guard(),
    });

    expect(chosen).toBe(memory);
  });

  // #321-T01
  it("uses the database store in a serverless deployment and never builds the one in memory", () => {
    const database = guard();
    const memory = vi.fn(guard);

    const chosen = selectSetupCodeGuard({
      env: { APP_RUNTIME: "serverless" },
      memory,
      database: () => database,
    });

    expect(chosen).toBe(database);
    expect(memory).not.toHaveBeenCalled();
  });

  // #321-T01
  it("also uses the database store when the hosting platform marks the environment", () => {
    const database = guard();

    const chosen = selectSetupCodeGuard({
      env: { VERCEL: "1" },
      memory: () => guard(),
      database: () => database,
    });

    expect(chosen).toBe(database);
  });
});
