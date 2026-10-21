// SPDX-License-Identifier: Apache-2.0

// The billing settings the admin portal reads and changes (ADR 0006, 2.14; #504): the adapter, the Stripe credentials (the two
// secrets of the secret store), the rates and the numbers, the connection check, the webhook endpoint at Stripe and the switch.
// The Stripe client is injected, so a test points it at the fake and production at Stripe's own address; this
// module opens no connection of its own and calls nobody until the admin asks.
//
// - The secrets are write-only: `view` says whether each is stored (and the last four characters of a long one), nothing here
//   returns a value, and nothing here logs one. A secret is read (`use`) only to call Stripe or to read the environment of the
//   key from its prefix.
// - Everything is checked before anything is written: a refused change leaves the settings and the secrets as they were.
// - The switch is one transaction under the lock of the billing settings: the rates, the adapter and the credentials that make
//   billing ready are read again in it (the secret store on that transaction), and a credential is saved or removed in the same
//   kind of transaction, so a rate write or a removed credential cannot slip in between the check and the write. Switching on also makes the connection check itself, so a key that was rotated or revoked since the button was
//   pressed cannot be switched on. Switching off is always allowed and writes nothing else: the journal is not touched.
// - A connection check that passes is recorded in the setting (when and for which environment); that record is what the
//   switch reader asks (`isBillingOn`), because it may not call Stripe. A new API key clears it; a check that fails never
//   clears it (a click during a Stripe outage must not turn billing off).
// - While billing is on, the adapter and the credentials stay (`billing_disable_first`): a removed credential would turn
//   billing off without a word. A new API key is checked against Stripe before it replaces the old one, and it must be one of
//   the same environment (the other one would take the webhook secret and the endpoint with it).
// - The webhook endpoint is created at most once at a time (a short lease), and Stripe is asked first: an endpoint of this
//   app's address that exists is adopted, never duplicated, if it is enabled and sends every event billing handles. Stripe
//   shows the signing secret only when it creates the endpoint, so adopting is possible when the secret is stored; otherwise
//   the admin enters the secret or recreates the endpoint (billing off). The environment of the endpoint (its `livemode`) must be the one of the API key.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../db/codecs.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { isBillingOn } from "./enabled.ts";
import { releaseStrandedHolds } from "./stranded-holds.ts";
import { createOwnKeyCountRepository } from "../db/repositories/own-key-count-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import type {
  BillingAdapterChoice,
  BillingSecretView,
  BillingView,
} from "../admin/ui/billing-view.ts";
import type { SecretStatus, SecretStore } from "../secrets/store.ts";
import type {
  BillingCheckErrorCode,
  BillingIssueCode,
  BillingNotReadyItem,
} from "./admin-errors.ts";
import { isPublicHttpsUrl, normalizedAddress } from "./public-url.ts";
import {
  billingNumbersOf,
  validateRatesPatch,
  type BillingRateErrorCode,
} from "./rates.ts";
import { createBillingRatesService } from "./rates-service.ts";
import {
  canSwitchBillingOnWithDispatcher,
  DISPATCHER_LACKS_VM_LIFECYCLE,
  readStoredDispatcherSightings,
} from "./dispatcher-features.ts";
import { missingItemsOf, STRIPE_ADAPTER_ID } from "./readiness.ts";
import {
  DEFAULT_ADAPTER_ID,
  type BillingSettings,
  type StoredStripeState,
} from "./settings.ts";
import { createBillingSettingsStore } from "./settings-store.ts";
import {
  stripeKeyEnvironment,
  StripeClientError,
  type StripeClient,
  type StripeEnvironment,
} from "./stripe-client.ts";
import type { StripeWebhookEndpoint } from "./stripe-schemas.ts";
import {
  BILLING_WEBHOOK_PATH,
  STRIPE_WEBHOOK_EVENTS,
} from "./stripe-webhook-events.ts";

export type BillingAdminServiceOptions = {
  db: Kysely<Database>;
  /**
   * The secret store on an executor: the database for a plain look, the transaction of a change of the settings for a
   * credential that must be read or written together with them.
   */
  secretsOn: (executor: Kysely<Database>) => SecretStore;
  /** A client of Stripe for this key and environment. May throw a `StripeClientError` (a key of the wrong environment). */
  clientFor: (apiKey: string, environment: StripeEnvironment) => StripeClient;
  /** The public address of this app (`BETTER_AUTH_URL`): where Stripe is told to post its events. Never from a request. */
  publicUrl: string;
  now?: () => Date;
  /** One line per change of the switch or the endpoint; never a value of a credential. Default: the console. */
  log?: (line: string) => void;
};

export type BillingIssue = { field: string; code: BillingIssueCode };

export type BillingFailure =
  | { ok: false; error: "invalid_input"; issues: BillingIssue[] }
  | { ok: false; error: "billing_disable_first" }
  | { ok: false; error: "billing_not_ready"; missing: BillingNotReadyItem[] }
  | { ok: false; error: "webhook_environment_mismatch" }
  | { ok: false; error: "webhook_url_not_public" }
  | { ok: false; error: "webhook_endpoint_secret_unknown" }
  | { ok: false; error: "webhook_endpoint_unusable" }
  | { ok: false; error: "webhook_endpoint_in_progress" }
  | { ok: false; error: "webhook_secret_not_stored" }
  | { ok: false; error: "webhook_secret_not_returned" }
  | { ok: false; error: BillingCheckErrorCode };
export type BillingResult = { ok: true } | BillingFailure;
export type ConnectionCheck =
  | { ok: true; environment: StripeEnvironment }
  | { ok: false; error: BillingCheckErrorCode };
export type EndpointResult =
  { ok: true; created: boolean; endpointId: string } | BillingFailure;

export type BillingAdminService = {
  view(): Promise<BillingView>;
  /** Chooses the adapter; refused while billing is on. */
  chooseAdapter(adminId: string, adapter: unknown): Promise<BillingResult>;
  /** Saves the API key and/or the webhook secret (an empty field keeps the stored one). */
  saveCredentials(adminId: string, input: unknown): Promise<BillingResult>;
  /** Forgets a stored credential; refused while billing is on. */
  removeSecret(adminId: string, which: unknown): Promise<BillingResult>;
  /** Stores the rates and numbers the change states, with the codes of the rate validation. */
  saveRates(adminId: string, change: unknown): Promise<BillingResult>;
  /** A harmless call to Stripe with the stored key; a pass is recorded. */
  checkConnection(adminId: string): Promise<ConnectionCheck>;
  /**
   * Makes sure the webhook endpoint exists at Stripe and its secret is stored: creates it, or adopts the one that exists for
   * this app's address. `recreate` replaces the endpoint and the secret (billing off).
   */
  createWebhookEndpoint(
    adminId: string,
    options?: { recreate?: boolean },
  ): Promise<EndpointResult>;
  /** Switches billing on (after the checks) or off. */
  setEnabled(adminId: string, enabled: unknown): Promise<BillingResult>;
};

/** How long one creation of the endpoint may hold the lease: a few calls to Stripe with a time limit each. */
const ENDPOINT_LEASE_MS = 60_000;

const API_KEY_MAX_LENGTH = 512;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9_-]{8,500}$/;

const STRIPE_API_KEY = "stripe_api_key";
const STRIPE_WEBHOOK_SECRET = "stripe_webhook_secret";
const SECRET_OF = {
  apiKey: STRIPE_API_KEY,
  webhookSecret: STRIPE_WEBHOOK_SECRET,
} as const;

function secretView(status: SecretStatus): BillingSecretView {
  if (status.state === "not_configured") return { state: "not_configured" };
  if (status.state === "undecryptable") return { state: "unreadable" };
  return { state: "configured", lastFour: status.lastFour };
}

/** What Stripe's refusal means for the admin. Only the code of the error is read, never its text. */
function checkErrorOf(error: unknown): BillingCheckErrorCode {
  if (!(error instanceof StripeClientError)) throw error;
  switch (error.code) {
    case "unauthorized":
    case "forbidden":
    case "environment_mismatch":
      return "stripe_key_rejected";
    case "rate_limited":
      return "stripe_rate_limited";
    case "timeout":
    case "network_error":
      return "stripe_unreachable";
    default:
      return "stripe_unavailable";
  }
}

async function mustSave(saving: Promise<{ ok: boolean }>): Promise<void> {
  if (!(await saving).ok) throw new Error("BILLING_SECRET_NOT_SAVED");
}

const bodyInvalid = (field: string): BillingFailure => ({
  ok: false,
  error: "invalid_input",
  issues: [{ field, code: "body_invalid" }],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createBillingAdminService({
  db,
  secretsOn,
  clientFor,
  publicUrl,
  now = () => new Date(),
  log = (line) => console.info(line),
}: BillingAdminServiceOptions): BillingAdminService {
  const secrets = secretsOn(db);
  const store = createBillingSettingsStore(db);
  const rates = createBillingRatesService(db);
  const instanceSettings = createInstanceSettingsRepository(db, now);
  const webhookUrl = `${normalizedAddress(publicUrl)}${BILLING_WEBHOOK_PATH}`;

  type MadeClient =
    | { ok: true; client: StripeClient; environment: StripeEnvironment }
    | { ok: false; error: BillingCheckErrorCode };

  function clientOf(key: string): MadeClient {
    const environment = stripeKeyEnvironment(key);
    if (environment === null)
      return { ok: false, error: "stripe_key_rejected" };
    try {
      return { ok: true, client: clientFor(key, environment), environment };
    } catch (error) {
      return { ok: false, error: checkErrorOf(error) };
    }
  }

  /** A client for the stored key, or the reason there is none. The key does not leave this function but in the client. */
  async function storedClient(): Promise<MadeClient> {
    const key = await secrets.use(STRIPE_API_KEY);
    if (!key.ok)
      return {
        ok: false,
        error:
          key.error === "secret_not_configured"
            ? "api_key_missing"
            : "api_key_unreadable",
      };
    return clientOf(key.value.reveal());
  }

  async function checkWith(made: MadeClient): Promise<ConnectionCheck> {
    if (!made.ok) return made;
    try {
      // The least a key can do: read the account it belongs to.
      await made.client.getAccount();
      return { ok: true, environment: made.environment };
    } catch (error) {
      return { ok: false, error: checkErrorOf(error) };
    }
  }

  /** Records a passing check (when, for which environment), keeping everything else. */
  function recordCheck(adminId: string, environment: StripeEnvironment) {
    return store.change<void>(adminId, (current) =>
      Promise.resolve({
        write: {
          ...current,
          stripe: {
            ...current.stripe,
            checkedAt: formatTimestamp(now()),
            checkedEnvironment: environment,
          },
        },
        result: undefined,
      }),
    );
  }

  /** The settings without the named fields of the Stripe state. */
  function withoutStripeFields(
    current: BillingSettings,
    drop: ReadonlyArray<keyof StoredStripeState>,
  ): BillingSettings {
    const { stripe: old, ...others } = current;
    if (old === undefined) return current;
    const stripe = { ...old };
    for (const field of drop) delete stripe[field];
    return Object.keys(stripe).length === 0 ? others : { ...others, stripe };
  }

  const CHECK_FIELDS = ["checkedAt", "checkedEnvironment"] as const;

  async function storedSecrets(on: SecretStore = secrets): Promise<{
    apiKey: SecretStatus;
    webhookSecret: SecretStatus;
  }> {
    const [apiKey, webhookSecret] = await Promise.all([
      on.status(STRIPE_API_KEY),
      on.status(STRIPE_WEBHOOK_SECRET),
    ]);
    return { apiKey, webhookSecret };
  }

  const usable = (status: SecretStatus) => status.state === "configured";

  return {
    async view() {
      const [{ settings, updatedAt }, stored] = await Promise.all([
        store.read(),
        storedSecrets(),
      ]);
      const [workspaces, ownKeyWorkspaces] = await Promise.all([
        createWorkspacesRepository(db).count(),
        createOwnKeyCountRepository(db).countWorkspacesWithStoredOwnKey(),
      ]);
      const adapter: BillingAdapterChoice =
        settings.adapter === STRIPE_ADAPTER_ID ? "stripe" : "manual";
      const missing = missingItemsOf({
        settings,
        secrets: {
          apiKey: usable(stored.apiKey),
          webhookSecret: usable(stored.webhookSecret),
        },
      });
      let environment: StripeEnvironment | null = null;
      if (usable(stored.apiKey)) {
        const key = await secrets.use(STRIPE_API_KEY);
        if (key.ok) environment = stripeKeyEnvironment(key.value.reveal());
      }
      const numbers = billingNumbersOf(settings);
      return {
        enabled: settings.enabled,
        // The one rule of "on" is the switch reader's; the page shows its answer, not a second derivation.
        on: await isBillingOn(db),
        adapter,
        missing,
        stripe: {
          apiKey: secretView(stored.apiKey),
          webhookSecret: secretView(stored.webhookSecret),
          environment,
          checkedAt: settings.stripe?.checkedAt ?? null,
          webhookEndpointId: settings.stripe?.webhookEndpointId ?? null,
          webhookUrl,
          webhookUrlPublic: isPublicHttpsUrl(webhookUrl),
        },
        rates: {
          factorA: settings.factorA ?? null,
          diffMinuteRateMicroUsd: settings.minuteRateMicroUsd?.diff ?? null,
          dynamicMinuteRateMicroUsd:
            settings.minuteRateMicroUsd?.dynamic ?? null,
          diffAiReserveMicroUsd: settings.diffAiReserveMicroUsd ?? null,
        },
        numbers: {
          ...numbers,
          startCreditStored: settings.startCreditMicroUsd !== undefined,
          lowBalanceStored: settings.lowBalanceMicroUsd !== undefined,
          hourlyReviewLimitStored: settings.hourlyReviewLimit !== undefined,
        },
        workspaces,
        ownKeyWorkspaces,
        updatedAt,
      };
    },

    async chooseAdapter(adminId, adapter) {
      if (adapter !== "manual" && adapter !== "stripe")
        return {
          ok: false,
          error: "invalid_input",
          issues: [{ field: "adapter", code: "adapter_invalid" }],
        };
      return store.change<BillingResult>(adminId, (current) =>
        Promise.resolve(
          current.enabled
            ? { refuse: { ok: false, error: "billing_disable_first" } }
            : { write: { ...current, adapter }, result: { ok: true } },
        ),
      );
    },

    async saveCredentials(adminId, input) {
      if (!isRecord(input)) return bodyInvalid("stripe");
      const { apiKey, webhookSecret } = input;
      const issues: BillingIssue[] = [];
      if (apiKey !== undefined && typeof apiKey !== "string")
        issues.push({ field: "apiKey", code: "api_key_invalid" });
      if (webhookSecret !== undefined && typeof webhookSecret !== "string")
        issues.push({ field: "webhookSecret", code: "webhook_secret_invalid" });
      if (issues.length > 0)
        return { ok: false, error: "invalid_input", issues };
      // An empty field keeps what is stored.
      const newKey =
        typeof apiKey === "string" && apiKey.trim() !== ""
          ? apiKey.trim()
          : undefined;
      const newSecret =
        typeof webhookSecret === "string" && webhookSecret.trim() !== ""
          ? webhookSecret.trim()
          : undefined;
      if (
        newKey !== undefined &&
        (newKey.length > API_KEY_MAX_LENGTH ||
          stripeKeyEnvironment(newKey) === null)
      )
        issues.push({ field: "apiKey", code: "api_key_invalid" });
      if (newSecret !== undefined && !WEBHOOK_SECRET.test(newSecret))
        issues.push({ field: "webhookSecret", code: "webhook_secret_invalid" });
      if (issues.length > 0)
        return { ok: false, error: "invalid_input", issues };
      if (newKey === undefined && newSecret === undefined) return { ok: true };

      const { settings: current } = await store.read();
      // Billing is on: the new key has to work before it replaces the one that does.
      let checkedEnvironment: StripeEnvironment | undefined;
      if (current.enabled && newKey !== undefined) {
        const check = await checkWith(clientOf(newKey));
        if (!check.ok) return check;
        checkedEnvironment = check.environment;
      }

      // The settings and the secrets change in one transaction under the lock: a switch-on that is judged in between sees
      // both or neither, and a refusal leaves the secrets alone as well.
      return store.change<BillingResult>(adminId, async (latest, executor) => {
        const inLock = secretsOn(executor);
        // The environment the stored key belongs to, if it can be read: another one makes the stored webhook secret and
        // endpoint foreign to the new key.
        let previousEnvironment: StripeEnvironment | null = null;
        if (newKey !== undefined) {
          const kept = await inLock.use(STRIPE_API_KEY);
          if (kept.ok)
            previousEnvironment = stripeKeyEnvironment(kept.value.reveal());
        }
        const environmentChanges =
          newKey !== undefined &&
          previousEnvironment !== null &&
          previousEnvironment !== stripeKeyEnvironment(newKey);
        // The switch may have been turned on since the first read: the credentials stay while it is on, except for a new key
        // of the same environment that was checked above. A key of the other one would take the webhook secret and the
        // endpoint with it and turn billing off without a word.
        if (
          latest.enabled &&
          newKey !== undefined &&
          (checkedEnvironment === undefined || environmentChanges)
        )
          return { refuse: { ok: false, error: "billing_disable_first" } };
        let next = latest;
        if (newKey !== undefined) {
          next = withoutStripeFields(
            next,
            environmentChanges
              ? [...CHECK_FIELDS, "webhookEndpointId"]
              : CHECK_FIELDS,
          );
          if (checkedEnvironment !== undefined)
            next = {
              ...next,
              stripe: {
                ...next.stripe,
                checkedAt: formatTimestamp(now()),
                checkedEnvironment,
              },
            };
        }
        const writer = { updatedBy: adminId, showLastFour: true };
        if (environmentChanges && newSecret === undefined)
          await inLock.remove(STRIPE_WEBHOOK_SECRET);
        // Both are checked above (not empty, far below the longest a secret may be); a failure here is not a refusal of the
        // input but a fault, and ending the transaction with it undoes the removal and the first save.
        if (newKey !== undefined)
          await mustSave(inLock.save(STRIPE_API_KEY, newKey, writer));
        if (newSecret !== undefined)
          await mustSave(inLock.save(STRIPE_WEBHOOK_SECRET, newSecret, writer));
        return { write: next, result: { ok: true } };
      });
    },

    async removeSecret(adminId, which) {
      if (which !== "apiKey" && which !== "webhookSecret")
        return bodyInvalid("removeSecret");
      // The credential goes in the transaction that judges the switch: a switch-on that is waiting for the lock finds it gone.
      return store.change<BillingResult>(adminId, async (current, executor) => {
        if (current.enabled)
          return { refuse: { ok: false, error: "billing_disable_first" } };
        await secretsOn(executor).remove(SECRET_OF[which]);
        return {
          write: withoutStripeFields(
            current,
            which === "apiKey" ? CHECK_FIELDS : ["webhookEndpointId"],
          ),
          result: { ok: true },
        };
      });
    },

    async saveRates(adminId, change) {
      const checked = validateRatesPatch(change);
      if (!checked.ok) return ratesFailure(checked.code, checked.field);
      const result = await rates.update(change, adminId);
      return result.ok ? { ok: true } : ratesFailure(result.code, result.field);
    },

    async checkConnection(adminId) {
      const check = await checkWith(await storedClient());
      if (check.ok) await recordCheck(adminId, check.environment);
      return check;
    },

    async createWebhookEndpoint(adminId, options = {}) {
      const recreate = options.recreate === true;
      // Nothing is called with an address Stripe could not deliver to.
      if (!isPublicHttpsUrl(webhookUrl))
        return { ok: false, error: "webhook_url_not_public" };
      const { settings } = await store.read();
      if (recreate && settings.enabled)
        return { ok: false, error: "billing_disable_first" };
      const made = await storedClient();
      if (!made.ok) return made;

      const lease = { startedAt: formatTimestamp(now()) };
      const claimed = await instanceSettings.claim(
        "billing_destination_lock",
        lease,
        adminId,
        formatTimestamp(new Date(now().getTime() - ENDPOINT_LEASE_MS)),
      );
      if (!claimed) return { ok: false, error: "webhook_endpoint_in_progress" };
      try {
        return await makeEndpoint(adminId, made, recreate);
      } finally {
        // Only the lease this request took: one taken over after it ran out belongs to the other request.
        await instanceSettings.release("billing_destination_lock", lease);
      }
    },

    async setEnabled(adminId, enabled) {
      if (typeof enabled !== "boolean") return bodyInvalid("enabled");
      if (!enabled)
        return store
          .change<BillingResult>(adminId, (current) =>
            Promise.resolve(
              current.enabled
                ? {
                    write: { ...current, enabled: false },
                    result: { ok: true },
                  }
                : { refuse: { ok: true } },
            ),
          )
          .then((result) => {
            if (result.ok) log("[billing] BILLING_SWITCHED enabled=false");
            return result;
          });

      const first = await store.read();
      const usesStripe =
        (first.settings.adapter ?? DEFAULT_ADAPTER_ID) === STRIPE_ADAPTER_ID;
      // A key that was rotated or revoked since the last click is found now, not when the first top-up fails.
      let freshCheckFailed = false;
      if (usesStripe && first.settings.stripe?.checkedAt !== undefined) {
        const key = await secrets.status(STRIPE_API_KEY);
        if (usable(key)) {
          const check = await checkWith(await storedClient());
          if (check.ok) await recordCheck(adminId, check.environment);
          else freshCheckFailed = true;
        }
      }
      const outcome = await store.change<BillingResult>(
        adminId,
        async (current, executor) => {
          // The credentials are read here, in the lock, in the transaction that writes the switch: a removal that waited for the
          // lock has been made, one that comes after finds billing on and is refused.
          const stored = await storedSecrets(secretsOn(executor));
          const missing: BillingNotReadyItem[] = missingItemsOf({
            settings: current,
            secrets: {
              apiKey: usable(stored.apiKey),
              webhookSecret: usable(stored.webhookSecret),
            },
          });
          if (freshCheckFailed) missing.push("connection_check_failed");
          // The rates are judged above; a Dispatcher that does not report its VMs is read here, through the transaction, so
          // the sighting and the switch are judged together (#498).
          const dispatcher = canSwitchBillingOnWithDispatcher(
            current,
            await readStoredDispatcherSightings(executor),
            now(),
          );
          if (
            !dispatcher.ok &&
            dispatcher.code === DISPATCHER_LACKS_VM_LIFECYCLE
          )
            missing.push(DISPATCHER_LACKS_VM_LIFECYCLE);
          // Exactly what was checked, in the transaction that writes the switch: a rate or a credential cannot go in between.
          if (missing.length > 0)
            return {
              refuse: { ok: false, error: "billing_not_ready", missing },
            };
          // The holds of jobs that ended while billing was off are released here, in the transaction that writes the switch (#591):
          // billing is never on with the money of an ended run still held.
          await releaseStrandedHolds(executor, now);
          return { write: { ...current, enabled: true }, result: { ok: true } };
        },
      );
      if (outcome.ok) log("[billing] BILLING_SWITCHED enabled=true");
      return outcome;
    },
  };

  /** The body of a creation, with the lease held. */
  async function makeEndpoint(
    adminId: string,
    made: Extract<MadeClient, { ok: true }>,
    recreate: boolean,
  ): Promise<EndpointResult> {
    const { client, environment } = made;
    const environmentOf = (livemode: boolean | undefined) =>
      livemode === undefined ? null : livemode ? "live" : "test";
    try {
      const ours = (await client.listWebhookEndpoints()).filter(
        ({ url }) => normalizedAddress(url) === webhookUrl,
      );
      if (recreate) {
        // A switch-on that wrote before now stops this: nothing is deleted behind a billing that is on. The old secret goes in
        // the same transaction, so a switch-on that comes after finds it gone; it signs nothing any more, and with the new one
        // lost it must not look like a working one.
        const stopped = await store.change<boolean>(
          adminId,
          async (current, executor) => {
            if (current.enabled) return { refuse: true };
            await secretsOn(executor).remove(STRIPE_WEBHOOK_SECRET);
            return {
              write: withoutStripeFields(current, ["webhookEndpointId"]),
              result: false,
            };
          },
        );
        if (stopped) return { ok: false, error: "billing_disable_first" };
        for (const endpoint of ours)
          await client.deleteWebhookEndpoint(endpoint.id);
      } else if (ours.length > 0) {
        const [only] = ours;
        // More than one cannot be told apart.
        if (ours.length > 1 || only === undefined)
          return { ok: false, error: "webhook_endpoint_secret_unknown" };
        const seen = environmentOf(only.livemode);
        if (seen !== null && seen !== environment)
          return { ok: false, error: "webhook_environment_mismatch" };
        // An endpoint that is switched off, or that is not told about every event billing handles, would adopt silently and
        // then never deliver the payment: it is replaced (billing off) or fixed at Stripe, never taken as it is.
        if (!deliversWhatBillingHandles(only))
          return { ok: false, error: "webhook_endpoint_unusable" };
        if (!usable(await secrets.status(STRIPE_WEBHOOK_SECRET)))
          return { ok: false, error: "webhook_endpoint_secret_unknown" };
        await rememberEndpoint(adminId, only.id);
        return { ok: true, created: false, endpointId: only.id };
      }
      const created = await client.createWebhookEndpoint({
        url: webhookUrl,
        enabled_events: [...STRIPE_WEBHOOK_EVENTS],
        description: "Code Reviewer",
      });
      const seen = environmentOf(created.livemode);
      if (seen !== null && seen !== environment) {
        await client.deleteWebhookEndpoint(created.id).catch(() => undefined);
        return { ok: false, error: "webhook_environment_mismatch" };
      }
      if (created.secret === undefined || created.secret === "") {
        await client.deleteWebhookEndpoint(created.id).catch(() => undefined);
        return { ok: false, error: "webhook_secret_not_returned" };
      }
      const saved = await secrets
        .save(STRIPE_WEBHOOK_SECRET, created.secret, {
          updatedBy: adminId,
          showLastFour: true,
        })
        .catch(() => ({ ok: false as const }));
      if (!saved.ok) {
        // Stripe shows the secret only now: an endpoint whose secret was lost is of no use, so it goes again.
        await client.deleteWebhookEndpoint(created.id).catch(() => undefined);
        log("[billing] BILLING_WEBHOOK_SECRET_NOT_STORED");
        return { ok: false, error: "webhook_secret_not_stored" };
      }
      await rememberEndpoint(adminId, created.id);
      log("[billing] BILLING_WEBHOOK_ENDPOINT_CREATED");
      return { ok: true, created: true, endpointId: created.id };
    } catch (error) {
      return { ok: false, error: checkErrorOf(error) };
    }
  }

  function rememberEndpoint(adminId: string, endpointId: string) {
    return store.change<void>(adminId, (current) =>
      Promise.resolve({
        write: {
          ...current,
          stripe: { ...current.stripe, webhookEndpointId: endpointId },
        },
        result: undefined,
      }),
    );
  }
}

/** Whether Stripe sends this endpoint every event type billing handles. */
function deliversWhatBillingHandles(endpoint: StripeWebhookEndpoint): boolean {
  if (endpoint.status !== "enabled") return false;
  return (
    endpoint.enabled_events.includes("*") ||
    STRIPE_WEBHOOK_EVENTS.every((type) =>
      endpoint.enabled_events.includes(type),
    )
  );
}

function ratesFailure(
  code: BillingRateErrorCode,
  field: string,
): BillingFailure {
  return { ok: false, error: "invalid_input", issues: [{ field, code }] };
}
