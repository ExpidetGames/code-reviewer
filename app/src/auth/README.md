# Sign in

GitHub is the only way in. [Better Auth](https://www.better-auth.com) runs the OAuth flow and keeps
sessions in the SQLite database (tables `users`, `sessions`, `accounts`, `verifications`, created by
migration `20261010123800_create_auth_tables`, plus `users.org_checked_at` from
`20261010125500_add_user_org_checked_at`, see `src/db/README.md`).

| File                             | Role                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                      | Reads `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` (and the test-only `GITHUB_OAUTH_BASE_URL`, `GITHUB_API_BASE`, which are refused unless `ALLOW_TEST_GITHUB_ENDPOINTS=true` is set too). Reports problems by variable name only. |
| `startup.ts`                     | `checkAuthConfigOnStart`: called from `src/instrumentation.ts`; an incomplete configuration ends the start with one line and exit code 1.                                                                                                                                             |
| `auth.ts`                        | `createAuth` builds the Better Auth instance (30 day sessions, snake_case column mapping, tokens encrypted at rest, secure cookies when `BETTER_AUTH_URL` is https). `getAuth()` is the lazy per-process instance.                                                                    |
| `github-provider.ts`             | The GitHub OAuth app as a Better Auth provider (token exchange, `/user`, timeouts). Better Auth's built-in GitHub provider hard-codes the GitHub URLs, so the fake GitHub could not be used with it.                                                                                  |
| `access.ts`                      | The pure rule: `PUBLIC_PATHS` and `decideAccess`. Default deny.                                                                                                                                                                                                                       |
| `access-config.ts`               | Reads `ALLOWED_GITHUB_LOGINS` and `ALLOWED_GITHUB_ORG` (part of `config.ts`) and matches a login against the list: case-insensitive, whole logins only.                                                                                                                               |
| `access-policy.ts`               | The rule applied on every authenticated request (`createAccessPolicy`): listed login, or organization member checked at most every 24 hours, otherwise no. Returns a decision with a reason.                                                                                          |
| `access-runtime.ts`              | Wires the policy for the running server: the stored (decrypted) GitHub token, the membership call, `orgCheckedAt`, ending sessions. `getAccessPolicy()` is the per-process instance.                                                                                                  |
| `github-org.ts`                  | `GET /user/memberships/orgs/{org}` with the user's token; answers `member`, `not_member`, `token_invalid` or `unavailable`.                                                                                                                                                           |
| `sign-in-access.ts`              | The decision made while a sign in is completed (`decideSignIn`), and how it travels from the GitHub provider to Better Auth's gate.                                                                                                                                                   |
| `access-proxy.ts`, `../proxy.ts` | The Next.js proxy: every request without a valid session is turned away (pages: redirect to `/login`, `/api/**`: 401). The session is looked up in the database on every request.                                                                                                     |
| `session-user.ts`, `session.ts`  | `lookupSession` (headers to user, through the access policy; says `user`, `none` or `denied` with the reason) and `requireUser()` for pages and server actions (the second check behind the proxy).                                                                                   |
| `http.ts`                        | What of Better Auth's HTTP interface is reachable at `/api/auth/*`: only `POST sign-in/social`, `GET callback/github`, `POST sign-out`.                                                                                                                                               |
| `actions.ts`                     | The server actions behind the "Sign in with GitHub" and "Sign out" buttons.                                                                                                                                                                                                           |
| `login-errors.ts`                | Error code in the login URL to English copy (including `not_allowed`, `check_failed`, `sign_in_again`).                                                                                                                                                                               |

## Who may use the instance

Signing in with GitHub is not enough; the account must be allowed. Two settings, both optional,
at least one needed (`app/.env.example`):

- `ALLOWED_GITHUB_LOGINS`: comma separated logins. Not case sensitive, spaces and empty entries
  are ignored, only whole logins match (`octocat` does not admit `octocat-evil`).
- `ALLOWED_GITHUB_ORG`: members of this GitHub organization (an active membership, an invitation
  does not count). The sign in then also requests the `read:org` scope; without this setting it
  asks for `read:user` only.

If both are set, either one is enough. If neither is set, nobody is allowed (fail closed): the
server starts, logs one `ACCESS_LIST_EMPTY` warning, and every sign in is refused. An
`ALLOWED_GITHUB_ORG` that is not a valid organization name stops the start like any other invalid
setting.

**At sign in** the decision is made in `getUserInfo` of the GitHub provider, which has the profile
and the freshly issued token, and is attached to the profile. Better Auth's `user.validateUserInfo`
gate (`auth.ts`) then refuses before it creates a user, links an account or opens a session, and
before it replaces the stored token of an existing user. So a refused person leaves nothing behind
(`allow-list.integration.test.ts` checks the three tables). They land on `/login?error=<code>`:

| Code            | Meaning                                                 | Copy (`login-errors.ts`)                                               |
| --------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `not_allowed`   | Not on the list and not in the organization             | Your GitHub account is not allowed to use this Code Reviewer instance. |
| `check_failed`  | The organization could not be asked (403, 5xx, timeout) | We could not check whether ... Please try again later.                 |
| `sign_in_again` | The stored token no longer works (request time only)    | Your GitHub authorization is no longer valid. Please sign in again.    |

The copy never names who is allowed.

**On every request** (`access-policy.ts`, behind both the proxy and `requireUser`):

- A listed login is allowed, checked every time against the login stored at the last sign in.
  Removing a login from `ALLOWED_GITHUB_LOGINS` and restarting the server therefore takes effect on
  the next request of every signed in person: pages redirect to `/login?error=not_allowed`, data
  routes answer 403 `{"error":"ACCESS_DENIED","reason":"not_allowed"}`.
- Otherwise, in organization mode, a membership confirmed less than 24 hours ago
  (`users.org_checked_at`, written at sign in and by the re-check) counts. After that the next
  request asks GitHub again with the person's stored (decrypted) token; requests of the same person
  that arrive together share one call. Member: the time is updated. Not a member: all their sessions
  are ended and they are turned away (`not_allowed`). Token rejected (401): sessions ended,
  `sign_in_again`. GitHub cannot be asked (403, 5xx, timeout, odd answer): this request is turned
  away (`check_failed`), the sessions stay and the next request tries again. Nothing is let through
  on a doubt.
- With neither setting, nobody passes.

Things to know: the allow list is by login, which is a name and not an identity. If a listed person
renames their GitHub account and somebody else takes the old name, that person matches the list;
use the organization if that matters. A listed person who renames keeps their user (the identity is
the GitHub id) but is matched by the login stored at their last sign in until they sign in again.
Organizations that restrict third-party OAuth apps must approve this app, otherwise GitHub hides
the membership and everybody is refused (`not_allowed`, or `check_failed` on a 403). Changing the
settings needs a restart of the server (they are read once per process).

## Public paths

Everything needs a session except `/login`, `/api/health`, `/api/auth/**`, `/api/runners/**` (own
token) and `/api/webhooks/**` (own signature). The list is `PUBLIC_PATHS` in `access.ts`; a route
that is not on it is protected, including routes that do not exist yet. The test
`protection.integration.test.ts` reads the routes from the file system and fails when a route is
neither listed as public nor as protected there.

## Decisions worth knowing

- `BETTER_AUTH_SECRET` signs the session cookie and encrypts the stored GitHub access token.
  Rotating it signs everybody out and makes the stored tokens unreadable; they are replaced at the
  next sign in. The organization re-check needs a readable token: after a rotation, organization
  members are asked to sign in again (`sign_in_again`) when their 24 hours are over.
- Cookies are `Secure` exactly when `BETTER_AUTH_URL` is https. In production the server refuses to
  start with a plain http address unless it is localhost, because browsers drop `Secure` cookies over
  http and the sign in would loop with `state_mismatch`.
- Sessions last 30 days from the sign in and are not extended by use (the proxy does not set
  cookies, so an extension could not reach the browser).
- No cookie cache: every request checks the session row, so signing out or deleting a row takes
  effect at once.
- `users.github_login` is written from the GitHub profile at every sign in (`overrideUserInfo`) and
  nowhere else (`/update-user` is not reachable). The identity is the GitHub id in
  `accounts.account_id`, so a renamed GitHub account keeps its user.
- The user is the GitHub account, never an email address: account linking is off. Otherwise a
  second GitHub account that reports the same verified email (the first one gave it up) would be
  linked to the first account's user and inherit its access.
- `users.email` is always `<github id>@users.noreply.github.com`, marked unverified. The real
  address is never read (no `user:email` scope, no call to `/user/emails`): the app does not need
  it, the column is UNIQUE, and a failing optional call must not change stored data.
- The GitHub access token is kept (encrypted with `BETTER_AUTH_SECRET`) for the 24 hour
  organization re-check (`access-runtime.ts`); nothing else reads it.
- Better Auth skips its origin and CSRF checks when `NODE_ENV` is `test`. `auth.ts` switches them
  on explicitly so the tests run what production runs.
- The pages read the session behind a `<Suspense>` boundary (Cache Components); route handlers call
  `connection()` before touching the database so `next build` never runs them.

## Rule: the proxy is not the only guard

A Server Function is a POST to the page it lives on, so the proxy lets it through when the page is
public (for example `/login`) and stops seeing it if the matcher changes. Therefore every protected
Server Function and every protected Route Handler calls `requireUser()` itself, before it touches
data. `guard-rule.test.ts` fails for a route handler that is not public, or a file of Server
Functions, that does not call it; the Server Function files that are public on purpose
(`actions.ts`: start the sign in, sign out) are listed in that test.

## Not done yet

Expired `sessions` and `verifications` rows (every `POST /api/auth/sign-in/social` writes a state
row) are never pruned. Fine for the MVP; a cleanup job belongs to the operations work (CR-40).

## Changing the Better Auth configuration

A new option or plugin can need a new column. `schema-drift.integration.test.ts` asks Better Auth
for the migration it would run; after our migrations that plan must be empty. When it is not, add a
migration to `src/db/migrations/` (never run Better Auth's own migration at start-up).
