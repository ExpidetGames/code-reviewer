// SPDX-License-Identifier: LicenseRef-Proprietary

// The allow list: who may use this instance. Read from `ALLOWED_GITHUB_LOGINS` (comma separated
// GitHub logins) and `ALLOWED_GITHUB_ORG` (members of one GitHub organization). When both are set,
// either one is enough. When neither is set nobody is allowed (fail closed).

export type AccessConfig = {
  /** Lower case logins; never contains the empty string. */
  logins: ReadonlySet<string>;
  /** The organization whose members may use the instance, or null when org mode is off. */
  org: string | null;
  /**
   * Entries of `ALLOWED_GITHUB_LOGINS` that cannot be a GitHub login (for example `@octocat`).
   * They stay in `logins` (and match nothing); startup warns about them.
   */
  invalidLoginEntries: readonly string[];
  /**
   * GitHub ids given in the list as `login:id`, by lower case login. The login is bound to this id
   * when the server starts, before anybody signs in. A login can appear here only once.
   */
  presetIds: ReadonlyMap<string, string>;
  /**
   * How many entries with a colon were ignored because they are not a valid `login:id` (or
   * contradict another one). Only the count is kept: the entries contain ids and are never shown.
   */
  invalidPresetEntries: number;
};

type Env = Readonly<Record<string, string | undefined>>;

// GitHub's rule for organization names: letters and digits, separated by single hyphens (no
// leading, trailing or double hyphen), up to 39 characters. The value ends up in a request path, so
// nothing else is accepted.
const ORG_NAME_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const MAX_NAME_LENGTH = 39;
// Looser than the rule for new accounts (old accounts may have double hyphens): only meant to catch
// typos such as `@octocat`, `octocat/` or a space inside the name.
const LOGIN_LIKE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
// A GitHub account id: whole number from 1 to 20 digits, no leading zero.
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

/** Reads the allow list; a problem is added to `problems` by variable name, never with the value. */
export function parseAccessConfig(env: Env, problems: string[]): AccessConfig {
  const logins = new Set<string>();
  const invalidLoginEntries: string[] = [];
  const presets = parsePresets(env.ALLOWED_GITHUB_LOGINS ?? "");
  for (const entry of (env.ALLOWED_GITHUB_LOGINS ?? "").split(",")) {
    const login = entry.trim().toLowerCase();
    // An entry with a colon is a `login:id` or invalid; it is handled by `parsePresets`.
    if (login === "" || login.includes(":")) continue;
    logins.add(login);
    if (!looksLikeLogin(login)) invalidLoginEntries.push(entry.trim());
  }
  for (const login of presets.ids.keys()) logins.add(login);
  // A login with two different ids is ambiguous: it is dropped completely, plain entries included.
  for (const login of presets.conflicting) logins.delete(login);

  const orgValue = env.ALLOWED_GITHUB_ORG?.trim() ?? "";
  let org: string | null = null;
  if (orgValue !== "") {
    if (orgValue.length <= MAX_NAME_LENGTH && ORG_NAME_PATTERN.test(orgValue))
      org = orgValue;
    else
      problems.push(
        "ALLOWED_GITHUB_ORG must be the name of a GitHub organization (letters, digits and hyphens)",
      );
  }
  return {
    logins,
    org,
    invalidLoginEntries,
    presetIds: presets.ids,
    invalidPresetEntries: presets.invalid,
  };
}

/** False when nothing is configured: then nobody may sign in. */
export function isAccessConfigured(config: AccessConfig): boolean {
  return config.logins.size > 0 || config.org !== null;
}

/** Whether `login` is on the list. GitHub logins are not case sensitive; only whole logins match. */
export function isLoginListed(config: AccessConfig, login: string): boolean {
  return config.logins.has(login.toLowerCase());
}

function looksLikeLogin(login: string): boolean {
  return login.length <= MAX_NAME_LENGTH && LOGIN_LIKE_PATTERN.test(login);
}

type Presets = {
  ids: ReadonlyMap<string, string>;
  invalid: number;
  /** Logins that were given two different ids. */
  conflicting: ReadonlySet<string>;
};

// Reads the entries of the form `login:id`. An entry that is not valid is counted and ignored (it
// admits nobody), never reported with its text: it contains an id. A login that is given two
// different ids is ambiguous: every entry of it is counted as invalid and the login gets no id, so
// the result does not depend on the order of the entries.
function parsePresets(value: string): Presets {
  const idsByLogin = new Map<string, string[]>();
  let invalid = 0;
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed.includes(":")) continue;
    const parts = trimmed.split(":");
    const login = (parts[0] ?? "").toLowerCase();
    const id = parts[1] ?? "";
    if (
      parts.length !== 2 ||
      !looksLikeLogin(login) ||
      !GITHUB_ID_PATTERN.test(id)
    ) {
      invalid += 1;
      continue;
    }
    idsByLogin.set(login, [...(idsByLogin.get(login) ?? []), id]);
  }
  const ids = new Map<string, string>();
  const conflicting = new Set<string>();
  for (const [login, given] of idsByLogin) {
    const first = given[0] ?? "";
    if (given.every((id) => id === first)) ids.set(login, first);
    else {
      conflicting.add(login);
      invalid += given.length;
    }
  }
  return { ids, invalid, conflicting };
}
