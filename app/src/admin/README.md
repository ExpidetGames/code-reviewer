# Admin portal

The instance admin's area at `/admin`: the settings of the whole instance, and the one safe place for its
credentials. The decision is in `docs/decisions/0001-editions-setup-and-accounts.md`, sections 2.3 and 2.7;
the first-run setup that creates the admin is `src/setup/`.

| File                                | Role                                                                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths.ts`                          | `isAdminPath`: which request paths belong to the portal (any spelling Next.js would route there)                                                                                                   |
| `access.ts`, `session.ts`           | Who may enter: `adminAccessOf` (admin, anonymous, not an admin), `lookupAdmin` and `requireAdmin` for the code that runs inside a request                                                          |
| `service.ts`                        | The typed settings service: `readSettings` (every setting with who and when, the secret statuses, the facts of the overview) and the four changes (tenancy, sign-up rule, ways to sign in, limits) |
| `tenancy.ts`                        | The change of the tenancy, one transaction (the rules below)                                                                                                                                       |
| `sign-in-methods.ts`                | The rules for the ways to sign in, and what is actually on (`effectiveSignInMethods`)                                                                                                              |
| `sign-up-rule-state.ts`             | Whether an email or domain rule is fail-closed right now (no mail server, and sign-in is not GitHub only)                                                                                          |
| `http.ts`, `errors.ts`, `shared.ts` | The handlers of `GET\|PUT /api/admin/settings`, their stable error codes, and the wiring of the running server                                                                                     |
| `ui/`                               | The pages' building blocks: navigation, overview, the four forms, the copy for the error codes. Pages: `src/app/(app)/admin/`                                                                      |

The command line for a lost admin password is `src/admin-cli/` (below).

## Who gets in

- Not signed in: a page redirects to the sign-in, a data route answers `401`, exactly as for any other
  path that does not exist.
- Signed in, not an instance admin: **the answer of a path that does not exist**, in every detail. This is
  by construction, not by imitation: `/admin/**` and `/api/admin/**` are not routes of the app. The files
  of the portal live below `/instance-portal` and `/api/instance-portal`, and only the proxy
  (`src/auth/access-proxy.ts`) rewrites the instance admin's request there (`paths.ts`,
  `portalRewriteTarget`). For everybody else the request goes on untouched and Next.js answers it itself:
  same status, same headers (including the `Cache-Control` that keeps it out of shared caches), same
  behavior for an RSC request, a prefetch, a write and a posted Server Function, and no rewrite header.
  A 404 built by hand, or a rewrite to a not-found route, would show (`x-middleware-rewrite`,
  `x-nextjs-rewritten-path`, a year of shared caching of the prerendered not-found); the e2e journey
  compares the full header set and body against a missing path.
- Next.js runs the proxy a second time on the path a rewrite leads to. The admin's rewrite carries a header
  with a value only that process knows (`PORTAL_REWRITE_HEADER`), so the files by their own address
  (`/instance-portal`) are answered as a missing path for everybody, the admin included.
- The admin keeps access with an unverified email address, so that a mail problem can always be fixed.
- Taking the admin flag away takes effect on the next request (the session lookup reads it every time).

The proxy is not the only guard. Every page and the layout call `requireAdmin()` (a person who is not an
admin gets `notFound()`, `session.test.ts` runs every page as such a person), every data route hands
`lookupAdmin` to `createAdminRouteHandlers`, which checks it before anything is read (401 for nobody, the
Next.js `notFound()` for somebody who is not an admin). `portal-guards.test.ts` fails for a page or route
that forgot it, and for a file of Server Functions inside the portal's folders (the portal has none: its
forms call the data route, which is also where the cross-site check lives).

## The settings

Stored in `instance_settings` (JSON values; `updated_by` and `updated_at` on every row, shown under each
setting). Nothing saved reads as the default.

| Setting                   | Values                                        | Rules                                                                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenancy`                 | `single`, `multi`                             | single to multi always; multi to single only while at most one workspace exists (none: the default workspace is created and the acting admin is its Owner), otherwise `too_many_workspaces` with the count. The count and the write are one transaction.                         |
| `sign_up_rule`            | `everyone`, a list of emails, allowed domains | Always changeable; same validation as the wizard. Affects new accounts and invitations only. A rule that names emails or domains shows a notice while it is fail-closed. Stored and shown only until the sign-up rules issue enforces it.                                        |
| `sign_in_methods`         | `{ emailPassword, github }`                   | At least one stays on (`at_least_one_method`); GitHub only while configured (`github_not_configured`); GitHub only needs a linked GitHub identity of the acting admin (`admin_needs_github_identity`). Enforced at the sign-in (`src/auth/http.ts`, the login page and actions). |
| `max_workspaces_per_user` | integer 1 to 1000, default 10                 | Stored here, enforced by the workspaces issue.                                                                                                                                                                                                                                   |

Two admins saving the same setting at once end with one complete write (one statement per setting): the
value and the admin belong together.

### Tenancy and workspaces

`src/workspaces/create-workspace.ts` (`createWorkspaceUnderTenancy`) is the one place that creates a
workspace for a user: it reads the tenancy in the same transaction that inserts the workspace, and refuses
on a single-tenant instance. The switch to single-tenant counts the workspaces in its transaction. On SQLite
every transaction takes the write lock when it begins (`BEGIN IMMEDIATE`, set in `src/db/dialect.ts`), so the two cannot interleave and an instance never
ends up single-tenant with two workspaces (`tenancy-race.integration.test.ts` races two real processes).
A Postgres port needs a row lock on the tenancy setting in both places.

### The ways to sign in

`effectiveSignInMethods` is what is actually on. Nothing saved: email with password, and GitHub where it is
configured. GitHub that is switched on but not configured offers nothing. If that would leave no way in
(a saved GitHub only whose configuration is gone), email with password stays on, so nobody is locked out.
"GitHub is configured" is the GitHub OAuth app of the environment today (`src/auth/sign-in-methods.ts`); the
GitHub issue of the portal moves it into the database and changes only `getAdminService()`.

## The secret store

`src/secrets/`: table `secrets` (name, ciphertext, nonce, key version, optional last four characters,
`updated_by`, `updated_at`) on top of `src/crypto/`.

- Encryption as in the decision record: a key per purpose from `APP_SECRET` (HKDF-SHA256), AES-256-GCM, a
  random 96-bit nonce per save, the table, the name (the row id) and the field as additional authenticated
  data, so a ciphertext copied to another name does not decrypt. The names are a closed list
  (`secrets/names.ts`); a feature that stores a credential adds its name.
- `save`, `status` / `statuses` ("is configured") and `use` (inside the server). **Nothing returns a value
  through an API or a page.** `use` hands out a `SecretValue` that prints as `[secret]` in a string, JSON or
  `console.log`; `reveal()` is the one way to the value. A status can carry the last four characters, only
  when the caller asked at save time and the value has at least 16 characters.
- A secret that cannot be decrypted (a changed row, another `APP_SECRET`, an unknown key version) is the
  state `undecryptable` with the code `secret_undecryptable` or `secret_key_version_unknown`. Nothing throws
  and nothing logs; the overview tells the admin to enter it again.
- There is no HTTP route that saves a secret yet; the mail and GitHub forms of the next issues use the store.

## A lost admin password

`docker compose exec app admin reset-password <email>` (`src/admin-cli/`, the image puts the short name
`admin` on the PATH; without it `node admin-cli/cli.ts reset-password <email>`). It prints a single-use link
valid for 30 minutes: a random 256-bit token, stored only as a SHA-256 hash in `password_reset_tokens`. A
new link replaces the unused ones of the account. The link opens `/reset-password`, which posts to
`POST /api/password-reset` (`src/auth/password-reset*.ts`): the new password must pass the password rule,
the token is used up by one statement, and every session of the account ends in the same transaction. An
unknown, used, expired or changed token gets one answer, `invalid_token`. The route is public (the token is
the credential). It is rate limited per link, not for the instance: attempts against a token that exists
are counted in `rate_limits` (key `password-reset:<hash>`, 10 in the 30 minutes a link lives); a token that
does not exist gets the same generic answer and touches no counter, so junk requests cannot lock the
operator out of the recovery path. With a mail server the reset mail of the SMTP issue ends in the same function.

If the admin had switched email with password sign-in off, the command switches it back on, prints one line
saying so, and records the system (`updated_by` null) as the one who changed it: a new password is of no
use otherwise, and the shell operator is trusted with exactly this recovery.

The command runs without Next.js and imports only its own folder and better-sqlite3, like `src/backup/`.

## Tests

- `guard.integration.test.ts`: the proxy and the data route with real requests, a real database and Better
  Auth: anonymous, not an admin (every route, every method, odd spellings, a Server Function, the route
  without the proxy), the admin, an unverified admin. `portal-guards.test.ts` finds a file without a guard.
- `http.integration.test.ts`, `service.integration.test.ts`, `tenancy.integration.test.ts`,
  `tenancy-race.integration.test.ts`: the settings, their rules, the concurrency and what is never in an
  answer or a log line. `src/secrets/store.integration.test.ts` and `secret-value.test.ts`: the store.
- `src/admin-cli/*.test.ts`, `src/auth/password-reset.integration.test.ts`: the lost password.
- `ui/*.test.tsx`: the forms, the overview and the navigation. Journey: `e2e/admin/admin-portal.e2e.ts`.
- The image smoke test (`docker/smoke/app.sh`) runs `admin reset-password` in the built image.
