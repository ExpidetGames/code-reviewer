// SPDX-License-Identifier: LicenseRef-Proprietary

// The mail server of the instance as it is stored (docs/decisions/0001-editions-setup-and-accounts.md,
// sections 2.3 and 2.7): the settings in `instance_settings` (key `smtp`), the password in the encrypted
// secret store (`smtp_password`). Mail is never configured through environment variables, so this is the
// only place the sender and the admin portal learn about the mail server, and every call reads the
// database: removing the mail server takes effect on the next request.
//
// - The password is write-only. What the portal reads (`view`) says whether one is set, can be read or
//   cannot be read; the value only leaves through `resolve`, wrapped so that it prints as a placeholder, for
//   the sender on the server.
// - The saved password is not carried over to another server. "Keep" (an empty field) is only valid while
//   host, port, user and security are unchanged; otherwise the password has to be entered again
//   (`password_required_for_new_server`). Without that, a stolen admin session could point the host at a
//   server of its own and have "Send test mail" deliver the stored password there.
// - "Can send" and "saved" are different: `isConfigured` is true when a message could be sent (the settings
//   are valid and, for a login, the password is there and can be read), `isSaved` when there is a row. An
//   instance whose saved password cannot be read behaves as one without a mail server (nothing is offered
//   that could never work) while the portal shows the settings and asks for the password again.
// - Saving and removing change the settings and the password in one transaction.
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
import { createSecretStore } from "../secrets/store.ts";
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
  /** Whether a message could be sent now: valid settings and, for a login, a password that can be read. */
  isConfigured(): Promise<boolean>;
  /** Whether there are saved settings, whatever the state of the password. */
  isSaved(): Promise<boolean>;
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
  /** The master key (`APP_SECRET`). */
  appSecret: string;
  now?: () => Date;
};

export function createSmtpConfigStore({
  db,
  appSecret,
  now = () => new Date(),
}: SmtpConfigStoreOptions): SmtpConfigStore {
  // The same stores on another connection: a transaction.
  const on = (connection: Kysely<Database>) => ({
    settings: createInstanceSettingsRepository(connection, now),
    secrets: createSecretStore({ db: connection, appSecret, now }),
  });

  async function stored(settings: InstanceSettingsRepository) {
    const row = await settings.getWithMeta("smtp");
    if (row === undefined) return null;
    const valid = readStoredSmtpSettings(row.value);
    return valid === null ? null : { ...row, value: valid };
  }

  return {
    async isSaved() {
      return (await stored(on(db).settings)) !== null;
    },

    async isConfigured() {
      const { settings, secrets } = on(db);
      const row = await stored(settings);
      if (row === null) return false;
      if (row.value.user === null) return true;
      return (await secrets.status(PASSWORD_SECRET)).state === "configured";
    },

    async view() {
      const { settings, secrets } = on(db);
      const row = await stored(settings);
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
      const { settings, secrets } = on(db);
      const row = await stored(settings);
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

      return db.transaction().execute(async (trx): Promise<SaveSmtpResult> => {
        const { settings, secrets } = on(trx);
        const refuse = (field: string, code: string): SaveSmtpResult => ({
          ok: false,
          error: "invalid_input",
          issues: [{ field, code }],
        });
        if (next.user === null && password.kind === "set")
          return refuse("password", "user_required");

        if (next.user !== null && password.kind === "keep") {
          // A login needs a password: entered now, or still stored and readable. (The explicit clear is
          // the admin's way to say that this server logs in without one.)
          const current = await secrets.status(PASSWORD_SECRET);
          if (current.state !== "configured")
            return refuse("password", "password_required");
          // And the stored one only for the server it was entered for.
          const before = await stored(settings);
          if (
            before === null ||
            before.value.host !== next.host ||
            before.value.port !== next.port ||
            before.value.user !== next.user ||
            before.value.security !== next.security
          )
            return refuse("password", "password_required_for_new_server");
        }

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
      });
    },

    async remove() {
      await db.transaction().execute(async (trx) => {
        const { settings, secrets } = on(trx);
        await settings.remove("smtp");
        await secrets.remove(PASSWORD_SECRET);
      });
    },
  };
}
