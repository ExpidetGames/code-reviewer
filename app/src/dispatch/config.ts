// SPDX-License-Identifier: Apache-2.0

// The settings of the dispatch webhook (#326): whether the app wakes a Dispatcher after it queued a job,
// where, and with which key. Off by default: without `RUNNER_DISPATCH=webhook` the app behaves as before
// (runners poll) and nothing here runs. The one place that knows the variable names. A pure function of
// the environment passed in; every message names variables and never a value.
//
// | Variable                                                      | Meaning                                              |
// | ------------------------------------------------------------- | ---------------------------------------------------- |
// | RUNNER_DISPATCH                                               | `poll` (default) or `webhook`                        |
// | RUNNER_WEBHOOK_URL                                            | The Dispatcher's `POST /dispatch` (https)            |
// | RUNNER_WEBHOOK_SECRET, RUNNER_WEBHOOK_KEY_ID                  | The signing key (id defaults to `k1`)                |
// | RUNNER_WEBHOOK_SECRET_PREVIOUS, RUNNER_WEBHOOK_KEY_ID_PREVIOUS | The key that is being replaced (both or none)        |
// | RUNNER_WEBHOOK_BYPASS_TOKEN                                   | Optional: the platform's deployment protection bypass |
import "server-only";
import { UNUSABLE_CHARACTER } from "../runner-api/token-auth.ts";

export const DISPATCH_MODES = ["poll", "webhook"] as const;
export type DispatchMode = (typeof DISPATCH_MODES)[number];

export const DISPATCH_CONFIG_ERROR_CODES = ["DISPATCH_CONFIG_INVALID"] as const;

/** The shortest signing secret; the Dispatcher refuses a shorter one too. */
export const MIN_DISPATCH_SECRET_LENGTH = 32;
const KEY_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DEFAULT_KEY_ID = "k1";

/** The credentials of the app. The signing secret is never a copy of one of them. */
export const OTHER_CREDENTIAL_VARIABLES = [
  "RUNNER_TOKEN",
  "APP_SECRET",
  "BETTER_AUTH_SECRET",
  "OPERATOR_API_TOKEN",
  "CRON_SECRET",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "LLM_API_KEY",
] as const;

export type DispatchKey = { kid: string; secret: string };

export type WebhookDispatchConfig = {
  mode: "webhook";
  url: string;
  /** Signs every request. */
  currentKey: DispatchKey;
  /** Only carried for the rotation order (the Dispatcher accepts both); the app never signs with it. */
  previousKey?: DispatchKey;
  bypassToken?: string;
};

export type DispatchConfig = { mode: "poll" } | WebhookDispatchConfig;

export class DispatchConfigError extends Error {
  readonly code = DISPATCH_CONFIG_ERROR_CODES[0];

  constructor(problems: string[]) {
    super(`The dispatch settings are invalid: ${problems.join("; ")}.`);
    this.name = "DispatchConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function value(env: Env, name: string): string | undefined {
  const text = env[name]?.trim();
  return text === undefined || text === "" ? undefined : text;
}

function modeOf(env: Env): DispatchMode | "invalid" {
  const configured = value(env, "RUNNER_DISPATCH")?.toLowerCase();
  if (configured === undefined) return "poll";
  return DISPATCH_MODES.find((mode) => mode === configured) ?? "invalid";
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Https without credentials; plain http only to this machine (the fakes and local development). */
function urlIsUsable(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK.has(url.hostname);
}

function secretProblem(name: string, secret: string): string | null {
  if (UNUSABLE_CHARACTER.test(secret))
    return `${name} must not contain white space or control characters`;
  if (secret.length < MIN_DISPATCH_SECRET_LENGTH)
    return `${name} must be at least ${String(MIN_DISPATCH_SECRET_LENGTH)} characters long`;
  return null;
}

/** The first other credential (by name) that holds the same text, or null. */
function reusedCredential(env: Env, secret: string): string | null {
  for (const name of OTHER_CREDENTIAL_VARIABLES)
    if (value(env, name) === secret) return name;
  return null;
}

/**
 * What is wrong with the dispatch settings, one phrase per problem, each starting with the variable it is
 * about. Empty in poll mode (the webhook variables are not looked at) and for a complete webhook setup.
 */
export function dispatchConfigProblems(env: Env): string[] {
  const mode = modeOf(env);
  if (mode === "poll") return [];
  if (mode === "invalid")
    return ['RUNNER_DISPATCH must be "poll" or "webhook"'];

  const problems: string[] = [];
  const url = value(env, "RUNNER_WEBHOOK_URL");
  if (url === undefined) problems.push("RUNNER_WEBHOOK_URL is not set");
  else if (!urlIsUsable(url))
    problems.push(
      "RUNNER_WEBHOOK_URL must be an https URL without credentials",
    );

  const kid = value(env, "RUNNER_WEBHOOK_KEY_ID") ?? DEFAULT_KEY_ID;
  if (!KEY_ID.test(kid))
    problems.push(
      "RUNNER_WEBHOOK_KEY_ID must be 1 to 32 characters of a-z, 0-9, _ or -, starting with a letter or digit",
    );

  const secret = value(env, "RUNNER_WEBHOOK_SECRET");
  if (secret === undefined) problems.push("RUNNER_WEBHOOK_SECRET is not set");
  else {
    const problem =
      secretProblem("RUNNER_WEBHOOK_SECRET", secret) ??
      reuseProblem(env, "RUNNER_WEBHOOK_SECRET", secret);
    if (problem !== null) problems.push(problem);
  }

  const previousKid = value(env, "RUNNER_WEBHOOK_KEY_ID_PREVIOUS");
  const previousSecret = value(env, "RUNNER_WEBHOOK_SECRET_PREVIOUS");
  if (previousSecret !== undefined && previousKid === undefined)
    problems.push(
      "RUNNER_WEBHOOK_KEY_ID_PREVIOUS is required with RUNNER_WEBHOOK_SECRET_PREVIOUS",
    );
  if (previousKid !== undefined && previousSecret === undefined)
    problems.push(
      "RUNNER_WEBHOOK_SECRET_PREVIOUS is required with RUNNER_WEBHOOK_KEY_ID_PREVIOUS",
    );
  if (previousKid !== undefined && previousSecret !== undefined) {
    if (!KEY_ID.test(previousKid))
      problems.push(
        "RUNNER_WEBHOOK_KEY_ID_PREVIOUS must be 1 to 32 characters of a-z, 0-9, _ or -, starting with a letter or digit",
      );
    else if (previousKid === kid)
      problems.push(
        "RUNNER_WEBHOOK_KEY_ID_PREVIOUS must differ from RUNNER_WEBHOOK_KEY_ID",
      );
    const problem =
      secretProblem("RUNNER_WEBHOOK_SECRET_PREVIOUS", previousSecret) ??
      (previousSecret === secret
        ? "RUNNER_WEBHOOK_SECRET_PREVIOUS must differ from RUNNER_WEBHOOK_SECRET"
        : reuseProblem(env, "RUNNER_WEBHOOK_SECRET_PREVIOUS", previousSecret));
    if (problem !== null) problems.push(problem);
  }

  const bypass = value(env, "RUNNER_WEBHOOK_BYPASS_TOKEN");
  if (bypass !== undefined) {
    if (UNUSABLE_CHARACTER.test(bypass))
      problems.push(
        "RUNNER_WEBHOOK_BYPASS_TOKEN must not contain white space or control characters",
      );
    else if (bypass === secret)
      problems.push(
        "RUNNER_WEBHOOK_BYPASS_TOKEN must differ from RUNNER_WEBHOOK_SECRET",
      );
    else if (bypass === previousSecret)
      problems.push(
        "RUNNER_WEBHOOK_BYPASS_TOKEN must differ from RUNNER_WEBHOOK_SECRET_PREVIOUS",
      );
  }
  return problems;
}

function reuseProblem(env: Env, name: string, secret: string): string | null {
  const other = reusedCredential(env, secret);
  return other === null ? null : `${name} must differ from ${other}`;
}

/** The settings as they are used. Throws `DispatchConfigError` (code `DISPATCH_CONFIG_INVALID`) for a bad setup. */
export function loadDispatchConfig(env: Env): DispatchConfig {
  const problems = dispatchConfigProblems(env);
  if (problems.length > 0) throw new DispatchConfigError(problems);
  if (modeOf(env) === "poll") return { mode: "poll" };

  const previousKid = value(env, "RUNNER_WEBHOOK_KEY_ID_PREVIOUS");
  const previousSecret = value(env, "RUNNER_WEBHOOK_SECRET_PREVIOUS");
  const bypassToken = value(env, "RUNNER_WEBHOOK_BYPASS_TOKEN");
  return {
    mode: "webhook",
    // The checks above guarantee both are set.
    url: value(env, "RUNNER_WEBHOOK_URL") as string,
    currentKey: {
      kid: value(env, "RUNNER_WEBHOOK_KEY_ID") ?? DEFAULT_KEY_ID,
      secret: value(env, "RUNNER_WEBHOOK_SECRET") as string,
    },
    ...(previousKid !== undefined && previousSecret !== undefined
      ? { previousKey: { kid: previousKid, secret: previousSecret } }
      : {}),
    ...(bypassToken === undefined ? {} : { bypassToken }),
  };
}
