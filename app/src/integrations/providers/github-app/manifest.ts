// SPDX-License-Identifier: LicenseRef-Proprietary

// The GitHub App manifest (docs/decisions/0001-editions-setup-and-accounts.md, section 2.4): what the
// admin portal posts to GitHub so that creating the App is one click, and the list of what the App
// needs, which `docs/github-app.md` repeats for the manual way (a test keeps the two together).
//
// Every address in it is made from the configured public URL of the instance, never from a request
// header: the manifest decides where GitHub delivers webhooks and sends the person back, so a forged
// `Host` header must not be able to change it.
import { JOB_TOKEN_PERMISSIONS } from "./job-access.ts";

/** The paths of the app that GitHub is told about. */
export const GITHUB_APP_PATHS = {
  webhook: "/api/webhooks/github-app",
  /** Where GitHub sends the person back with the one-time code (the admin portal's data route). */
  manifestRedirect: "/api/admin/github/manifest/callback",
  /** The callback of the user authorization, which is the sign in with GitHub. */
  signInCallback: "/api/auth/callback/github",
  /** Where GitHub sends the person after an installation (the binding of installations to workspaces). */
  installationSetup: "/github/connected",
} as const;

/**
 * The repository permission the App itself needs for the check run of a review (#405): it creates and updates the
 * check run in the checks area of the pull request. Only the App's own token has it, never the token of a review
 * job (`JOB_TOKEN_PERMISSIONS`): the Worker does not write check runs. An installation or an App made by hand that
 * lacks it keeps reviewing; `missingPermissions` names it and no job fails because of it.
 */
export const CHECK_RUN_PERMISSIONS = { checks: "write" } as const;

/** The repository permissions of the App: what a review job gets, and the check runs the App writes itself. */
export const REPOSITORY_PERMISSIONS: Readonly<
  Record<string, "read" | "write">
> = { ...JOB_TOKEN_PERMISSIONS, ...CHECK_RUN_PERMISSIONS };

/**
 * The account permission "Email addresses": it lets a sign in with GitHub read the verified primary email
 * (`GET /user/emails`), which applies the sign-up rule and replaces the placeholder address of an imported
 * user.
 */
export const ACCOUNT_PERMISSIONS = { emails: "read" } as const;

/**
 * The organization permission "Members": it lets the binding of an installation read a person's role in
 * the organization with the user token of the App.
 */
export const ORGANIZATION_PERMISSIONS = { members: "read" } as const;

/** The events a person ticks. `installation` and `installation_repositories` are always sent. */
export const SUBSCRIBED_EVENTS = ["pull_request", "issue_comment"] as const;

/** Every permission the manifest asks for, in the flat form of `default_permissions`. */
export const MANIFEST_PERMISSIONS: Readonly<Record<string, "read" | "write">> =
  {
    ...REPOSITORY_PERMISSIONS,
    ...ACCOUNT_PERMISSIONS,
    ...ORGANIZATION_PERMISSIONS,
  };

export type GithubAppManifest = {
  name: string;
  url: string;
  hook_attributes: { url: string; active: true };
  redirect_url: string;
  callback_urls: string[];
  setup_url: string;
  setup_on_update: true;
  description: string;
  public: boolean;
  request_oauth_on_install: false;
  default_events: string[];
  default_permissions: Record<string, "read" | "write">;
};

/** GitHub's limit for the name of an App. */
export const APP_NAME_MAX_LENGTH = 34;

export type ManifestInput = {
  /** The configured public address of the instance (`BETTER_AUTH_URL`), an origin without a path. */
  publicUrl: string;
  /** Multi-tenant instances create a public App (anybody may install it), single-tenant a private one. */
  tenancy: "single" | "multi";
  name: string;
};

export function buildAppManifest({
  publicUrl,
  tenancy,
  name,
}: ManifestInput): GithubAppManifest {
  const origin = publicUrl.replace(/\/+$/, "");
  return {
    name,
    url: origin,
    hook_attributes: {
      url: `${origin}${GITHUB_APP_PATHS.webhook}`,
      active: true,
    },
    redirect_url: `${origin}${GITHUB_APP_PATHS.manifestRedirect}`,
    callback_urls: [`${origin}${GITHUB_APP_PATHS.signInCallback}`],
    setup_url: `${origin}${GITHUB_APP_PATHS.installationSetup}`,
    setup_on_update: true,
    description: "Automatic pull request reviews by code-review.com.",
    public: tenancy === "multi",
    request_oauth_on_install: false,
    default_events: [...SUBSCRIBED_EVENTS],
    default_permissions: { ...MANIFEST_PERMISSIONS },
  };
}

/**
 * The name the form starts with: "Code Reviewer" and the host of the instance, cut to what GitHub
 * accepts. The admin can change it before creating the App.
 */
export function suggestedAppName(publicUrl: string): string {
  let host = "";
  try {
    host = new URL(publicUrl).hostname;
  } catch {
    // No usable address: the plain name.
  }
  const name = host === "" ? "Code Reviewer" : `Code Reviewer ${host}`;
  return name.slice(0, APP_NAME_MAX_LENGTH).trim();
}

const LEVELS = ["read", "write", "admin"];

/**
 * What an App lacks of what the manifest asks for, by API permission name, given the `permissions` object of
 * `GET /app`. An App that was imported or made by hand may lack the repository permission "Checks", the account
 * permission "Email addresses" or the organization permission "Members"; the portal lists what to add in the
 * App's settings. A level below
 * the wanted one counts as missing.
 */
export function missingPermissions(
  granted: Readonly<Record<string, unknown>>,
): string[] {
  return Object.entries(MANIFEST_PERMISSIONS)
    .filter(
      ([name, wanted]) =>
        LEVELS.indexOf(String(granted[name])) < LEVELS.indexOf(wanted),
    )
    .map(([name]) => name);
}
