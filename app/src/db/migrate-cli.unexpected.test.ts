// SPDX-License-Identifier: Apache-2.0

// `pnpm migrate` ends EVERY failure with one line and exit code 1 (#319), also one that is not a
// DatabaseError: the dedicated lock connection of the advisory lock fails with raw `pg` errors, or
// reports that it was lost. The Postgres calls are replaced here; the real ones are in
// migrate-cli.integration.test.ts.
import { describe, expect, it, vi } from "vitest";

const lockFailure = vi.hoisted(() => ({
  error: new Error("placeholder") as Error,
}));
vi.mock("./postgres.ts", () => ({
  openPostgresDatabase: () => ({ destroy: async () => undefined }),
  assertPostgresReachable: async () => undefined,
  withPostgresAdvisoryLock: async () => {
    throw lockFailure.error;
  },
}));

import { runMigrateCommand } from "./migrate-cli.ts";

const env = {
  DATABASE_URL_MIGRATE: "postgres://app:s3cr3t-pw@127.0.0.1:1/app",
};

async function run(error: Error): Promise<{ code: number; err: string[] }> {
  lockFailure.error = error;
  const err: string[] = [];
  const code = await runMigrateCommand(env, {
    out: () => undefined,
    err: (l) => err.push(l),
  });
  return { code, err };
}

describe("runMigrateCommand with an error that is not a DatabaseError", () => {
  // #319-T03
  it("reports a lost lock connection as one line with a stable code and returns 1", async () => {
    const { code, err } = await run(
      new Error("The advisory lock connection was lost: s3cr3t-pw"),
    );

    expect(code).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("MIGRATE_FAILED");
    expect(err[0]).not.toContain("s3cr3t-pw");
  });

  // #319-T03
  it("names the system error code of a raw connection failure", async () => {
    const refused = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:1"),
      {
        code: "ECONNREFUSED",
      },
    );

    const { code, err } = await run(refused);

    expect(code).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("MIGRATE_FAILED");
    expect(err[0]).toContain("ECONNREFUSED");
  });
});
