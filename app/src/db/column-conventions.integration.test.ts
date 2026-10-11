// SPDX-License-Identifier: Apache-2.0

// Pins down, against a real SQLite file, that the portable column conventions hold end to end:
// a repository that stores JSON as text and booleans as integers gives back exactly what it got.
// The probe table is local to this test; the real schema has no JSON or boolean column yet.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  decodeBoolean,
  decodeJson,
  encodeBoolean,
  encodeJson,
} from "./codecs.ts";
import type { Database } from "./schema.ts";

type ProbeRow = { id: string; payload: string; enabled: number };
type ProbeDatabase = { probe: ProbeRow };

async function createProbeRepository() {
  const { db: appDb } = await createTestDatabase();
  const db = appDb as unknown as Kysely<ProbeDatabase & Database>;
  await db.schema
    .createTable("probe")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("payload", "text", (c) => c.notNull())
    .addColumn("enabled", "integer", (c) => c.notNull())
    .execute();

  return {
    db,
    async save(id: string, payload: unknown, enabled: boolean) {
      await db
        .insertInto("probe")
        .values({
          id,
          payload: encodeJson(payload),
          enabled: encodeBoolean(enabled),
        })
        .execute();
    },
    async load(id: string) {
      const row = await db
        .selectFrom("probe")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      return {
        payload: decodeJson(row.payload),
        enabled: decodeBoolean(row.enabled),
      };
    },
  };
}

describe("a repository using the column conventions", () => {
  // CR-15-T04
  it("reads a nested object back equal to what was saved, stored as text", async () => {
    const repository = await createProbeRepository();
    const payload = {
      name: "review",
      tags: ["a", "b"],
      nested: { count: 3, empty: null },
    };

    await repository.save("one", payload, true);

    expect((await repository.load("one")).payload).toEqual(payload);
    const { rows } = await sql<{
      type: string;
    }>`select typeof(payload) as type from probe`.execute(repository.db);
    expect(rows[0]?.type).toBe("text");
  });

  // CR-15-T05
  it("stores true as 1 and false as 0 and reads them back as booleans", async () => {
    const repository = await createProbeRepository();

    await repository.save("on", {}, true);
    await repository.save("off", {}, false);

    const { rows } = await sql<{ id: string; enabled: number; type: string }>`
      select id, enabled, typeof(enabled) as type from probe order by id`.execute(
      repository.db,
    );
    expect(rows).toEqual([
      { id: "off", enabled: 0, type: "integer" },
      { id: "on", enabled: 1, type: "integer" },
    ]);
    expect((await repository.load("on")).enabled).toBe(true);
    expect((await repository.load("off")).enabled).toBe(false);
  });
});
