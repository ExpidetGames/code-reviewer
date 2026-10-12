// SPDX-License-Identifier: Apache-2.0

// What the UI may know about the GitHub App besides whether its settings work (that is asked of
// `findGithubAppConfigProblem` in registry.ts): the app's URL name when it is set and well formed,
// and where a person installs the app. Lives in the provider folder because it reads the provider's
// variables; the rest of the app gets it through the registry (src/integrations/README.md, "The
// boundary").
type Env = Readonly<Record<string, string | undefined>>;

// The same rule as the provider's configuration (GITHUB_APP_SLUG), so a slug used for a link is
// always one the app itself would accept.
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export function githubAppSlug(env: Env): string | null {
  const slug = env.GITHUB_APP_SLUG?.trim();
  return slug !== undefined && SLUG_PATTERN.test(slug) ? slug : null;
}

/**
 * Where a person installs the GitHub App (github.com/apps/<slug>/installations/new), or null while
 * the slug is not set. It always points at github.com: the test endpoints only replace the API.
 */
export function githubAppInstallUrl(env: Env): string | null {
  const slug = githubAppSlug(env);
  return slug === null
    ? null
    : `https://github.com/apps/${slug}/installations/new`;
}

/** The same address for a slug that is already known to be well formed (it comes from the database). */
export function githubAppInstallUrlFor(slug: string): string | null {
  return SLUG_PATTERN.test(slug)
    ? `https://github.com/apps/${slug}/installations/new`
    : null;
}

/**
 * The installation page of the App on GitHub's web address (`webBaseUrl` is github.com, or the fake's address in
 * the test stack), for a slug that is well formed; null otherwise. The binding of an installation to a workspace
 * sends the person here with a signed `state` that comes back to the App's setup URL.
 */
export function githubAppInstallPageUrl(
  webBaseUrl: string,
  slug: string,
): string | null {
  return SLUG_PATTERN.test(slug)
    ? `${webBaseUrl.replace(/\/+$/, "")}/apps/${slug}/installations/new`
    : null;
}
