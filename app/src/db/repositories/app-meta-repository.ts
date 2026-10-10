// Access to the app_meta table. The only code that reads or writes it.
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

export type AppMetaRepository = {
  get(key: string): Promise<string | undefined>;
  /** Inserts the key or replaces its value. */
  set(key: string, value: string): Promise<void>;
};

export function createAppMetaRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): AppMetaRepository {
  return {
    async get(key) {
      const row = await db
        .selectFrom("app_meta")
        .select("value")
        .where("key", "=", key)
        .executeTakeFirst();
      return row?.value;
    },

    async set(key, value) {
      const updated_at = formatTimestamp(now());
      await db
        .insertInto("app_meta")
        .values({ key, value, updated_at })
        .onConflict((conflict) => conflict.column("key").doUpdateSet({ value, updated_at }))
        .execute();
    },
  };
}
