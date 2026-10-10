// The allow list: who may use this instance. Read from `ALLOWED_GITHUB_LOGINS` (comma separated
// GitHub logins) and `ALLOWED_GITHUB_ORG` (members of one GitHub organization). When both are set,
// either one is enough. When neither is set nobody is allowed (fail closed).

export type AccessConfig = {
  /** Lower case logins; never contains the empty string. */
  logins: ReadonlySet<string>;
  /** The organization whose members may use the instance, or null when org mode is off. */
  org: string | null;
};

type Env = Readonly<Record<string, string | undefined>>;

// GitHub's rule for organization and user names: letters, digits and single hyphens, up to 39
// characters, no leading hyphen. The value ends up in a request path, so nothing else is accepted.
const ORG_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/** Reads the allow list; a problem is added to `problems` by variable name, never with the value. */
export function parseAccessConfig(env: Env, problems: string[]): AccessConfig {
  const logins = new Set<string>();
  for (const entry of (env.ALLOWED_GITHUB_LOGINS ?? "").split(",")) {
    const login = entry.trim().toLowerCase();
    if (login !== "") logins.add(login);
  }

  const orgValue = env.ALLOWED_GITHUB_ORG?.trim() ?? "";
  let org: string | null = null;
  if (orgValue !== "") {
    if (ORG_NAME_PATTERN.test(orgValue)) org = orgValue;
    else
      problems.push(
        "ALLOWED_GITHUB_ORG must be the name of a GitHub organization (letters, digits and hyphens)",
      );
  }
  return { logins, org };
}

/** False when nothing is configured: then nobody may sign in. */
export function isAccessConfigured(config: AccessConfig): boolean {
  return config.logins.size > 0 || config.org !== null;
}

/** Whether `login` is on the list. GitHub logins are not case sensitive; only whole logins match. */
export function isLoginListed(config: AccessConfig, login: string): boolean {
  return config.logins.has(login.toLowerCase());
}
