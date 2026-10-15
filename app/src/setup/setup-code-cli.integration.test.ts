// SPDX-License-Identifier: Apache-2.0

// `pnpm setup-code` against a real (SQLite) database (#321): it writes a code the app's store accepts, a
// second run replaces it, and it refuses on an instance that is set up. The Postgres connection of the
// real command is covered by the same code path as `pnpm migrate`.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { createDatabaseSetupCodeStore } from "./database-code-store.ts";
import {
  createSetupCodeBackend,
  runSetupCodeCommand,
} from "./setup-code-cli.ts";

const SECRET = "cli-secret-0123456789-0123456789-0123456789";
const ENV = { APP_RUNTIME: "serverless", APP_SECRET: SECRET } as const;

async function setUp() {
  const { db } = await createTestDatabase();
  const out: string[] = [];
  const err: string[] = [];
  async function run() {
    out.length = 0;
    err.length = 0;
    const code = await runSetupCodeCommand(
      ENV,
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      {
        isTerminal: true,
        allowPipe: false,
        // The test owns the database: the command's close() must not end it for the next run.
        open: () =>
          Promise.resolve({
            ...createSetupCodeBackend(db, SECRET),
            close: () => Promise.resolve(),
          }),
      },
    );
    return code;
  }
  const printedCode = () => out.join("\n").match(/\b(\d{6})\b/)?.[1] ?? "";
  return { db, run, out, err, printedCode };
}

describe("pnpm setup-code against a database", () => {
  // #321-T01
  it("writes a code that the store of another instance accepts", async () => {
    const { db, run, printedCode } = await setUp();

    expect(await run()).toBe(0);

    const instance = createDatabaseSetupCodeStore({ db, appSecret: SECRET });
    const result = await instance.attempt(printedCode());
    expect(result.ok).toBe(true);
  });

  // #321-T05
  it("stores only a hash: the printed code is not in the database", async () => {
    const { db, run, printedCode } = await setUp();
    await run();

    const rows = await db.selectFrom("setup_codes").selectAll().execute();

    expect(printedCode()).toMatch(/^\d{6}$/);
    expect(JSON.stringify(rows)).not.toContain(printedCode());
  });

  // #321-T01
  it("run again replaces the code: the first one stops working", async () => {
    const { db, run, printedCode } = await setUp();
    await run();
    const first = printedCode();
    await run();
    const second = printedCode();

    const instance = createDatabaseSetupCodeStore({ db, appSecret: SECRET });
    if (first !== second)
      expect(await instance.attempt(first)).toMatchObject({
        ok: false,
        error: "invalid_code",
      });
    expect(await instance.attempt(second)).toMatchObject({ ok: true });
  });

  // #321-T06
  it("refuses on an instance that is set up, and leaves no code", async () => {
    const { db, run, out, err } = await setUp();
    await createInstanceSettingsRepository(db).set(
      "setup_completed_at",
      "2026-10-15T07:00:00.000Z",
      null,
    );

    expect(await run()).toBe(1);

    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("SETUP_ALREADY_DONE");
    expect(await db.selectFrom("setup_codes").select("id").execute()).toEqual(
      [],
    );
  });

  // #321-T06
  it("issues a code on an instance that is not set up although users exist (an existing installation)", async () => {
    const { db, run } = await setUp();
    await db
      .insertInto("users")
      .values({
        id: "imported",
        name: "imported",
        email: "imported@users.noreply.github.com",
        email_verified: 0,
        image: null,
        github_login: "imported",
        imported_at: "2026-10-11T00:00:00.000Z",
        org_checked_at: null,
        org_checked_for: null,
        created_at: "2026-10-11T00:00:00.000Z",
        updated_at: "2026-10-11T00:00:00.000Z",
      })
      .execute();

    expect(await run()).toBe(0);
  });
});
