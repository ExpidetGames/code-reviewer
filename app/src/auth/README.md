# Sign in

GitHub is the only way in. [Better Auth](https://www.better-auth.com) runs the OAuth flow and keeps
sessions in the SQLite database (tables `users`, `sessions`, `accounts`, `verifications`, created by
migration `0002_create_auth_tables`, see `src/db/README.md`).

| File                             | Role                                                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                      | Reads `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` (and the test-only `GITHUB_OAUTH_BASE_URL`, `GITHUB_API_BASE`). Reports problems by variable name only.        |
| `startup.ts`                     | `checkAuthConfigOnStart`: called from `src/instrumentation.ts`; an incomplete configuration ends the start with one line and exit code 1.                                                                            |
| `auth.ts`                        | `createAuth` builds the Better Auth instance (30 day sessions, snake_case column mapping, tokens encrypted at rest, secure cookies in production). `getAuth()` is the lazy per-process instance.                     |
| `github-provider.ts`             | The GitHub OAuth app as a Better Auth provider (token exchange, `/user`, `/user/emails`, timeouts). Better Auth's built-in GitHub provider hard-codes the GitHub URLs, so the fake GitHub could not be used with it. |
| `access.ts`                      | The pure rule: `PUBLIC_PATHS` and `decideAccess`. Default deny.                                                                                                                                                      |
| `access-policy.ts`               | The hook for CR-19 (who may use this instance). Today everybody who signs in may.                                                                                                                                    |
| `access-proxy.ts`, `../proxy.ts` | The Next.js proxy: every request without a valid session is turned away (pages: redirect to `/login`, `/api/**`: 401). The session is looked up in the database on every request.                                    |
| `session-user.ts`, `session.ts`  | `getSessionUser` (headers to user, through the access policy) and `requireUser()` for pages and server actions (the second check behind the proxy).                                                                  |
| `http.ts`                        | What of Better Auth's HTTP interface is reachable at `/api/auth/*`: only `POST sign-in/social`, `GET callback/github`, `POST sign-out`.                                                                              |
| `actions.ts`                     | The server actions behind the "Sign in with GitHub" and "Sign out" buttons.                                                                                                                                          |
| `login-errors.ts`                | Error code in the login URL to English copy.                                                                                                                                                                         |

## Public paths

Everything needs a session except `/login`, `/api/health`, `/api/auth/**`, `/api/runners/**` (own
token) and `/api/webhooks/**` (own signature). The list is `PUBLIC_PATHS` in `access.ts`; a route
that is not on it is protected, including routes that do not exist yet. The test
`protection.integration.test.ts` reads the routes from the file system and fails when a route is
neither listed as public nor as protected there.

## Decisions worth knowing

- Sessions last 30 days from the sign in and are not extended by use (the proxy does not set
  cookies, so an extension could not reach the browser).
- No cookie cache: every request checks the session row, so signing out or deleting a row takes
  effect at once.
- `users.github_login` is written from the GitHub profile at every sign in (`overrideUserInfo`) and
  nowhere else (`/update-user` is not reachable). The identity is the GitHub id in
  `accounts.account_id`, so a renamed GitHub account keeps its user.
- An account without any readable email gets `<github id>@users.noreply.github.com`, marked
  unverified.
- The GitHub access token is kept (encrypted with `BETTER_AUTH_SECRET`) for the organization check
  of CR-19; nothing reads it yet.
- Better Auth skips its origin and CSRF checks when `NODE_ENV` is `test`. `auth.ts` switches them
  on explicitly so the tests run what production runs.
- The pages read the session behind a `<Suspense>` boundary (Cache Components); route handlers call
  `connection()` before touching the database so `next build` never runs them.

## Changing the Better Auth configuration

A new option or plugin can need a new column. `schema-drift.integration.test.ts` asks Better Auth
for the migration it would run; after our migrations that plan must be empty. When it is not, add a
migration to `src/db/migrations/` (never run Better Auth's own migration at start-up).
