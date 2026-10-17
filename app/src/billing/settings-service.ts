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
//   Paddle environment, and a removed credential would turn billing off without a word.
import "server-only";
import type { Kysely } from "kysely";
import type {
  BillingEnvironment,
  BillingSecretView,
  BillingView,
} from "../admin/ui/billing-view.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createOwnKeyCountRepository } from "../db/repositories/own-key-count-repository.ts";
import type { Database } from "../db/schema.ts";
import type { SecretStatus, SecretStore } from "../secrets/store.ts";
import type {
  BillingCheckErrorCode,
  BillingMissingItem,
} from "./admin-errors.ts";
import { PaddleClientError, type PaddleClient } from "./paddle-client.ts";
import {
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
  | { ok: false; error: BillingCheckErrorCode };
export type BillingResult = { ok: true } | BillingFailure;
export type ConnectionCheck =
  { ok: true } | { ok: false; error: BillingCheckErrorCode };

export type BillingSettingsService = {
  view(): Promise<BillingView>;
  /** Saves the settings and, when given, the API key and the webhook secret (an empty field keeps the stored one). */
  saveSettings(adminId: string, input: unknown): Promise<BillingResult>;
  /** Forgets a stored credential; refused while billing is on. */
  removeSecret(which: unknown): Promise<BillingResult>;
  /** A harmless call to Paddle with the stored key. */
  checkConnection(): Promise<ConnectionCheck>;
  /** Creates the notification destination at Paddle and stores the secret it returns. */
  createNotificationDestination(adminId: string): Promise<BillingResult>;
  /** Switches billing on (after the checks) or off. */
  setEnabled(adminId: string, enabled: unknown): Promise<BillingResult>;
};

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

  async function currentSettings(): Promise<BillingSettings> {
    return readBillingSettings(
      await settingsRepository.get("billing_settings"),
    );
  }

  /** A client for the stored key, or the reason there is none. The key does not leave this function but in the client. */
  async function storedClient(
    environment: BillingEnvironment,
  ): Promise<
    | { ok: true; client: PaddleClient }
    | { ok: false; error: BillingCheckErrorCode }
  > {
    const key = await secrets.use("paddle_api_key");
    if (!key.ok)
      return {
        ok: false,
        error:
          key.error === "secret_not_configured"
            ? "api_key_missing"
            : "api_key_unreadable",
      };
    try {
      return { ok: true, client: clientFor(key.value.reveal(), environment) };
    } catch (error) {
      return { ok: false, error: checkErrorOf(error) };
    }
  }

  async function connectionCheck(
    environment: BillingEnvironment,
  ): Promise<ConnectionCheck> {
    const made = await storedClient(environment);
    if (!made.ok) return made;
    try {
      // The least a key can do: read one product.
      await made.client.listProducts({ per_page: 1 });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: checkErrorOf(error) };
    }
  }

  async function writeSettings(
    adminId: string,
    settings: BillingSettings,
  ): Promise<void> {
    await settingsRepository.set("billing_settings", settings, adminId);
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
      const current = await currentSettings();

      if (current.enabled) {
        if (environment !== current.environment)
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
        const stored = await secrets.use("paddle_api_key");
        // A key that cannot be read is replaced by entering a new one; it is no reason to refuse the rest.
        keyEnvironment = stored.ok
          ? keyEnvironmentOf(stored.value.reveal())
          : null;
      }
      if (keyEnvironment !== null && keyEnvironment !== environment)
        return { ok: false, error: "billing_environment_mismatch" };

      const writer = { updatedBy: adminId, showLastFour: true };
      if (apiKey !== undefined)
        await secrets.save("paddle_api_key", apiKey, writer);
      if (webhookSecret !== undefined)
        await secrets.save("paddle_webhook_secret", webhookSecret, writer);
      await writeSettings(adminId, {
        environment,
        clientToken,
        graceDays,
        enabled: current.enabled,
      });
      return { ok: true };
    },

    async removeSecret(which) {
      if (which !== "apiKey" && which !== "webhookSecret")
        return {
          ok: false,
          error: "invalid_input",
          issues: [{ field: "removeSecret", code: "body_invalid" }],
        };
      if ((await currentSettings()).enabled)
        return { ok: false, error: "billing_disable_first" };
      await secrets.remove(SECRET_FIELDS[which]);
      return { ok: true };
    },

    async checkConnection() {
      return connectionCheck((await currentSettings()).environment);
    },

    async createNotificationDestination(adminId) {
      const settings = await currentSettings();
      if (
        (await secrets.status("paddle_webhook_secret")).state === "configured"
      )
        return { ok: false, error: "webhook_secret_exists" };
      const made = await storedClient(settings.environment);
      if (!made.ok) return made;
      try {
        const created = await made.client.createNotificationSetting({
          description: "Code Reviewer",
          destination: `${publicUrl.replace(/\/+$/, "")}${BILLING_WEBHOOK_PATH}`,
          subscribed_events: [...PADDLE_WEBHOOK_EVENTS],
        });
        const saved = await secrets.save(
          "paddle_webhook_secret",
          created.endpoint_secret_key,
          { updatedBy: adminId, showLastFour: true },
        );
        // An empty secret from Paddle is no secret: say Paddle failed rather than store nothing.
        if (!saved.ok) return { ok: false, error: "paddle_unavailable" };
        return { ok: true };
      } catch (error) {
        return { ok: false, error: checkErrorOf(error) };
      }
    },

    async setEnabled(adminId, enabled) {
      if (typeof enabled !== "boolean")
        return {
          ok: false,
          error: "invalid_input",
          issues: [{ field: "enabled", code: "body_invalid" }],
        };
      const settings = await currentSettings();
      if (!enabled) {
        // Never configured and never on: nothing to write.
        if (settings.enabled)
          await writeSettings(adminId, { ...settings, enabled: false });
        return { ok: true };
      }
      const missing: BillingMissingItem[] = [];
      const key = await secrets.use("paddle_api_key");
      if (!key.ok) missing.push("api_key_missing");
      if (
        (await secrets.status("paddle_webhook_secret")).state !== "configured"
      )
        missing.push("webhook_secret_missing");
      if (settings.clientToken === "") missing.push("client_token_missing");
      if (key.ok && !(await connectionCheck(settings.environment)).ok)
        missing.push("connection_check_failed");
      if (missing.length > 0)
        return { ok: false, error: "billing_incomplete", missing };
      await writeSettings(adminId, { ...settings, enabled: true });
      return { ok: true };
    },
  };
}
