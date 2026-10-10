# Sign in

GitHub is the only way in. [Better Auth](https://www.better-auth.com) runs the OAuth flow and keeps
sessions in the SQLite database (tables `users`, `sessions`, `accounts`, `verifications`, created by
migration `20261010123800_create_auth_tables`, plus `users.org_checked_at` and `users.org_checked_for`
from `20261010125500_add_user_org_checked_at` and `20261010131500_add_user_org_checked_for`, and our own
table `allowed_login_pins` from `20261010133000_create_allowed_login_pins`, see `src/db/README.md`).

| File                             | Role                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                      | Reads `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` (and the test-only `GITHUB_OAUTH_BASE_URL`, `GITHUB_API_BASE`, which are refused unless `ALLOW_TEST_GITHUB_ENDPOINTS=true` is set too). Reports problems by variable name only. |
| `startup.ts`                     | `checkAuthConfigOnStart`: called from `src/instrumentation.ts`; an incomplete configuration ends the start with one line and exit code 1. `syncLoginPinsOnStart` runs after the migrations and brings the login bindings in line with the list.                                       |
| `auth.ts`                        | `createAuth` builds the Better Auth instance (30 day sessions, snake_case column mapping, tokens encrypted at rest, secure cookies when `BETTER_AUTH_URL` is https). `getAuth()` is the lazy per-process instance.                                                                    |
| `github-provider.ts`             | The GitHub OAuth app as a Better Auth provider (token exchange, `/user`, timeouts). Better Auth's built-in GitHub provider hard-codes the GitHub URLs, so the fake GitHub could not be used with it.                                                                                  |
| `access.ts`                      | The pure rule: `PUBLIC_PATHS` and `decideAccess`. Default deny.                                                                                                                                                                                                                       |
| `access-decision.ts`             | The refusal reasons and the decision shapes shared by the sign in and the request check.                                                                                                                                                                                              |
| `access-config.ts`               | Reads `ALLOWED_GITHUB_LOGINS` and `ALLOWED_GITHUB_ORG` (part of `config.ts`) and matches a login against the list: case-insensitive, whole logins only. Also reads the `login:id` entries (the pre-set ids).                                                                          |
| `login-pins.ts`                  | A listed login is bound to a GitHub id: `checkLoginPin` binds the id of the first account that uses the login and says `match`, `mismatch` or `unavailable`. The rows are in `allowed_login_pins` (`db/repositories/allowed-login-pins-repository.ts`).                               |
| `access-policy.ts`               | The rule applied on every authenticated request (`createAccessPolicy`): listed login of the account it is bound to, or organization member checked at most every 24 hours, otherwise no. Returns a decision with a reason.                                                            |
| `access-runtime.ts`              | Wires the policy for the running server: the stored (decrypted) GitHub token, the membership call, `orgCheckedAt`, ending sessions. `getAccessPolicy()` is the per-process instance.                                                                                                  |
| `github-org.ts`                  | `GET /user/memberships/orgs/{org}` with the user's token; answers `member`, `not_member`, `token_invalid` or `unavailable`.                                                                                                                                                           |
| `sign-in-access.ts`              | The decision made while a sign in is completed (`decideSignIn`), and how it travels from the GitHub provider to Better Auth's gate.                                                                                                                                                   |
| `access-proxy.ts`, `../proxy.ts` | The Next.js proxy: every request without a valid session is turned away (pages: redirect to `/login`, `/api/**`: 401). The session is looked up in the database on every request.                                                                                                     |
| `session-user.ts`, `session.ts`  | `lookupSession` (headers to user, with the GitHub id from the account row, through the access policy; says `user`, `none` or `denied` with the reason) and `requireUser()` for pages and server actions (the second check behind the proxy).                                          |
| `http.ts`                        | What of Better Auth's HTTP interface is reachable at `/api/auth/*`: only `POST sign-in/social`, `GET callback/github`, `POST sign-out`.                                                                                                                                               |
| `actions.ts`                     | The server actions behind the "Sign in with GitHub" and "Sign out" buttons.                                                                                                                                                                                                           |
| `login-errors.ts`                | Error code in the login URL to English copy (including `not_allowed`, `check_failed`, `sign_in_again`).                                                                                                                                                                               |

## Who may use the instance

Signing in with GitHub is not enough; the account must be allowed. Two settings, both optional,
at least one needed (`app/.env.example`):

- `ALLOWED_GITHUB_LOGINS`: comma separated logins, each optionally with the GitHub id it belongs to
  (`octocat:583231`, see "A login is bound to a GitHub account" below). Not case sensitive, spaces
  and empty entries are ignored, only whole logins match (`octocat` does not admit `octocat-evil`).
  An entry that cannot be a login (`@octocat`, a space inside) or a valid `login:id` matches
  nobody, and startup logs one `ACCESS_LIST_ENTRY_INVALID` warning (it names plain entries, shortened,
  but only counts `login:id` entries: no id is ever printed).
- `ALLOWED_GITHUB_ORG`: members of this GitHub organization (an active membership, an invitation
  does not count). The name follows GitHub's rule (letters and digits, single hyphens between). The sign in then also requests the `read:org` scope; without this setting it
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

### A login is bound to a GitHub account

A login is a name, not an identity: GitHub frees an old username after a rename, and somebody else
can register it and would match the list. Therefore a listed login is bound ("pinned") to the numeric
GitHub id of one account, in `allowed_login_pins(login, github_id, pinned_at)` (`login` lower case).

- **At sign in** (`sign-in-access.ts`), only for a login on the list: `INSERT ... ON CONFLICT DO
NOTHING`, then the stored id is compared with the id of the account. The first account to sign in
  with a listed login binds it; any other account with that login is refused (`not_allowed`, the same
  copy as for an unlisted login, so a stranger cannot tell the two apart) before a user, account or
  session is written and before a stored token is replaced. Two accounts signing in at the same moment
  cannot both win: the insert is atomic and the loser sees the winner's id. Logins that are not
  listed never write a row.
- **On every request** (`access-policy.ts`): the same comparison, with the id of the signed in
  account (`accounts.account_id`, read by `lookupSession` into `SessionUser.githubId`). A session
  without a binding yet (signed in before this existed, or the row was removed) binds the login to its
  account on its next request. A mismatch ends all sessions of that user and answers `not_allowed`
  (page: redirect to `/login?error=not_allowed`, data route: 403); the requests after that carry no
  valid session any more and get the plain 401 / redirect. If the binding cannot be read or written
  the request is refused with `check_failed` (also when an organization is configured: the
  organization is not asked instead), no session is ended, and one `LOGIN_PIN_UNAVAILABLE` line is
  logged without any login or id.
- **At start** (`syncLoginPinsOnStart`, after the migrations): bindings of logins that are no longer
  on the list are deleted, so removing a login and adding it again resets its binding. An id given as
  `login:id` is written then, before anybody signs in, and replaces a different stored id (one info
  line `LOGIN_PIN_PRESET_APPLIED`, without values). That closes the gap of an impostor who signs in
  first; a login without an id is bound at its first sign in (trust on first use).
  With no logins list at all (organization mode only) the start does not touch the table: bindings
  that are still there stay until a list is configured again, which then deletes those of logins
  that are not on it.
- `login:id`: the id is 1 to 20 digits without a leading zero; whitespace around an entry is
  ignored. Anything else is ignored with the `ACCESS_LIST_ENTRY_INVALID` warning and admits nobody;
  so is a login given two different ids (both entries and any plain entry of it are dropped).
- Organization mode is not affected: with only `ALLOWED_GITHUB_ORG` no binding is read, written or
  deleted. With both set, organization membership alone still admits (an account whose id does not
  match the binding gets in only as a member).

**Renaming a GitHub account (the owner of a listed login).** The old binding belongs to the old login,
so: put the new login on the list (optionally as `newlogin:<id>`), remove the old one, restart the
server. At the start the binding of the old login is deleted; the new login is bound at the next sign
in (or at the start, with an id). Until the restart the renamed account is still matched by the login
stored at its last sign in. Without that change a renamed account is turned away at its next sign in,
because its new login is not listed. The same steps hand a login to a different person on purpose.

**On every request** (`access-policy.ts`, behind both the proxy and `requireUser`):

- A listed login is allowed, checked every time against the login stored at the last sign in, and
  only for the account it is bound to (see above).
  Removing a login from `ALLOWED_GITHUB_LOGINS` and restarting the server therefore takes effect on
  the next request of every signed in person: pages redirect to `/login?error=not_allowed`, data
  routes answer 403 `{"error":"ACCESS_DENIED","reason":"not_allowed"}`.
- Logins mode ends a session only for an account that carries a listed login bound to another account (above). Otherwise it never ends one: the rows stay, and the list is applied on every request, so
  a removed login is refused immediately and a login put back works again with its old session
  (intended; the sessions expire after 30 days anyway).
- Otherwise, in organization mode, a membership confirmed less than 24 hours ago
  (`users.org_checked_at` for `users.org_checked_for`, written at sign in and by the re-check) counts,
  but only for the organization that is configured now: a check made for another organization is
  ignored and asked again at once. After that the next
  request asks GitHub again with the person's stored (decrypted) token; requests of the same person
  that arrive together share one call. Member: the time is updated. Not a member: all their sessions
  are ended and they are turned away (`not_allowed`). Token rejected (401): sessions ended,
  `sign_in_again`. A token without the `read:org` scope (a person who signed in before the
  organization was configured) is the same case: GitHub names the scopes of a token in the
  `X-OAuth-Scopes` header of its answer, and a 403 or 404 for a token without `read:org` is read as
  `token_invalid`, not as an answer about the membership. (The scope stored on the account is not
  used: Better Auth writes it once, when the account is created.) GitHub cannot be asked (403, 5xx,
  timeout, odd answer): this request is turned away (`check_failed`), the sessions stay, and that
  person is not asked about again for 20 seconds (so an outage or a rate limit is not hammered), then
  the next request tries again. If the sessions or the check cannot be written, the answer is still
  a refusal, never a 500. Nothing is let through on a doubt.
- GitHub answering the membership check with a redirect (the organization was renamed or moved)
  is never followed; it is treated like an outage and logged once as `ORG_CHECK_REDIRECTED`, which
  tells you to correct `ALLOWED_GITHUB_ORG`.
- With neither setting, nobody passes.

Things to know: the allow list is by login, which is a name and not an identity; the binding to the
GitHub id (above) closes that, except for the first use of a login without a pre-set id (trust on
first use: an impostor who signs in before the real owner ever did binds the login; give the id as
`login:id` to rule that out, or use the organization). A listed person who renames keeps their user
(the identity is the GitHub id) but is matched by the login stored at their last sign in until they
sign in again.
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
