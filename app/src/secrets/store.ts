// SPDX-License-Identifier: Apache-2.0

// The encrypted secret store (docs/decisions/0001-editions-setup-and-accounts.md, section 2.7), on
// top of the crypto helpers (src/crypto/):
//
// - `save` encrypts with a key derived from `APP_SECRET` (AES-256-GCM, a random nonce every time, the
//   table, the name and the field as additional authenticated data) and stores the sealed value with
//   its key version.
// - `status` / `statuses` say whether a secret exists, and, when it does, whether it can still be
//   read. They never contain the value; the only part of it that can appear is the last four
//   characters, and only when the caller asked for that hint at save time.
// - `use` hands the value to code on the server, wrapped in a `SecretValue` that prints as a
//   placeholder. No API route returns it.
//
// A secret that cannot be decrypted (a changed row, a wrong `APP_SECRET`, an unknown key version) is
// the state `undecryptable` with a stable code. Nothing here throws for it, and nothing here logs.
import type { Kysely } from "kysely";
import {
  decryptSecret,
  encryptSecret,
  SecretBoxError,
  type SecretBoxErrorCode,
  type SecretLocation,
} from "../crypto/secret-box.ts";
import {
  createSecretsRepository,
  type SecretRow,
} from "../db/repositories/secrets-repository.ts";
import type { Database } from "../db/schema.ts";
import { SECRET_NAMES, type SecretName } from "./names.ts";
import { SecretValue } from "./secret-value.ts";

export const SECRET_STORE_ERROR_CODES = [
  /** The value is empty or only white space. */
  "secret_empty",
  /** The value is longer than any credential is. */
  "secret_too_long",
  /** Nothing is stored under that name. */
  "secret_not_configured",
  /** What is stored cannot be decrypted (changed, or made with another `APP_SECRET`). */
  "secret_undecryptable",
  /** What is stored was made with a key version this build does not know. */
  "secret_key_version_unknown",
] as const;
export type SecretStoreErrorCode = (typeof SECRET_STORE_ERROR_CODES)[number];

/** A PEM private key is about 3 KB; nothing the store holds comes near this. */
export const SECRET_MAX_LENGTH = 64 * 1024;
/** A hint of four characters is shown only for values at least this long. */
export const LAST_FOUR_MIN_LENGTH = 16;

const TABLE = "secrets";
const FIELD = "value";

function locationOf(name: string): SecretLocation {
  return { table: TABLE, rowId: name, field: FIELD };
}

export type SecretStatus =
  | { name: SecretName; state: "not_configured" }
  | {
      name: SecretName;
      state: "configured";
      /** The last four characters, if the hint was asked for when it was saved; else null. */
      lastFour: string | null;
      keyVersion: number;
      updatedAt: string;
      updatedBy: string | null;
    }
  | {
      name: SecretName;
      state: "undecryptable";
      code: SecretBoxErrorCode;
      updatedAt: string;
      updatedBy: string | null;
    };

export type SaveSecretOptions = {
  /** The id of the user who saves it, or null. */
  updatedBy: string | null;
  /** Keep the last four characters in the clear, for the page to show (only for long values). */
  showLastFour?: boolean;
};

export type SaveSecretResult =
  { ok: true } | { ok: false; error: "secret_empty" | "secret_too_long" };

export type UseSecretResult =
  | { ok: true; value: SecretValue }
  | {
      ok: false;
      error:
        | "secret_not_configured"
        | "secret_undecryptable"
        | "secret_key_version_unknown";
    };

export type SecretStore = {
  save(
    name: SecretName,
    value: string,
    options: SaveSecretOptions,
  ): Promise<SaveSecretResult>;
  status(name: SecretName): Promise<SecretStatus>;
  /** The status of every known secret, in the order of `SECRET_NAMES`. */
  statuses(): Promise<SecretStatus[]>;
  /** The value, for code on the server that needs it. Never hand it to a response. */
  use(name: SecretName): Promise<UseSecretResult>;
  /** Forgets the secret; false when there was none. */
  remove(name: SecretName): Promise<boolean>;
};

export type SecretStoreOptions = {
  db: Kysely<Database>;
  /** The master key (`APP_SECRET`). */
  appSecret: string;
  now?: () => Date;
};

function lastFourOf(value: string): string {
  return [...value].slice(-4).join("");
}

export function createSecretStore({
  db,
  appSecret,
  now = () => new Date(),
}: SecretStoreOptions): SecretStore {
  const rows = createSecretsRepository(db, now);

  // Decrypts one row; the failure is a value, not an exception.
  function open(
    row: SecretRow,
  ): { ok: true; value: string } | { ok: false; code: SecretBoxErrorCode } {
    try {
      return {
        ok: true,
        value: decryptSecret(appSecret, locationOf(row.name), {
          keyVersion: row.keyVersion,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
        }),
      };
    } catch (error) {
      if (error instanceof SecretBoxError)
        return { ok: false, code: error.code };
      // Whatever it was, the caller learns one thing and nothing of the input.
      return { ok: false, code: "secret_undecryptable" };
    }
  }

  function describe(
    name: SecretName,
    row: SecretRow | undefined,
  ): SecretStatus {
    if (row === undefined) return { name, state: "not_configured" };
    const opened = open(row);
    if (!opened.ok)
      return {
        name,
        state: "undecryptable",
        code: opened.code,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      };
    return {
      name,
      state: "configured",
      lastFour: row.lastFour,
      keyVersion: row.keyVersion,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  return {
    async save(name, value, options) {
      if (value.trim() === "") return { ok: false, error: "secret_empty" };
      if (value.length > SECRET_MAX_LENGTH)
        return { ok: false, error: "secret_too_long" };
      const sealed = encryptSecret(appSecret, locationOf(name), value);
      await rows.put({
        name,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        keyVersion: sealed.keyVersion,
        lastFour:
          options.showLastFour === true && value.length >= LAST_FOUR_MIN_LENGTH
            ? lastFourOf(value)
            : null,
        updatedBy: options.updatedBy,
      });
      return { ok: true };
    },

    async status(name) {
      return describe(name, await rows.get(name));
    },

    async statuses() {
      const stored = new Map((await rows.list()).map((row) => [row.name, row]));
      return SECRET_NAMES.map((name) => describe(name, stored.get(name)));
    },

    async use(name) {
      const row = await rows.get(name);
      if (row === undefined)
        return { ok: false, error: "secret_not_configured" };
      const opened = open(row);
      if (!opened.ok) return { ok: false, error: opened.code };
      return { ok: true, value: new SecretValue(opened.value) };
    },

    remove: (name) => rows.remove(name),
  };
}
