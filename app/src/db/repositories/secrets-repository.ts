// SPDX-License-Identifier: Apache-2.0

// Access to the secrets table: the encrypted credentials of the instance, one row per name. This
// module only moves rows; the encryption, the additional authenticated data and the rules for what
// may be shown are in src/secrets/. Instance level (a credential of the instance belongs to no
// workspace).
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database, SecretsTable } from "../schema.ts";

/** A stored secret as the database holds it: the sealed value and who saved it when. */
export type SecretRow = {
  name: string;
  ciphertext: string;
  nonce: string;
  keyVersion: number;
  /** The last four characters of the value if a hint was asked for; not a secret. */
  lastFour: string | null;
  updatedBy: string | null;
  updatedAt: string;
};

export type SecretsRepository = {
  get(name: string): Promise<SecretRow | undefined>;
  /** Every stored secret, ordered by name. */
  list(): Promise<SecretRow[]>;
  /** Inserts the secret or replaces it, recording who and when. */
  put(secret: Omit<SecretRow, "updatedAt">): Promise<void>;
  /** Removes the secret; false when there was none. */
  remove(name: string): Promise<boolean>;
};

function toRow(row: SecretsTable): SecretRow {
  return {
    name: row.name,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    keyVersion: row.key_version,
    lastFour: row.last_four,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

export function createSecretsRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): SecretsRepository {
  return {
    async get(name) {
      const row = await db
        .selectFrom("secrets")
        .selectAll()
        .where("name", "=", name)
        .executeTakeFirst();
      return row === undefined ? undefined : toRow(row);
    },

    async list() {
      const rows = await db
        .selectFrom("secrets")
        .selectAll()
        .orderBy("name")
        .execute();
      return rows.map(toRow);
    },

    async put(secret) {
      const row: SecretsTable = {
        name: secret.name,
        ciphertext: secret.ciphertext,
        nonce: secret.nonce,
        key_version: secret.keyVersion,
        last_four: secret.lastFour,
        updated_by: secret.updatedBy,
        updated_at: formatTimestamp(now()),
      };
      await db
        .insertInto("secrets")
        .values(row)
        .onConflict((conflict) =>
          conflict.column("name").doUpdateSet({
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            key_version: row.key_version,
            last_four: row.last_four,
            updated_by: row.updated_by,
            updated_at: row.updated_at,
          }),
        )
        .execute();
    },

    async remove(name) {
      const result = await db
        .deleteFrom("secrets")
        .where("name", "=", name)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}
