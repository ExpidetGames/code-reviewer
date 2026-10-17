// SPDX-License-Identifier: Apache-2.0

// The instance setting `billing_settings` (ADR 0005, 2.10) and the rules for what may be saved in it. Pure: no
// database, no Paddle. The API key and the webhook secret are not here but in the secret store
// (`paddle_api_key`, `paddle_webhook_secret`).
import "server-only";
import {
  BILLING_ENVIRONMENTS,
  type BillingEnvironment,
} from "../admin/ui/billing-view.ts";

export { BILLING_ENVIRONMENTS, type BillingEnvironment };

export type BillingSettings = {
  environment: BillingEnvironment;
  /** Paddle's client-side token: public by design (it is loaded in the browser), so it is stored as it is. */
  clientToken: string;
  /** Days a subscription may stay `past_due` before the workspace is suspended. */
  graceDays: number;
  /** The switch. Billing is on when this is true and the credentials are complete (`isBillingOn`). */
  enabled: boolean;
};

export const DEFAULT_GRACE_DAYS = 7;
export const MAX_GRACE_DAYS = 90;
const CLIENT_TOKEN_MAX_LENGTH = 200;
/** An API key and a webhook secret are far shorter than this; the bound only keeps junk out of the store. */
export const PADDLE_SECRET_MAX_LENGTH = 512;

/** Billing never configured: off, in the safe environment. */
export const DEFAULT_BILLING_SETTINGS: BillingSettings = {
  environment: "sandbox",
  clientToken: "",
  graceDays: DEFAULT_GRACE_DAYS,
  enabled: false,
};

export type BillingIssue = { field: string; code: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGraceDays(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_GRACE_DAYS
  );
}

function isEnvironment(value: unknown): value is BillingEnvironment {
  return BILLING_ENVIRONMENTS.some((environment) => environment === value);
}

/** Visible characters only: a token with a space or a control character was pasted wrongly. */
function isToken(value: string, maxLength: number): boolean {
  return value.length <= maxLength && /^[\x21-\x7e]+$/.test(value);
}

/**
 * The stored value as settings. Whatever is damaged reads as the default for that field, and `enabled` is only
 * true when it is exactly `true`: a setting that cannot be read never switches billing on.
 */
export function readBillingSettings(stored: unknown): BillingSettings {
  if (!isRecord(stored)) return DEFAULT_BILLING_SETTINGS;
  return {
    environment: isEnvironment(stored.environment)
      ? stored.environment
      : DEFAULT_BILLING_SETTINGS.environment,
    clientToken:
      typeof stored.clientToken === "string" ? stored.clientToken : "",
    graceDays: isGraceDays(stored.graceDays)
      ? stored.graceDays
      : DEFAULT_GRACE_DAYS,
    enabled: stored.enabled === true,
  };
}

export type SettingsInput = {
  environment: BillingEnvironment;
  clientToken: string;
  graceDays: number;
  /** A new API key; undefined keeps the stored one. */
  apiKey: string | undefined;
  /** A new webhook secret; undefined keeps the stored one. */
  webhookSecret: string | undefined;
};

/** A secret field of the form: empty or missing keeps the stored value, otherwise it is the new one. */
function secretField(
  value: unknown,
  field: string,
  code: string,
  issues: BillingIssue[],
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    !isToken(value.trim(), PADDLE_SECRET_MAX_LENGTH)
  ) {
    issues.push({ field, code });
    return undefined;
  }
  return value.trim();
}

export function parseSettingsInput(
  input: unknown,
): { ok: true; value: SettingsInput } | { ok: false; issues: BillingIssue[] } {
  if (!isRecord(input))
    return { ok: false, issues: [{ field: "settings", code: "body_invalid" }] };
  const issues: BillingIssue[] = [];
  if (!isEnvironment(input.environment))
    issues.push({ field: "environment", code: "environment_invalid" });
  const clientToken =
    typeof input.clientToken === "string" ? input.clientToken.trim() : null;
  // Empty is allowed: the page can be saved before the token is at hand; enabling asks for it.
  if (
    clientToken === null ||
    (clientToken !== "" && !isToken(clientToken, CLIENT_TOKEN_MAX_LENGTH))
  )
    issues.push({ field: "clientToken", code: "client_token_invalid" });
  if (!isGraceDays(input.graceDays))
    issues.push({ field: "graceDays", code: "grace_days_invalid" });
  const apiKey = secretField(input.apiKey, "apiKey", "api_key_invalid", issues);
  const webhookSecret = secretField(
    input.webhookSecret,
    "webhookSecret",
    "webhook_secret_invalid",
    issues,
  );
  if (
    issues.length > 0 ||
    !isEnvironment(input.environment) ||
    clientToken === null ||
    !isGraceDays(input.graceDays)
  )
    return { ok: false, issues };
  return {
    ok: true,
    value: {
      environment: input.environment,
      clientToken,
      graceDays: input.graceDays,
      apiKey,
      webhookSecret,
    },
  };
}

/**
 * Which Paddle environment an API key belongs to, from the key alone: a key with `_sdbx` in it is a sandbox key
 * (`pdl_sdbx_...`), `pdl_live_...` is a live key, anything else is no Paddle key (null).
 */
export function keyEnvironmentOf(apiKey: string): BillingEnvironment | null {
  if (apiKey.includes("_sdbx")) return "sandbox";
  if (apiKey.startsWith("pdl_live_")) return "live";
  return null;
}
