// SPDX-License-Identifier: Apache-2.0

// The billing settings the admin portal reads and changes (ADR 0005, 2.10; #437): the instance setting
// `billing_settings`, the two Paddle secrets in the secret store, the connection check, the creation of the notification
// destination and the switch. The Paddle client is injected, so a test points it at the fake and production at Paddle's
// address for the configured environment; this module opens no connection of its own.
//
// - The secrets are write-only: `view` says whether each is stored (and the last four characters of a long one),
//   nothing here returns a value, and nothing here logs one. A secret is read (`use`) only to call Paddle.
// - Everything is checked before anything is written: a refused change leaves the settings and the secrets as they were.
// - Switching on is checked then, not remembered: it makes the connection check itself, so a key that was rotated or
//   revoked since the last button press cannot be switched on.
// - While billing is on, the environment and the credentials stay (`billing_disable_first`): billing rows carry the
//   Paddle environment, and a removed credential would turn billing off without a word. A new API key is checked
//   against Paddle before it replaces the old one.
// - Two admins (two tabs) do not overwrite each other: every write of `billing_settings` is conditional on the row as
//   it was read (`setIfUnchanged`), and the secrets change only after that write went through. A request that finds
//   the settings changed in between writes nothing and answers `billing_settings_changed`. Switching on enables
//   exactly the settings it checked; switching off retries, it always wins. A saved key or webhook secret that
//   arrives after the switch was turned on in the instant between the two writes is not checked again (the page
//   offers the connection check at any time).
// - The environment is one for every credential: the API key and the client token are checked against it, and the
//   webhook secret and the notification destination belong to it, so a switch of the environment forgets the stored
//   webhook secret unless a new one comes with the switch. A stored key that cannot be read does not let the switch
//   through (nothing says which environment it belongs to).
// - The notification destination is created at most once for the address of this app: a lease (`claim`) serializes
//   the creations, and Paddle is asked first (the list carries each destination's secret, so one that exists is
//   adopted). A destination that exists with no secret to adopt is refused, with a stable code that says to delete
//   it at Paddle or to recreate. Recreating replaces the destination and the secret. When Paddle created the
//   destination but its secret was not stored, the answer names the destination and a retry adopts it.
import "server-only";
import type { Kysely } from "kysely";
import type {
  BillingEnvironment,
  BillingSecretView,
  BillingView,
} from "../admin/ui/billing-view.ts";
import { formatTimestamp } from "../db/codecs.ts";
import {
  createInstanceSettingsRepository,
  type InstanceSettingWithMeta,
} from "../db/repositories/instance-settings-repository.ts";
import { createOwnKeyCountRepository } from "../db/repositories/own-key-count-repository.ts";
import type { Database } from "../db/schema.ts";
import type { SecretStatus, SecretStore } from "../secrets/store.ts";
import type {
  BillingCheckErrorCode,
  BillingMissingItem,
} from "./admin-errors.ts";
import { PaddleClientError, type PaddleClient } from "./paddle-client.ts";
import { isPublicHttpsUrl } from "./public-url.ts";
import {
  clientTokenEnvironmentOf,
  keyEnvironmentOf,
  parseSettingsInput,
  readBillingSettings,
  type BillingIssue,
  type BillingSettings,
} from "./settings.ts";
import {
  BILLING_WEBHOOK_PATH,
  PADDLE_WEBHOOK_EVENTS,
} from "./webhook-events.ts";

export type BillingSettingsServiceOptions = {
  db: Kysely<Database>;
  secrets: SecretStore;
  /** A client of Paddle for this key and environment. May throw a `PaddleClientError` (a key of the wrong environment). */
  clientFor: (apiKey: string, environment: BillingEnvironment) => PaddleClient;
  /** The public address of this app (`BETTER_AUTH_URL`): where Paddle is told to post its events. Never from a request. */
  publicUrl: string;
};

export type BillingFailure =
  | { ok: false; error: "invalid_input"; issues: BillingIssue[] }
  | { ok: false; error: "billing_environment_mismatch" }
  | { ok: false; error: "billing_disable_first" }
  | { ok: false; error: "billing_incomplete"; missing: BillingMissingItem[] }
  | { ok: false; error: "webhook_secret_exists" }
  | { ok: false; error: "billing_settings_changed" }
  | { ok: false; error: "webhook_url_not_public" }
  | { ok: false; error: "webhook_destination_exists" }
  | { ok: false; error: "webhook_destination_in_progress" }
  | {
      ok: false;
      error: "webhook_secret_not_stored";
      /** The destination Paddle created; a new try adopts it. */
      destinationId: string;
    }
  | { ok: false; error: BillingCheckErrorCode };
export type BillingResult = { ok: true } | BillingFailure;
export type ConnectionCheck =
  { ok: true } | { ok: false; error: BillingCheckErrorCode };

export type BillingSettingsService = {
  view(): Promise<BillingView>;
  /** Saves the settings and, when given, the API key and the webhook secret (an empty field keeps the stored one). */
  saveSettings(adminId: string, input: unknown): Promise<BillingResult>;
  /** Forgets a stored credential; refused while billing is on. */
  removeSecret(adminId: string, which: unknown): Promise<BillingResult>;
  /** A harmless call to Paddle with the stored key. */
  checkConnection(): Promise<ConnectionCheck>;
  /**
   * Makes sure the notification destination exists at Paddle and its secret is stored: creates it, or adopts the one
   * that exists for this app's address. `recreate` replaces the destination and the secret (billing off).
   */
  createNotificationDestination(
    adminId: string,
    options?: { recreate?: boolean },
  ): Promise<BillingResult>;
  /** Switches billing on (after the checks) or off. */
  setEnabled(adminId: string, enabled: unknown): Promise<BillingResult>;
};

/** How long one creation of the destination may hold the lease: a few calls to Paddle with a time limit each. */
const DESTINATION_LEASE_MS = 60_000;
/** Attempts of the switch-off to write against a settings row that keeps changing. */
const SWITCH_OFF_ATTEMPTS = 3;

const SECRET_FIELDS = {
  apiKey: "paddle_api_key",
  webhookSecret: "paddle_webhook_secret",
} as const;

function secretView(status: SecretStatus): BillingSecretView {
  if (status.state === "not_configured") return { state: "not_configured" };
  if (status.state === "undecryptable") return { state: "unreadable" };
  return { state: "configured", lastFour: status.lastFour };
}

/** What Paddle's refusal means for the admin. Only the code of the error is read, never its text. */
function checkErrorOf(error: unknown): BillingCheckErrorCode {
  if (!(error instanceof PaddleClientError)) throw error;
  switch (error.code) {
    case "unauthorized":
    case "forbidden":
    case "environment_mismatch":
      return "paddle_key_rejected";
    case "rate_limited":
      return "paddle_rate_limited";
    case "timeout":
    case "network_error":
      return "paddle_unreachable";
    default:
      return "paddle_unavailable";
  }
}

export function createBillingSettingsService({
  db,
  secrets,
  clientFor,
  publicUrl,
}: BillingSettingsServiceOptions): BillingSettingsService {
  const settingsRepository = createInstanceSettingsRepository(db);
  const ownKeys = createOwnKeyCountRepository(db);

  type Stored = InstanceSettingWithMeta<"billing_settings"> | undefined;

  /** The settings and the row they came from: what a later write is conditional on. */
  async function readCurrent(): Promise<{
    settings: BillingSettings;
    stored: Stored;
  }> {
    const stored = await settingsRepository.getWithMeta("billing_settings");
    return { settings: readBillingSettings(stored?.value), stored };
  }

  /** Writes only if the row is still as it was read. */
  function writeIfUnchanged(
    adminId: string,
    stored: Stored,
    settings: BillingSettings,
  ): Promise<boolean> {
    return settingsRepository.setIfUnchanged(
      "billing_settings",
      stored,
      settings,
      adminId,
    );
  }

  const CHANGED = {
    ok: false,
    error: "billing_settings_changed",
  } as const satisfies BillingFailure;

  type MadeClient =
    | { ok: true; client: PaddleClient }
    | { ok: false; error: BillingCheckErrorCode };

  function clientOf(key: string, environment: BillingEnvironment): MadeClient {
    try {
      return { ok: true, client: clientFor(key, environment) };
    } catch (error) {
      return { ok: false, error: checkErrorOf(error) };
    }
  }

  /** A client for the stored key, or the reason there is none. The key does not leave this function but in the client. */
  async function storedClient(
    environment: BillingEnvironment,
  ): Promise<MadeClient> {
    const key = await secrets.use("paddle_api_key");
    if (!key.ok)
      return {
        ok: false,
        error:
          key.error === "secret_not_configured"
            ? "api_key_missing"
            : "api_key_unreadable",
      };
    return clientOf(key.value.reveal(), environment);
  }

  async function checkWith(made: MadeClient): Promise<ConnectionCheck> {
    if (!made.ok) return made;
    try {
      // The least a key can do: read one product.
      await made.client.listProducts({ per_page: 1 });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: checkErrorOf(error) };
    }
  }

  function connectionCheck(
    environment: BillingEnvironment,
  ): Promise<ConnectionCheck> {
    return storedClient(environment).then(checkWith);
  }

  const webhookUrl = `${publicUrl.replace(/\/+$/, "")}${BILLING_WEBHOOK_PATH}`;

  /** The destination is stored (or reported) after Paddle has one: the secret goes in, or the destination is named. */
  async function storeDestinationSecret(
    adminId: string,
    destinationId: string,
    secret: string | undefined,
  ): Promise<BillingResult> {
    try {
      // An empty secret is no secret: `save` refuses it.
      const saved = await secrets.save("paddle_webhook_secret", secret ?? "", {
        updatedBy: adminId,
        showLastFour: true,
      });
      if (saved.ok) return { ok: true };
    } catch {
      // Whatever the store said is dropped: it could carry the value.
    }
    console.error(
      `[billing] BILLING_DESTINATION_SECRET_NOT_STORED: the notification destination ${destinationId} exists at Paddle and its secret was not stored; creating the destination again adopts it.`,
    );
    return {
      ok: false,
      error: "webhook_secret_not_stored",
      destinationId,
    };
  }

  /** The body of a creation, with the lease held. */
  async function makeDestination(
    adminId: string,
    environment: BillingEnvironment,
    recreate: boolean,
  ): Promise<BillingResult> {
    const made = await storedClient(environment);
    if (!made.ok) return made;
    const { client } = made;
    try {
      const ours = (await client.listNotificationSettings()).filter(
        ({ destination }) => destination.replace(/\/+$/, "") === webhookUrl,
      );
      if (recreate) {
        for (const setting of ours)
          await client.deleteNotificationSetting(setting.id);
        // The old secret signs nothing any more; with the new one lost it must not look like a working one.
        await secrets.remove("paddle_webhook_secret");
      } else if (ours.length > 0) {
        const [only] = ours;
        // More than one cannot be told apart, and one without a secret cannot be verified against.
        if (ours.length > 1 || only === undefined)
          return { ok: false, error: "webhook_destination_exists" };
        const secret = only.endpoint_secret_key;
        if (secret === undefined || secret === "")
          return { ok: false, error: "webhook_destination_exists" };
        return storeDestinationSecret(adminId, only.id, secret);
      }
      const created = await client.createNotificationSetting({
        description: "Code Reviewer",
        destination: webhookUrl,
        subscribed_events: [...PADDLE_WEBHOOK_EVENTS],
      });
      return storeDestinationSecret(
        adminId,
        created.id,
        created.endpoint_secret_key,
      );
    } catch (error) {
      return { ok: false, error: checkErrorOf(error) };
    }
  }

  return {
    async view() {
      const stored = await settingsRepository.getWithMeta("billing_settings");
      const settings = readBillingSettings(stored?.value);
      const [apiKey, webhookSecret, ownKeyWorkspaces] = await Promise.all([
        secrets.status("paddle_api_key"),
        secrets.status("paddle_webhook_secret"),
        ownKeys.countWorkspacesWithStoredOwnKey(),
      ]);
      return {
        ...settings,
        apiKey: secretView(apiKey),
        webhookSecret: secretView(webhookSecret),
        ownKeyWorkspaces,
        updatedAt: stored?.updatedAt ?? null,
      };
    },

    async saveSettings(adminId, input) {
      const parsed = parseSettingsInput(input);
      if (!parsed.ok)
        return { ok: false, error: "invalid_input", issues: parsed.issues };
      const { environment, clientToken, graceDays, apiKey, webhookSecret } =
        parsed.value;
      const { settings: current, stored } = await readCurrent();
      const environmentChanges = environment !== current.environment;

      if (current.enabled) {
        if (environmentChanges)
          return { ok: false, error: "billing_disable_first" };
        if (clientToken === "")
          return {
            ok: false,
            error: "invalid_input",
            issues: [{ field: "clientToken", code: "client_token_required" }],
          };
      }

      // The key that will be in force: the new one, or the stored one. It has to belong to the environment.
      let keyEnvironment: BillingEnvironment | null;
      if (apiKey !== undefined) {
        keyEnvironment = keyEnvironmentOf(apiKey);
        if (keyEnvironment === null)
          return {
            ok: false,
            error: "invalid_input",
            issues: [{ field: "apiKey", code: "api_key_invalid" }],
          };
      } else {
        const kept = await secrets.use("paddle_api_key");
        // A key that cannot be read is replaced by entering a new one. It is no reason to refuse the rest, but it
        // cannot vouch for a switch of the environment: nothing says which one it belongs to.
        if (
          !kept.ok &&
          kept.error !== "secret_not_configured" &&
          environmentChanges
        )
          return { ok: false, error: "api_key_unreadable" };
        keyEnvironment = kept.ok ? keyEnvironmentOf(kept.value.reveal()) : null;
      }
      if (keyEnvironment !== null && keyEnvironment !== environment)
        return { ok: false, error: "billing_environment_mismatch" };

      // Billing is on: the new key has to work before it replaces the one that does.
      if (current.enabled && apiKey !== undefined) {
        const check = await checkWith(clientOf(apiKey, environment));
        if (!check.ok) return check;
      }

      // The webhook secret of the other environment goes before anything else is written: if the write below is then
      // refused, the secret is missing (switching on is refused) and not a secret that no destination of this
      // environment can have signed.
      if (environmentChanges && webhookSecret === undefined)
        await secrets.remove("paddle_webhook_secret");

      const written = await writeIfUnchanged(adminId, stored, {
        environment,
        clientToken,
        graceDays,
        enabled: current.enabled,
      });
      if (!written) return CHANGED;

      const writer = { updatedBy: adminId, showLastFour: true };
      if (apiKey !== undefined)
        await secrets.save("paddle_api_key", apiKey, writer);
      if (webhookSecret !== undefined)
        await secrets.save("paddle_webhook_secret", webhookSecret, writer);
      return { ok: true };
    },

    async removeSecret(adminId, which) {
      if (which !== "apiKey" && which !== "webhookSecret")
        return {
          ok: false,
          error: "invalid_input",
          issues: [{ field: "removeSecret", code: "body_invalid" }],
        };
      const { settings, stored } = await readCurrent();
      if (settings.enabled)
        return { ok: false, error: "billing_disable_first" };
      // Touching the settings row makes a switch-on that checked the secret before it went find the row changed.
      if (
        stored !== undefined &&
        !(await writeIfUnchanged(adminId, stored, settings))
      )
        return CHANGED;
      await secrets.remove(SECRET_FIELDS[which]);
      return { ok: true };
    },

    async checkConnection() {
      return connectionCheck((await readCurrent()).settings.environment);
    },

    async createNotificationDestination(adminId, options = {}) {
      const recreate = options.recreate === true;
      const { settings } = await readCurrent();
      if (!isPublicHttpsUrl(publicUrl))
        return { ok: false, error: "webhook_url_not_public" };
      if (
        !recreate &&
        (await secrets.status("paddle_webhook_secret")).state === "configured"
      )
        return { ok: false, error: "webhook_secret_exists" };
      if (settings.enabled)
        return { ok: false, error: "billing_disable_first" };
      const key = await secrets.status("paddle_api_key");
      if (key.state === "not_configured")
        return { ok: false, error: "api_key_missing" };
      if (key.state === "undecryptable")
        return { ok: false, error: "api_key_unreadable" };

      const claimed = await settingsRepository.claim(
        "billing_destination_lock",
        { startedAt: formatTimestamp(new Date()) },
        adminId,
        formatTimestamp(new Date(Date.now() - DESTINATION_LEASE_MS)),
      );
      if (!claimed)
        return { ok: false, error: "webhook_destination_in_progress" };
      try {
        return await makeDestination(adminId, settings.environment, recreate);
      } finally {
        await settingsRepository.remove("billing_destination_lock");
      }
    },

    async setEnabled(adminId, enabled) {
      if (typeof enabled !== "boolean")
        return {
          ok: false,
          error: "invalid_input",
          issues: [{ field: "enabled", code: "body_invalid" }],
        };
      if (!enabled) {
        // Switching off always wins: a change in between is read again, a few times.
        for (let attempt = 0; attempt < SWITCH_OFF_ATTEMPTS; attempt += 1) {
          const { settings, stored } = await readCurrent();
          // Never configured and never on: nothing to write.
          if (!settings.enabled) return { ok: true };
          if (
            await writeIfUnchanged(adminId, stored, {
              ...settings,
              enabled: false,
            })
          )
            return { ok: true };
        }
        return CHANGED;
      }
      const { settings, stored } = await readCurrent();
      const missing: BillingMissingItem[] = [];
      const key = await secrets.use("paddle_api_key");
      if (!key.ok) missing.push("api_key_missing");
      if (
        (await secrets.status("paddle_webhook_secret")).state !== "configured"
      )
        missing.push("webhook_secret_missing");
      if (settings.clientToken === "") missing.push("client_token_missing");
      // Everything stored has to belong to the environment of the settings.
      if (
        key.ok &&
        keyEnvironmentOf(key.value.reveal()) !== settings.environment
      )
        return { ok: false, error: "billing_environment_mismatch" };
      if (
        settings.clientToken !== "" &&
        clientTokenEnvironmentOf(settings.clientToken) !== settings.environment
      )
        return { ok: false, error: "billing_environment_mismatch" };
      if (key.ok && !(await connectionCheck(settings.environment)).ok)
        missing.push("connection_check_failed");
      if (missing.length > 0)
        return { ok: false, error: "billing_incomplete", missing };
      // Exactly the settings that were checked, or nothing.
      if (
        !(await writeIfUnchanged(adminId, stored, {
          ...settings,
          enabled: true,
        }))
      )
        return CHANGED;
      return { ok: true };
    },
  };
}
