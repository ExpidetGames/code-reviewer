// SPDX-License-Identifier: Apache-2.0

// Pins down the operator's command `admin reset-password <email>` against a real SQLite file: it prints a
// link for an account that has a password, once, with a token the database keeps only as a hash; a new
// link replaces the old one; an unknown account or one without a password is reported and nothing is
// written. The command also runs as the real process the image starts (node, no Next.js).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-support/test-database.ts";
import { runCli } from "./cli.ts";
import { hashResetToken } from "./token.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const PUBLIC_URL = "https://reviews.example.test";

async function startInstance() {
  const { db, config } = await createTestDatabase();
  for (const [id, email, password] of [
    ["admin-1", "Admin@Example.test", "scrypt-hash-of-the-password"],
    ["github-1", "octo@example.test", null],
  ] as const) {
    await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
      values (${id}, ${id}, ${email}, 0, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
      db,
    );
    await sql`insert into accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
      values (${`acc-${id}`}, ${id}, ${password === null ? "github" : "credential"}, ${id}, ${password}, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
      db,
    );
  }
  const lines = { out: [] as string[], err: [] as string[] };
  const env = { DATABASE_PATH: config.path, BETTER_AUTH_URL: PUBLIC_URL };
  const run = (
    args: string[],
    overrides: Record<string, string | undefined> = {},
    now = new Date("2026-10-11T12:00:00.000Z"),
  ) => {
    lines.out.length = 0;
    lines.err.length = 0;
    const code = runCli(
      args,
      { ...env, ...overrides },
      {
        out: (line) => lines.out.push(line),
        err: (line) => lines.err.push(line),
      },
      () => now,
    );
    return { code, out: [...lines.out], err: [...lines.err] };
  };
  const tokens = () =>
    db.selectFrom("password_reset_tokens").selectAll().execute();
  return { db, config, run, tokens };
}

function tokenOf(link: string | undefined): string {
  return new URL(link ?? "").searchParams.get("token") ?? "";
}

describe("admin reset-password", () => {
  // #98-AD-17
  it("prints one link with a token for an account that has a password and stores only the hash of the token", async () => {
    const { run, tokens, config } = await startInstance();

    const result = run(["reset-password", "admin@example.test"]);

    expect(result.code).toBe(0);
    expect(result.err).toEqual([]);
    const link = result.out.find((line) => line.startsWith("https://"));
    expect(new URL(link ?? "").origin).toBe(PUBLIC_URL);
    expect(new URL(link ?? "").pathname).toBe("/reset-password");
    const token = tokenOf(link);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.out.join("\n").split(token)).toHaveLength(2);
    const rows = await tokens();
    expect(rows).toEqual([
      {
        token_hash: hashResetToken(token),
        user_id: "admin-1",
        created_at: "2026-10-11T12:00:00.000Z",
        expires_at: "2026-10-11T12:30:00.000Z",
        used_at: null,
      },
    ]);
    // Not in the database in any form but the hash.
    const raw = new BetterSqlite3(config.path, { readonly: true });
    const dump = JSON.stringify(
      raw.prepare("select * from password_reset_tokens").all(),
    );
    raw.close();
    expect(dump).not.toContain(token);
  });

  // #98-AD-17
  it("finds the account whatever the case of the address, and says when the link expires", async () => {
    const { run } = await startInstance();

    const result = run(["reset-password", "  ADMIN@example.TEST "]);

    expect(result.code).toBe(0);
    expect(result.out[0]).toContain("admin@example.test");
    expect(result.out[0]).toContain("2026-10-11T12:30:00.000Z");
  });

  it("replaces the unused link of the account with the new one", async () => {
    const { run, tokens } = await startInstance();
    const first = tokenOf(run(["reset-password", "admin@example.test"]).out[1]);

    const second = tokenOf(
      run(["reset-password", "admin@example.test"]).out[1],
    );

    expect(second).not.toBe(first);
    expect((await tokens()).map((row) => row.token_hash)).toEqual([
      hashResetToken(second),
    ]);
  });

  // #98-AD-18
  // #98-AD-17
  it("switches email with password sign-in back on when the admin had switched it off, says so, and records the system as the one who changed it", async () => {
    const { db, run } = await startInstance();
    await db
      .insertInto("instance_settings")
      .values({
        key: "sign_in_methods",
        value: JSON.stringify({ emailPassword: false, github: true }),
        updated_by: "github-1",
        updated_at: "2026-10-10T00:00:00.000Z",
      })
      .execute();

    const result = run(["reset-password", "admin@example.test"]);

    expect(result.code).toBe(0);
    expect(result.out).toHaveLength(3);
    expect(result.out[2]).toContain("switched on again");
    expect(
      await db
        .selectFrom("instance_settings")
        .selectAll()
        .where("key", "=", "sign_in_methods")
        .executeTakeFirst(),
    ).toEqual({
      key: "sign_in_methods",
      value: JSON.stringify({ emailPassword: true, github: true }),
      updated_by: null,
      updated_at: "2026-10-11T12:00:00.000Z",
    });
  });

  it("leaves the ways to sign in alone when email with password is on, or nothing was ever saved", async () => {
    const { db, run } = await startInstance();
    const untouched = run(["reset-password", "admin@example.test"]);
    await db
      .insertInto("instance_settings")
      .values({
        key: "sign_in_methods",
        value: JSON.stringify({ emailPassword: true, github: false }),
        updated_by: "github-1",
        updated_at: "2026-10-10T00:00:00.000Z",
      })
      .execute();

    const on = run(["reset-password", "admin@example.test"]);

    expect(untouched.out).toHaveLength(2);
    expect(on.out).toHaveLength(2);
    expect(
      (
        await db
          .selectFrom("instance_settings")
          .select(["updated_by", "updated_at"])
          .where("key", "=", "sign_in_methods")
          .executeTakeFirstOrThrow()
      ).updated_at,
    ).toBe("2026-10-10T00:00:00.000Z");
  });

  it("changes nothing in the settings when the account is unknown", async () => {
    const { db, run } = await startInstance();
    await db
      .insertInto("instance_settings")
      .values({
        key: "sign_in_methods",
        value: JSON.stringify({ emailPassword: false, github: true }),
        updated_by: null,
        updated_at: "2026-10-10T00:00:00.000Z",
      })
      .execute();

    run(["reset-password", "nobody@example.test"]);

    expect(
      JSON.parse(
        (
          await db
            .selectFrom("instance_settings")
            .select("value")
            .executeTakeFirstOrThrow()
        ).value,
      ),
    ).toEqual({ emailPassword: false, github: true });
  });

  it("reports an unknown account and writes nothing", async () => {
    const { run, tokens } = await startInstance();

    const result = run(["reset-password", "nobody@example.test"]);

    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toContain("UNKNOWN_ACCOUNT");
    expect(await tokens()).toEqual([]);
  });

  it("reports an account without a password and writes nothing", async () => {
    const { run, tokens } = await startInstance();

    const result = run(["reset-password", "octo@example.test"]);

    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("NO_PASSWORD_ACCOUNT");
    expect(await tokens()).toEqual([]);
  });

  it.each([
    [[]],
    [["reset-password"]],
    [["reset-password", "a@example.test", "extra"]],
    [["something-else", "a@example.test"]],
  ])(
    "answers the command line %j with the usage and exit code 2",
    async (args) => {
      const { run } = await startInstance();

      const result = run(args);

      expect(result.code).toBe(2);
      expect(result.err).toEqual(["Usage: admin reset-password <email>"]);
    },
  );

  it("says what is missing when the public address or the database is not there", async () => {
    const { run } = await startInstance();

    const noAddress = run(["reset-password", "admin@example.test"], {
      BETTER_AUTH_URL: undefined,
    });
    const noDatabase = run(["reset-password", "admin@example.test"], {
      DATABASE_PATH: "/nonexistent/app.db",
    });

    expect([noAddress.code, noDatabase.code]).toEqual([1, 1]);
    expect(noAddress.err.join()).toContain("PUBLIC_URL_MISSING");
    expect(noDatabase.err.join()).toContain("DATABASE_UNAVAILABLE");
  });

  it("runs as a real process without Next.js and prints the link on stdout", async () => {
    const { config, tokens } = await startInstance();

    const result = spawnSync(
      process.execPath,
      ["--no-warnings", cli, "reset-password", "admin@example.test"],
      {
        // Only what the command needs: nothing of the test runner's environment leaks in.
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH ?? "",
          DATABASE_PATH: config.path,
          BETTER_AUTH_URL: PUBLIC_URL,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const link = result.stdout
      .split("\n")
      .find((line) => line.startsWith("https://"));
    expect((await tokens()).map((row) => row.token_hash)).toEqual([
      hashResetToken(tokenOf(link)),
    ]);
  });
});
