// SPDX-License-Identifier: Apache-2.0

// The two calls to GitHub that are not made as an installed App: trading the one-time code of the manifest
// flow for the credentials of the App that was just created (`POST /app-manifests/{code}/conversions`),
// and asking GitHub whether a client id and secret belong together (the "check a token" endpoint with the
// client credentials, which answers 404 for an unknown token when the credentials are right and 401 when they
// are not). Both answer with a stable code; neither puts a response body, a key or a secret into a message.
import { createPrivateKey } from "node:crypto";
import { createGithubAppClient } from "./client.ts";
import { normalizePemKey } from "./config.ts";
import { GithubAppError } from "./errors.ts";
import { isRecord } from "./guards.ts";

const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 15_000;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export type GithubRequestOptions = {
  /** API base URL without a trailing slash. */
  apiBaseUrl: string;
  /** Default: the global fetch at call time. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export const MANIFEST_CONVERSION_ERROR_CODES = [
  /** GitHub does not know the code (used, expired, never issued) or refused it. */
  "manifest_code_invalid",
  /** GitHub could not be reached, timed out or answered with a server error. */
  "github_unreachable",
  /** GitHub answered, but not with what the manifest flow documents. */
  "conversion_response_invalid",
] as const;
export type ManifestConversionErrorCode =
  (typeof MANIFEST_CONVERSION_ERROR_CODES)[number];

/** What the conversion returns that the instance stores. The secrets are readable properties. */
export type ConvertedApp = {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  /** The PEM of the private key, normalised. */
  privateKey: string;
};

export type ManifestConversionResult =
  | { ok: true; app: ConvertedApp }
  | { ok: false; error: ManifestConversionErrorCode };

function headers(): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": GITHUB_API_VERSION,
    "user-agent": "code-reviewer",
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isRsaKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === "rsa";
  } catch {
    return false;
  }
}

/**
 * Trades the code GitHub put into the redirect for the App's credentials. The code works once, on GitHub's
 * side too; the caller has used up its own single-use state before it gets here. Nothing is stored here.
 */
export async function convertManifestCode(
  options: GithubRequestOptions & { code: string },
): Promise<ManifestConversionResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(
      `${options.apiBaseUrl}/app-manifests/${encodeURIComponent(options.code)}/conversions`,
      {
        method: "POST",
        headers: headers(),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
    );
  } catch {
    // The cause is dropped: it can quote the request, and the code is a credential for a minute.
    return { ok: false, error: "github_unreachable" };
  }
  if (response.status === 404 || response.status === 422) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, error: "manifest_code_invalid" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      error:
        response.status >= 500 || response.status === 429
          ? "github_unreachable"
          : "manifest_code_invalid",
    };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: "conversion_response_invalid" };
  }
  if (
    !isRecord(json) ||
    typeof json.id !== "number" ||
    !Number.isSafeInteger(json.id) ||
    !nonEmptyString(json.slug) ||
    !SLUG_PATTERN.test(json.slug) ||
    !nonEmptyString(json.client_id) ||
    !nonEmptyString(json.client_secret) ||
    !nonEmptyString(json.webhook_secret) ||
    !nonEmptyString(json.pem)
  )
    return { ok: false, error: "conversion_response_invalid" };
  const privateKey = normalizePemKey(json.pem);
  if (!isRsaKey(privateKey))
    return { ok: false, error: "conversion_response_invalid" };
  return {
    ok: true,
    app: {
      appId: String(json.id),
      slug: json.slug,
      clientId: json.client_id,
      clientSecret: json.client_secret,
      webhookSecret: json.webhook_secret,
      privateKey,
    },
  };
}

export type ClientCredentialsCheck = "valid" | "invalid" | "unavailable";

/**
 * Whether a client id and secret are accepted by GitHub: "check a token" with the client credentials as
 * basic authentication and a token that cannot exist. Right credentials: 404 (no such token). Wrong ones:
 * 401. A client id GitHub does not know also answers 404, so the check cannot tell a wrong id with a right
 * secret from a right pair; a wrong id shows at the first sign in.
 */
export async function checkClientCredentials(
  options: GithubRequestOptions & { clientId: string; clientSecret: string },
): Promise<ClientCredentialsCheck> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const basic = Buffer.from(
    `${options.clientId}:${options.clientSecret}`,
  ).toString("base64");
  let response: Response;
  try {
    response = await doFetch(
      `${options.apiBaseUrl}/applications/${encodeURIComponent(options.clientId)}/token`,
      {
        method: "POST",
        headers: {
          ...headers(),
          authorization: `Basic ${basic}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          access_token: "code-reviewer-credential-check",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
    );
  } catch {
    return "unavailable";
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 404 || response.status === 200) return "valid";
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 422
  )
    return "invalid";
  return "unavailable";
}

export const VERIFY_APP_ERROR_CODES = [
  /** GitHub refuses the JWT: the key does not belong to the app id. */
  "app_auth_failed",
  /** GitHub knows the app under another slug than the one entered. */
  "slug_mismatch",
  /** GitHub could not be reached, timed out or answered with a server error. */
  "github_unreachable",
] as const;
export type VerifyAppErrorCode = (typeof VERIFY_APP_ERROR_CODES)[number];

export type VerifyAppResult =
  /** `permissions`: what the App is granted, by API name, for `missingPermissions`. */
  | { ok: true; permissions: Record<string, string> }
  | { ok: false; error: VerifyAppErrorCode };

/**
 * Whether the entered App id, slug and private key belong together: `GET /app` with a JWT signed with the
 * key must succeed and name the entered id and slug. Used before anything is saved (the manual form) and to
 * read what the App is granted (the hint about missing permissions).
 */
export async function verifyGithubApp(
  options: GithubRequestOptions & {
    appId: string;
    slug: string;
    privateKey: string;
  },
): Promise<VerifyAppResult> {
  const client = createGithubAppClient({
    config: {
      appId: options.appId,
      slug: options.slug,
      apiBaseUrl: options.apiBaseUrl,
      privateKey: options.privateKey,
      webhookSecret: "unused",
    },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.timeoutMs }),
  });
  try {
    const app = await client.getApp();
    if (app.id !== options.appId)
      return { ok: false, error: "app_auth_failed" };
    if (app.slug.toLowerCase() !== options.slug.toLowerCase())
      return { ok: false, error: "slug_mismatch" };
    return { ok: true, permissions: app.permissions };
  } catch (error) {
    if (error instanceof GithubAppError) {
      // 401: the JWT is refused. 404: GitHub does not know an app with that id. Both mean the pair is wrong.
      if (
        error.code === "GITHUB_APP_AUTH_FAILED" ||
        error.code === "GITHUB_APP_NOT_FOUND"
      )
        return { ok: false, error: "app_auth_failed" };
    }
    return { ok: false, error: "github_unreachable" };
  }
}
