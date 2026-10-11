// SPDX-License-Identifier: Apache-2.0

// The mail server of the instance as it is stored (docs/decisions/0001-editions-setup-and-accounts.md,
// sections 2.3 and 2.7): the settings in `instance_settings` (key `smtp`), the password in the encrypted
// secret store (`smtp_password`). Mail is never configured through environment variables, so this is the
// only place the sender and the admin portal learn about the mail server, and every call reads the
// database: removing the mail server takes effect on the next request.
//
// - The password is write-only. What the portal reads (`view`) says whether one is set, can be read or
//   cannot be read; the value only leaves through `resolve`, wrapped so that it prints as a placeholder, for
//   the sender on the server.
// - An empty password field keeps the stored password, a new one replaces it, the explicit clear removes
//   it. A login without a password is only possible through the clear (the admin said so); on the first
//   save and after a password that cannot be decrypted, a login needs a password entered now.
// - A server without a login has no password: a stored one goes with the login.
// - Stored settings that no longer pass the rules (a row edited by hand) count as no mail server.
import type { Kysely } from "kysely";
import {
  createInstanceSettingsRepository,
  type InstanceSettingsRepository,
} from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import type { SecretValue } from "../secrets/secret-value.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { SetupIssue } from "../setup/errors.ts";
import {
  parseSmtpInput,
  readStoredSmtpSettings,
  type SmtpSettings,
} from "./smtp-settings.ts";

const PASSWORD_SECRET = "smtp_password";

export type SmtpPasswordState = "none" | "configured" | "unreadable";

/** What the admin portal shows: never a password. */
export type SmtpConfigView = {
  /** Null: no mail server. */
  settings: SmtpSettings | null;
  password: SmtpPasswordState;
  /** The id of the user who saved it last, or null. */
  updatedBy: string | null;
  /** ISO 8601 UTC, or null when there is no mail server. */
  updatedAt: string | null;
};

/** What the sender needs: the settings and what became of the password. */
export type ResolvedSmtp = {
  settings: SmtpSettings;
  password:
    | { state: "none" }
    | { state: "unreadable" }
    | { state: "set"; value: SecretValue };
};

export type SaveSmtpResult =
  { ok: true } | { ok: false; error: "invalid_input"; issues: SetupIssue[] };

export type SmtpConfigStore = {
  /** Whether the instance has a mail server. One cheap read. */
  isConfigured(): Promise<boolean>;
  view(): Promise<SmtpConfigView>;
  /** For the sender on the server. */
  resolve(): Promise<ResolvedSmtp | null>;
  /** `raw` is the request's `smtp` object, as received. */
  save(actorId: string, raw: unknown): Promise<SaveSmtpResult>;
  /** Removes the mail server and its password. */
  remove(): Promise<void>;
};

export type SmtpConfigStoreOptions = {
  db: Kysely<Database>;
  secrets: Pick<SecretStore, "save" | "status" | "use" | "remove">;
  now?: () => Date;
};

export function createSmtpConfigStore({
  db,
  secrets,
  now = () => new Date(),
}: SmtpConfigStoreOptions): SmtpConfigStore {
  const settings: InstanceSettingsRepository = createInstanceSettingsRepository(
    db,
    now,
  );

  async function stored() {
    const row = await settings.getWithMeta("smtp");
    if (row === undefined) return null;
    const valid = readStoredSmtpSettings(row.value);
    return valid === null ? null : { ...row, value: valid };
  }

  return {
    async isConfigured() {
      return (await stored()) !== null;
    },

    async view() {
      const row = await stored();
      if (row === null)
        return {
          settings: null,
          password: "none",
          updatedBy: null,
          updatedAt: null,
        };
      const status = await secrets.status(PASSWORD_SECRET);
      return {
        settings: row.value,
        password:
          status.state === "configured"
            ? "configured"
            : status.state === "undecryptable"
              ? "unreadable"
              : "none",
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt,
      };
    },

    async resolve() {
      const row = await stored();
      if (row === null) return null;
      // A server without a login has no password to use, whatever is left in the store.
      if (row.value.user === null)
        return { settings: row.value, password: { state: "none" } };
      const used = await secrets.use(PASSWORD_SECRET);
      if (used.ok)
        return {
          settings: row.value,
          password: { state: "set", value: used.value },
        };
      return {
        settings: row.value,
        password: {
          state: used.error === "secret_not_configured" ? "none" : "unreadable",
        },
      };
    },

    async save(actorId, raw) {
      const parsed = parseSmtpInput(raw);
      if (!parsed.ok)
        return { ok: false, error: "invalid_input", issues: parsed.issues };
      const { settings: next, password } = parsed.value;
      const current = await secrets.status(PASSWORD_SECRET);

      const refuse = (field: string, code: string): SaveSmtpResult => ({
        ok: false,
        error: "invalid_input",
        issues: [{ field, code }],
      });
      if (next.user === null && password.kind === "set")
        return refuse("password", "user_required");
      // A login needs a password: entered now, or still stored and readable. (The explicit clear is the
      // admin's way to say that this server logs in without one.)
      if (
        next.user !== null &&
        password.kind === "keep" &&
        current.state !== "configured"
      )
        return refuse("password", "password_required");

      if (password.kind === "set") {
        const saved = await secrets.save(PASSWORD_SECRET, password.value, {
          updatedBy: actorId,
        });
        if (!saved.ok) return refuse("password", "password_invalid");
      }
      await settings.set("smtp", next, actorId);
      // The login is gone, or the admin asked for no password: nothing stays in the store.
      if (password.kind === "clear" || next.user === null)
        await secrets.remove(PASSWORD_SECRET);
      return { ok: true };
    },

    async remove() {
      await settings.remove("smtp");
      await secrets.remove(PASSWORD_SECRET);
    },
  };
}
