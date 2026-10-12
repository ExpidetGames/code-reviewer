// SPDX-License-Identifier: Apache-2.0

// The credentials of the instance's GitHub App (docs/decisions/0001-editions-setup-and-accounts.md,
// sections 2.4, 2.7 and 2.10): the one place that reads and writes them, and so the one loader that
// replaces every read of the `GITHUB_APP_*` variables.
//
// - The database comes first: the settings in `instance_settings` (key `github_app`) and the private key,
//   the webhook secret and the client secret in the encrypted secret store. There is no environment fallback:
//   the `GITHUB_APP_*` variables of an installation from before accounts were imported once
//   (src/legacy-import/) and are not read; the OAuth app's `GITHUB_OAUTH_*` variables never were.
// - Nothing is remembered between calls: every `load` reads the database, so a webhook secret or a key the
//   admin replaced counts from the next request on every app instance.
// - Saving writes the secrets and the settings in one transaction. A secret is write-only: what leaves
//   this module is its status, and the value only goes to code on the server inside a `SecretValue`.
import type { Kysely } from "kysely";
import {
  GithubAppConfigError,
  loadGithubAppConfig,
  type GithubAppConfig,
} from "../integrations/registry.ts";
import {
  createInstanceSettingsRepository,
  type InstanceSettingsRepository,
} from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import type { SecretValue } from "../secrets/secret-value.ts";
import {
  createSecretStore,
  type SecretStatus,
  type SecretStore,
} from "../secrets/store.ts";
import type { SecretName } from "../secrets/names.ts";
import { readStoredGithubApp, type StoredGithubApp } from "./settings.ts";

export const PRIVATE_KEY_SECRET = "github_app_private_key" as const;
export const WEBHOOK_SECRET = "github_app_webhook_secret" as const;
export const CLIENT_SECRET = "github_app_client_secret" as const;

type Env = Readonly<Record<string, string | undefined>>;

/** What is wrong with the App's credentials: field or variable names only, never a value. */
export type GithubConfigProblem = {
  /** `missing`: something is not set. `invalid`: it is set but not usable. */
  kind: "missing" | "invalid";
  fields: string[];
};

export type GithubAppState =
  { ok: true; config: GithubAppConfig } | ({ ok: false } & GithubConfigProblem);

export type UserAuthorizationState =
  | { state: "none" }
  /** A client id is saved and its secret is missing or cannot be decrypted. */
  | { state: "unreadable"; clientId: string }
  | { state: "configured"; clientId: string; clientSecret: SecretValue };

export type GithubSnapshot = {
  /** Where the settings came from. `none`: nothing is configured. */
  source: "database" | "none";
  /** The stored non-secret settings; null for nothing. */
  stored: StoredGithubApp | null;
  /** The slug when it is known and well formed, for the install link; otherwise null. */
  slug: string | null;
  /** The App for reviews: usable, or what is wrong. */
  app: GithubAppState;
  /** The user authorization (the sign in with GitHub). Never read from the environment. */
  userAuthorization: UserAuthorizationState;
  /** Who saved the settings last and when (database only). */
  updatedBy: string | null;
  updatedAt: string | null;
};

export type GithubSecretStates = {
  privateKey: SecretStatus;
  webhookSecret: SecretStatus;
  clientSecret: SecretStatus;
};

/** What to do with the client secret when the App is saved. */
export type ClientSecretWrite =
  { kind: "keep" } | { kind: "set"; value: string } | { kind: "remove" };

export type PersistAppInput = {
  actorId: string | null;
  stored: StoredGithubApp;
  /** Null: keep the stored one. */
  privateKey: string | null;
  /** Null: keep the stored one. */
  webhookSecret: string | null;
  clientSecret: ClientSecretWrite;
};

export type GithubCredentialStore = {
  /** The credentials as the server uses them. Reads the database every time. */
  load(): Promise<GithubSnapshot>;
  /** The status of the three secrets (never a value). */
  secretStates(): Promise<GithubSecretStates>;
  /** Saves the settings and the secrets in one transaction. */
  persistApp(input: PersistAppInput): Promise<void>;
  /** Saves the client id and secret of the user authorization in one transaction. */
  persistUserAuthorization(input: {
    actorId: string | null;
    clientId: string;
    clientSecret: string | null;
  }): Promise<void>;
  /** Records the admin's answer to "can the App only be installed on its own account?". */
  setPrivateApp(actorId: string | null, privateApp: boolean): Promise<boolean>;
};

export type GithubCredentialStoreOptions = {
  db: Kysely<Database>;
  /** The master key (`APP_SECRET`). */
  appSecret: string;
  /**
   * The process environment, for the test only address overrides (`GITHUB_API_BASE_URL`,
   * `ALLOW_TEST_GITHUB_ENDPOINTS`) and nothing else: the `GITHUB_APP_*` variables are never read. Default:
   * `process.env`.
   */
  env?: Env;
  now?: () => Date;
};

// The names the shared loader reports (it was written for the environment) in the words of this store.
const FIELD_OF_VARIABLE: Record<string, string> = {
  GITHUB_APP_ID: "app_id",
  GITHUB_APP_SLUG: "slug",
  GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY_SECRET,
  "GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_PATH)": PRIVATE_KEY_SECRET,
  GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

function problemFrom(error: GithubAppConfigError): GithubConfigProblem {
  return {
    kind: error.problem,
    fields: [
      ...new Set(
        error.variables.map((name) => FIELD_OF_VARIABLE[name] ?? name),
      ),
    ],
  };
}

export function createGithubCredentialStore({
  db,
  appSecret,
  env = process.env,
  now = () => new Date(),
}: GithubCredentialStoreOptions): GithubCredentialStore {
  // The same stores on another connection: a transaction.
  const on = (connection: Kysely<Database>) => ({
    settings: createInstanceSettingsRepository(connection, now),
    secrets: createSecretStore({ db: connection, appSecret, now }),
  });

  async function storedApp(settings: InstanceSettingsRepository) {
    const row = await settings.getWithMeta("github_app");
    if (row === undefined) return null;
    const valid = readStoredGithubApp(row.value);
    return valid === null ? null : { ...row, value: valid };
  }

  async function userAuthorizationOf(
    stored: StoredGithubApp,
    secrets: SecretStore,
  ): Promise<UserAuthorizationState> {
    if (stored.clientId === null) return { state: "none" };
    const used = await secrets.use(CLIENT_SECRET);
    return used.ok
      ? {
          state: "configured",
          clientId: stored.clientId,
          clientSecret: used.value,
        }
      : { state: "unreadable", clientId: stored.clientId };
  }

  async function loadFromDatabase(
    stored: StoredGithubApp,
    secrets: SecretStore,
  ): Promise<GithubAppState> {
    const [key, hook] = await Promise.all([
      secrets.use(PRIVATE_KEY_SECRET),
      secrets.use(WEBHOOK_SECRET),
    ]);
    const missing: string[] = [];
    const invalid: string[] = [];
    for (const [name, used] of [
      [PRIVATE_KEY_SECRET, key],
      [WEBHOOK_SECRET, hook],
    ] as const)
      if (!used.ok)
        (used.error === "secret_not_configured" ? missing : invalid).push(name);
    if (!key.ok || !hook.ok) {
      return invalid.length > 0
        ? { ok: false, kind: "invalid", fields: invalid }
        : { ok: false, kind: "missing", fields: missing };
    }
    try {
      // The shared loader, fed from the database. The address overrides of the test stack stay in the
      // environment.
      return {
        ok: true,
        config: loadGithubAppConfig({
          GITHUB_APP_ID: stored.appId,
          GITHUB_APP_SLUG: stored.slug,
          GITHUB_APP_PRIVATE_KEY: key.value.reveal(),
          GITHUB_APP_WEBHOOK_SECRET: hook.value.reveal(),
          GITHUB_API_BASE_URL: env.GITHUB_API_BASE_URL,
          ALLOW_TEST_GITHUB_ENDPOINTS: env.ALLOW_TEST_GITHUB_ENDPOINTS,
        }),
      };
    } catch (error) {
      if (!(error instanceof GithubAppConfigError)) throw error;
      return { ok: false, ...problemFrom(error) };
    }
  }

  return {
    async load() {
      const { settings, secrets } = on(db);
      const row = await storedApp(settings);
      if (row !== null)
        return {
          source: "database",
          stored: row.value,
          slug: row.value.slug,
          app: await loadFromDatabase(row.value, secrets),
          userAuthorization: await userAuthorizationOf(row.value, secrets),
          updatedBy: row.updatedBy,
          updatedAt: row.updatedAt,
        };
      return {
        source: "none",
        stored: null,
        slug: null,
        app: { ok: false, kind: "missing", fields: [] },
        userAuthorization: { state: "none" },
        updatedBy: null,
        updatedAt: null,
      };
    },

    async secretStates() {
      const { secrets } = on(db);
      const [privateKey, webhookSecret, clientSecret] = await Promise.all(
        [PRIVATE_KEY_SECRET, WEBHOOK_SECRET, CLIENT_SECRET].map(
          (name: SecretName) => secrets.status(name),
        ),
      );
      return {
        privateKey: privateKey as SecretStatus,
        webhookSecret: webhookSecret as SecretStatus,
        clientSecret: clientSecret as SecretStatus,
      };
    },

    async persistApp({
      actorId,
      stored,
      privateKey,
      webhookSecret,
      clientSecret,
    }) {
      await db.transaction().execute(async (trx) => {
        const { settings, secrets } = on(trx);
        const save = async (name: SecretName, value: string) => {
          const saved = await secrets.save(name, value, {
            updatedBy: actorId,
          });
          // The input was validated before; an empty or oversized value here is a bug, and it must not
          // leave a half saved App behind.
          if (!saved.ok) throw new Error(`The secret ${name} was refused.`);
        };
        if (privateKey !== null) await save(PRIVATE_KEY_SECRET, privateKey);
        if (webhookSecret !== null) await save(WEBHOOK_SECRET, webhookSecret);
        if (clientSecret.kind === "set")
          await save(CLIENT_SECRET, clientSecret.value);
        if (clientSecret.kind === "remove" || stored.clientId === null)
          await secrets.remove(CLIENT_SECRET);
        await settings.set("github_app", stored, actorId);
      });
    },

    async persistUserAuthorization({ actorId, clientId, clientSecret }) {
      await db.transaction().execute(async (trx) => {
        const { settings, secrets } = on(trx);
        const current = await storedApp(settings);
        if (current === null)
          throw new Error("There is no stored GitHub App to add it to.");
        if (clientSecret !== null) {
          const saved = await secrets.save(CLIENT_SECRET, clientSecret, {
            updatedBy: actorId,
          });
          if (!saved.ok) throw new Error("The client secret was refused.");
        }
        await settings.set(
          "github_app",
          { ...current.value, clientId },
          actorId,
        );
      });
    },

    async setPrivateApp(actorId, privateApp) {
      const { settings } = on(db);
      const current = await storedApp(settings);
      if (current === null) return false;
      await settings.set(
        "github_app",
        { ...current.value, privateApp },
        actorId,
      );
      return true;
    },
  };
}
