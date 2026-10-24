// SPDX-License-Identifier: LicenseRef-Proprietary

// The GitHub App of the instance as the admin enters it (docs/decisions/0001-editions-setup-and-accounts.md,
// sections 2.4 and 2.7), and the rules for what is accepted. The non-secret part is stored as the instance
// setting `github_app`; the private key, the webhook secret and the client secret are in the secret store
// (`github_app_private_key`, `github_app_webhook_secret`, `github_app_client_secret`). Pure functions: the
// store (credentials.ts) saves what passes here.
//
// Every field has its own stable code, and an issue never contains the value that caused it (a key or a
// secret must not end up in an answer or a log).
import type { SetupIssue } from "../setup/errors.ts";

/** Where the credentials came from; `import` is written by the import of an existing installation. */
export const GITHUB_APP_ORIGINS = ["manifest", "manual", "import"] as const;
export type GithubAppOrigin = (typeof GITHUB_APP_ORIGINS)[number];

/** The non-secret settings, as they are stored (`instance_settings`, key `github_app`). */
export type StoredGithubApp = {
  /** The numeric app id, as text. */
  appId: string;
  slug: string;
  /** The client id of the App's user authorization (the sign in with GitHub); null while it is not entered. */
  clientId: string | null;
  /**
   * Whether the App can only be installed on its own account. GitHub's API does not report it, so the admin
   * says it (or the manifest flow recorded what it asked for). Null: not known; the portal asks.
   */
  privateApp: boolean | null;
  origin: GithubAppOrigin;
};

/** A secret the admin types: keep what is stored (the field was empty), or replace it. */
export type SecretChange = { kind: "keep" } | { kind: "set"; value: string };

export type ManualInput = {
  appId: string;
  slug: string;
  privateKey: SecretChange;
  webhookSecret: SecretChange;
  /** Null: no user authorization (no sign in with GitHub). */
  clientId: string | null;
  clientSecret: SecretChange;
  privateApp: boolean;
};

export type UserAuthorizationInput = {
  clientId: string;
  clientSecret: SecretChange;
};

export const GITHUB_ISSUE_CODES = [
  "github_invalid",
  "app_id_required",
  "app_id_invalid",
  "slug_required",
  "slug_invalid",
  "private_key_required",
  "private_key_invalid",
  "webhook_secret_required",
  "webhook_secret_invalid",
  "client_id_required",
  "client_id_invalid",
  "client_secret_required",
  "client_secret_invalid",
  "private_app_invalid",
  /** GitHub refuses the App JWT: the key does not belong to the app id. */
  "app_auth_failed",
  /** GitHub knows the app under another slug. */
  "slug_mismatch",
  /** GitHub does not accept the client id and secret as a pair. */
  "client_credentials_invalid",
  /** GitHub could not be reached; nothing was saved. */
  "github_unreachable",
] as const;
export type GithubIssueCode = (typeof GITHUB_ISSUE_CODES)[number];

const APP_ID_PATTERN = /^[1-9]\d{0,19}$/;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{3,99}$/;
const CLIENT_SECRET_PATTERN = /^[!-~]{8,256}$/;
/** A PEM private key is about 2 KB; this leaves room for a long comment and a few line break styles. */
export const PRIVATE_KEY_MAX_LENGTH = 16 * 1024;
export const WEBHOOK_SECRET_MAX_LENGTH = 512;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function readSecret(
  raw: unknown,
  field: string,
  issues: SetupIssue[],
  options: {
    invalidCode: GithubIssueCode;
    maxLength: number;
    /** Trim the text (a secret that is compared byte for byte is not trimmed). */
    trim: boolean;
    pattern?: RegExp;
  },
): SecretChange {
  if (raw === undefined || raw === null) return { kind: "keep" };
  if (typeof raw !== "string") {
    issues.push({ field, code: options.invalidCode });
    return { kind: "keep" };
  }
  if (raw.trim() === "") return { kind: "keep" };
  const value = options.trim ? raw.trim() : raw;
  if (
    value.length > options.maxLength ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    issues.push({ field, code: options.invalidCode });
    return { kind: "keep" };
  }
  return { kind: "set", value };
}

function readClientId(
  raw: unknown,
  issues: SetupIssue[],
  required: boolean,
): string | null {
  if (raw === undefined || raw === null || raw === "") {
    if (required)
      issues.push({ field: "clientId", code: "client_id_required" });
    return null;
  }
  if (typeof raw !== "string") {
    issues.push({ field: "clientId", code: "client_id_invalid" });
    return null;
  }
  const value = raw.trim();
  if (value === "") {
    if (required)
      issues.push({ field: "clientId", code: "client_id_required" });
    return null;
  }
  if (!CLIENT_ID_PATTERN.test(value)) {
    issues.push({ field: "clientId", code: "client_id_invalid" });
    return null;
  }
  return value;
}

/** The form of the manual entry. `raw` is the request's `app` object, as received. */
export function parseManualInput(
  raw: unknown,
): { ok: true; value: ManualInput } | { ok: false; issues: SetupIssue[] } {
  if (!isObject(raw))
    return { ok: false, issues: [{ field: "app", code: "github_invalid" }] };
  const issues: SetupIssue[] = [];

  let appId = "";
  if (typeof raw.appId !== "string" || raw.appId.trim() === "")
    issues.push({ field: "appId", code: "app_id_required" });
  else if (!APP_ID_PATTERN.test(raw.appId.trim()))
    issues.push({ field: "appId", code: "app_id_invalid" });
  else appId = raw.appId.trim();

  let slug = "";
  if (typeof raw.slug !== "string" || raw.slug.trim() === "")
    issues.push({ field: "slug", code: "slug_required" });
  else if (!SLUG_PATTERN.test(raw.slug.trim()))
    issues.push({ field: "slug", code: "slug_invalid" });
  else slug = raw.slug.trim();

  const privateKey = readSecret(raw.privateKey, "privateKey", issues, {
    invalidCode: "private_key_invalid",
    maxLength: PRIVATE_KEY_MAX_LENGTH,
    trim: true,
  });
  // Used byte for byte (GitHub signs with exactly this), so not trimmed. A line break would be a paste
  // accident, and no webhook secret contains a control character.
  const webhookSecret = readSecret(raw.webhookSecret, "webhookSecret", issues, {
    invalidCode: "webhook_secret_invalid",
    maxLength: WEBHOOK_SECRET_MAX_LENGTH,
    trim: false,
  });
  if (
    webhookSecret.kind === "set" &&
    CONTROL_CHARACTERS.test(webhookSecret.value)
  )
    issues.push({ field: "webhookSecret", code: "webhook_secret_invalid" });

  const clientId = readClientId(raw.clientId, issues, false);
  const clientSecret = readSecret(raw.clientSecret, "clientSecret", issues, {
    invalidCode: "client_secret_invalid",
    maxLength: 256,
    trim: true,
    pattern: CLIENT_SECRET_PATTERN,
  });
  // A client secret needs a client id (when the id was typed but is not valid, that is already said).
  if (
    clientId === null &&
    clientSecret.kind === "set" &&
    !issues.some((issue) => issue.field === "clientId")
  )
    issues.push({ field: "clientId", code: "client_id_required" });

  if (typeof raw.privateApp !== "boolean")
    issues.push({ field: "privateApp", code: "private_app_invalid" });

  if (issues.length > 0 || typeof raw.privateApp !== "boolean")
    return { ok: false, issues };
  return {
    ok: true,
    value: {
      appId,
      slug,
      privateKey,
      webhookSecret,
      clientId,
      clientSecret,
      privateApp: raw.privateApp,
    },
  };
}

/** The prompt of an imported App: client id and secret of its user authorization. */
export function parseUserAuthorizationInput(
  raw: unknown,
):
  | { ok: true; value: UserAuthorizationInput }
  | { ok: false; issues: SetupIssue[] } {
  if (!isObject(raw))
    return {
      ok: false,
      issues: [{ field: "userAuthorization", code: "github_invalid" }],
    };
  const issues: SetupIssue[] = [];
  const clientId = readClientId(raw.clientId, issues, true);
  const clientSecret = readSecret(raw.clientSecret, "clientSecret", issues, {
    invalidCode: "client_secret_invalid",
    maxLength: 256,
    trim: true,
    pattern: CLIENT_SECRET_PATTERN,
  });
  if (issues.length > 0 || clientId === null) return { ok: false, issues };
  return { ok: true, value: { clientId, clientSecret } };
}

/** A stored `github_app` value, or null when it does not pass (a row edited by hand counts as no App). */
export function readStoredGithubApp(value: unknown): StoredGithubApp | null {
  if (!isObject(value)) return null;
  const { appId, slug, clientId, privateApp, origin } = value;
  if (typeof appId !== "string" || !APP_ID_PATTERN.test(appId)) return null;
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) return null;
  if (clientId !== null && typeof clientId !== "string") return null;
  if (privateApp !== null && typeof privateApp !== "boolean") return null;
  if (!GITHUB_APP_ORIGINS.some((candidate) => candidate === origin))
    return null;
  return {
    appId,
    slug,
    clientId: clientId ?? null,
    privateApp: privateApp ?? null,
    origin: origin as GithubAppOrigin,
  };
}
