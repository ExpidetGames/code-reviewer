// SPDX-License-Identifier: Apache-2.0

// The refusals of `pnpm migrate` that need no database (#319). The run against a real Postgres is in
// migrate-cli.integration.test.ts.
import { describe, expect, it, vi } from "vitest";
import { runMigrateCommand } from "./migrate-cli.ts";

function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
  };
}

describe("runMigrateCommand without a database", () => {
  // #319-T03
  it("fails with one line naming DATABASE_URL_MIGRATE when it is not set, and does not fall back to DATABASE_URL", async () => {
    const { err, io } = recorder();

    const code = await runMigrateCommand(
      { DATABASE_URL: "postgres://app:s3cr3t-pw@db.example.test/app" },
      io,
    );

    expect(code).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("DATABASE_URL_MIGRATE");
    expect(err[0]).toContain("DATABASE_CONFIG_INVALID");
    expect(err.join("\n")).not.toContain("s3cr3t-pw");
  });

  // #319-T03
  it("fails for an unreachable database with the host and the code, never the password, and does not exit the process", async () => {
    const { err, io } = recorder();
    const exit = vi.spyOn(process, "exit");

    const code = await runMigrateCommand(
      { DATABASE_URL_MIGRATE: "postgres://app:s3cr3t-pw@127.0.0.1:1/app" },
      io,
    );

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("DATABASE_OPEN_FAILED");
    expect(err.join("\n")).toContain("127.0.0.1");
    expect(err.join("\n")).not.toContain("s3cr3t-pw");
    expect(exit).not.toHaveBeenCalled();
  });
});
