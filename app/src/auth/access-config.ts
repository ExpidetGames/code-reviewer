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

/** Reads the allow list; a problem is added to `problems` by variable name, never with the value. */
export function parseAccessConfig(env: Env, problems: string[]): AccessConfig {
  const logins = new Set<string>();
  const invalidLoginEntries: string[] = [];
  for (const entry of (env.ALLOWED_GITHUB_LOGINS ?? "").split(",")) {
    const login = entry.trim().toLowerCase();
    if (login === "") continue;
    logins.add(login);
    if (!looksLikeLogin(login)) invalidLoginEntries.push(entry.trim());
  }

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
  return { logins, org, invalidLoginEntries };
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
