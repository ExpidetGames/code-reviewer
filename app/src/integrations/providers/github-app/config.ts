// SPDX-License-Identifier: Apache-2.0

// Reads the GitHub App settings from the environment. The only place that knows the variable names.
// Problems are reported by variable name, never by value; the private key and the webhook secret are
// readable properties that JSON.stringify, spreading and console output leave out.
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ALLOW_TEST_GITHUB_ENDPOINTS_FLAG,
  resolveGithubEndpoint,
  testGithubEndpointsAllowed,
} from "../../../github-endpoints.ts";
import { GithubAppConfigError } from "./errors.ts";

export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

export type GithubAppConfig = {
  appId: string;
  slug: string;
  /** API base URL without a trailing slash (tests point it at the fake). */
  apiBaseUrl: string;
  /** PEM of the app's private key. Not enumerable. */
  readonly privateKey: string;
  /** Secret of the app's webhook. Not enumerable. */
  readonly webhookSecret: string;
};

type Env = Readonly<Record<string, string | undefined>>;

function value(env: Env, name: string): string | undefined {
  const text = env[name]?.trim();
  return text === undefined || text === "" ? undefined : text;
}

/**
 * Some hosting setups strip or escape the line breaks of a multi-line variable. This re-wraps the
 * base64 body at 64 characters whatever shape the key arrived in: a single line, `\n` escaped, or
 * already well formed.
 */
export function normalizePemKey(raw: string): string {
  const key = raw.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  const match = key.match(
    /-----BEGIN ([^-]+)-----\s*([\s\S]*?)\s*-----END \1-----/,
  );
  if (!match) return key;
  const body = (match[2] ?? "").replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${match[1]}-----\n${lines.join("\n")}\n-----END ${match[1]}-----`;
}

export function isUsableRsaKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === "rsa";
  } catch {
    // Not echoed: the parser's message may quote parts of its input.
    return false;
  }
}

function readKey(
  env: Env,
): { pem: string } | { missing: true } | { invalid: string } {
  const inline = value(env, "GITHUB_APP_PRIVATE_KEY");
  if (inline !== undefined) {
    const pem = normalizePemKey(inline);
    return isUsableRsaKey(pem)
      ? { pem }
      : { invalid: "GITHUB_APP_PRIVATE_KEY" };
  }
  const path = value(env, "GITHUB_APP_PRIVATE_KEY_PATH");
  if (path === undefined) return { missing: true };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { invalid: "GITHUB_APP_PRIVATE_KEY_PATH" };
  }
  const pem = normalizePemKey(text);
  return isUsableRsaKey(pem)
    ? { pem }
    : { invalid: "GITHUB_APP_PRIVATE_KEY_PATH" };
}

/**
 * Builds the configuration or throws a `GithubAppConfigError` that lists every missing or invalid
 * variable by name. Fails fast: the provider cannot work with a partial configuration.
 */
export function loadGithubAppConfig(env: Env): GithubAppConfig {
  const missing: string[] = [];
  const invalid: string[] = [];

  const appId = value(env, "GITHUB_APP_ID");
  if (appId === undefined) missing.push("GITHUB_APP_ID");
  else if (/\s/.test(appId)) invalid.push("GITHUB_APP_ID");

  const slug = value(env, "GITHUB_APP_SLUG");
  if (slug === undefined) missing.push("GITHUB_APP_SLUG");
  else if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(slug))
    invalid.push("GITHUB_APP_SLUG");

  // Not trimmed: the secret is compared byte for byte with the one GitHub signs with.
  const rawSecret = env.GITHUB_APP_WEBHOOK_SECRET;
  const webhookSecret =
    rawSecret === undefined || rawSecret.trim() === "" ? undefined : rawSecret;
  if (webhookSecret === undefined) missing.push("GITHUB_APP_WEBHOOK_SECRET");

  const key = readKey(env);
  if ("missing" in key)
    missing.push("GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_PATH)");
  else if ("invalid" in key) invalid.push(key.invalid);

  // The App JWT and installation tokens are sent to this address: the public GitHub API unless the
  // operator allows a test endpoint (src/github-endpoints.ts, the same rule as the sign in).
  const apiEndpoint = resolveGithubEndpoint(
    env.GITHUB_API_BASE_URL,
    DEFAULT_GITHUB_API_BASE_URL,
    testGithubEndpointsAllowed(env),
  );
  const apiBaseUrl = apiEndpoint.ok ? apiEndpoint.url : undefined;
  // Both names: the fix is either to remove the override or to allow it on purpose.
  if (apiBaseUrl === undefined)
    invalid.push("GITHUB_API_BASE_URL", ALLOW_TEST_GITHUB_ENDPOINTS_FLAG);

  if (missing.length > 0) throw new GithubAppConfigError(missing, "missing");
  if (invalid.length > 0) throw new GithubAppConfigError(invalid, "invalid");

  const config = {
    appId: appId as string,
    slug: slug as string,
    apiBaseUrl: apiBaseUrl as string,
  } as GithubAppConfig;
  Object.defineProperty(config, "privateKey", {
    value: (key as { pem: string }).pem,
    enumerable: false,
  });
  Object.defineProperty(config, "webhookSecret", {
    value: webhookSecret,
    enumerable: false,
  });
  return config;
}
