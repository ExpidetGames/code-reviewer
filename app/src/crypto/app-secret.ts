// SPDX-License-Identifier: LicenseRef-Proprietary

// `APP_SECRET`, the master key of the instance (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.1). `BETTER_AUTH_SECRET`, its old name, is accepted in its place when `APP_SECRET` is not
// set, so an installation from before this setting keeps its sessions and its encrypted tokens. The
// old name is deprecated: the server logs that once when it starts.

export const APP_SECRET_VARIABLE = "APP_SECRET";
export const LEGACY_APP_SECRET_VARIABLE = "BETTER_AUTH_SECRET";
export const MIN_APP_SECRET_LENGTH = 32;

type Env = Readonly<Record<string, string | undefined>>;

export type AppSecretResolution =
  | {
      ok: true;
      secret: string;
      source: typeof APP_SECRET_VARIABLE | typeof LEGACY_APP_SECRET_VARIABLE;
    }
  | { ok: false; problem: string };

function clean(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text === "" ? undefined : text;
}

/** The secret and the variable it came from, or one sentence that names the variable to fix. */
export function resolveAppSecret(env: Env): AppSecretResolution {
  const current = clean(env.APP_SECRET);
  const legacy = clean(env.BETTER_AUTH_SECRET);
  const source =
    current !== undefined ? APP_SECRET_VARIABLE : LEGACY_APP_SECRET_VARIABLE;
  const secret = current ?? legacy;
  if (secret === undefined)
    return {
      ok: false,
      problem: `${APP_SECRET_VARIABLE} is not set (it is the master key of the server: openssl rand -base64 32)`,
    };
  if (secret.length < MIN_APP_SECRET_LENGTH)
    return {
      ok: false,
      problem: `${source} must be at least ${String(MIN_APP_SECRET_LENGTH)} characters long`,
    };
  return { ok: true, secret, source };
}

/** The line for the log when the old variable is the one in use; null otherwise. */
export function legacyAppSecretWarning(env: Env): string | null {
  const resolution = resolveAppSecret(env);
  if (!resolution.ok || resolution.source !== LEGACY_APP_SECRET_VARIABLE)
    return null;
  return `[config] APP_SECRET_FROM_LEGACY_VARIABLE: ${LEGACY_APP_SECRET_VARIABLE} is deprecated and is used as ${APP_SECRET_VARIABLE} because ${APP_SECRET_VARIABLE} is not set. Set ${APP_SECRET_VARIABLE} to the same value and remove ${LEGACY_APP_SECRET_VARIABLE}.`;
}

/**
 * The line for the log when both variables are set to different values: APP_SECRET wins, and
 * everything made with the other one (sessions, stored GitHub tokens) stops working. Names both
 * variables, never a value; null otherwise.
 */
export function conflictingAppSecretWarning(env: Env): string | null {
  const current = clean(env.APP_SECRET);
  const legacy = clean(env.BETTER_AUTH_SECRET);
  if (current === undefined || legacy === undefined || current === legacy)
    return null;
  return `[config] APP_SECRET_DIFFERS_FROM_LEGACY_VARIABLE: ${APP_SECRET_VARIABLE} and ${LEGACY_APP_SECRET_VARIABLE} are both set and differ. ${APP_SECRET_VARIABLE} is used; sessions and stored tokens made with ${LEGACY_APP_SECRET_VARIABLE} stop working. To keep them, set ${APP_SECRET_VARIABLE} to the value of ${LEGACY_APP_SECRET_VARIABLE}; then remove ${LEGACY_APP_SECRET_VARIABLE}.`;
}
