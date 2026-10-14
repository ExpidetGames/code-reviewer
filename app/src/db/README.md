# Database layer

Kysely on SQLite (better-sqlite3). The whole layer lives in this folder; nothing else in the app
opens a database or writes SQL. The one exception is `src/backup/` (backup and restore: `VACUUM INTO`,
`integrity_check`, a command line that runs without Next.js; see its README).

| File                        | Role                                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                 | Reads `DATABASE_URL` (SQLite or Postgres), `DATABASE_PATH` and `DATABASE_BUSY_TIMEOUT_MS` / `DATABASE_POOL_MAX` from the environment; `describeDatabaseTarget` is the safe form for a log line                                                                      |
| `connection.ts`             | `openDatabase(config)`: SQLite (checks the directory, opens the file, sets the pragmas) or Postgres (`postgres.ts`)                                                                                                                                                 |
| `postgres.ts`               | Kysely's Postgres dialect over the `pg` driver's pool (with a connect timeout, so an exhausted pool fails), the startup reachability check (`assertPostgresReachable`) and the dedicated advisory-lock connection (`withPostgresAdvisoryLock`, never the main pool) |
| `driver.ts`                 | `databaseDriver(db)`: which engine a connection speaks, for the one dialect-specific statement (the claim)                                                                                                                                                          |
| `dialect.ts`                | Kysely's SQLite dialect with `begin immediate` transactions and transactional DDL                                                                                                                                                                                   |
| `migrate.ts`, `migrations/` | `migrateToLatest(db)` and the ordered list of migrations                                                                                                                                                                                                            |
| `startup.ts`                | What the server does on start; `getDatabase()` hands the connection out                                                                                                                                                                                             |
| `schema.ts`                 | Row types of every table (`Database`)                                                                                                                                                                                                                               |
| `codecs.ts`                 | The only code that knows how JSON, booleans and timestamps are stored                                                                                                                                                                                               |
| `repositories/`             | One small module per table (or aggregate); the only code that queries it. Exception: `users`, `sessions`, `accounts` and `verifications` belong to Better Auth (`src/auth/`)                                                                                        |
| `workspace-scope.ts`        | `WorkspaceId`, the type of the workspace parameter every scoped repository takes (see "Workspace scoping")                                                                                                                                                          |
| `errors.ts`                 | `DatabaseError` with stable codes (`DATABASE_CONFIG_INVALID`, `DATABASE_DIRECTORY_UNAVAILABLE`, `DATABASE_OPEN_FAILED`, `DATABASE_LOCKED`, `MIGRATION_FAILED`)                                                                                                      |

## Why better-sqlite3

Kysely needs a driver, and its own SQLite dialect is built for better-sqlite3. It is the most
widely used and actively maintained SQLite driver for Node, is synchronous (no connection pool to
reason about for a single-file database), ships prebuilt binaries for Node 24, and Next.js already
lists it in its default `serverExternalPackages`, so it works in the server bundle without extra
configuration. The alternative, Node's built-in `node:sqlite`, has no Kysely dialect yet.
`pnpm-workspace.yaml` allows its install script (`onlyBuiltDependencies`) so the native binary is
available after `pnpm install --frozen-lockfile`.

## SQLite and Postgres

`DATABASE_URL` selects the engine (docs/decisions/0001-editions-setup-and-accounts.md, section 2.1;
docs/deployment-large.md): empty, a path or a `sqlite:` URL means SQLite (the default file stays
`/data/app.db`), `postgres://` or `postgresql://` means an external Postgres. `DATABASE_PATH` keeps
working for installations that never set `DATABASE_URL`. An invalid value stops the start with
`DATABASE_CONFIG_INVALID`; the message never repeats the URL (a Postgres URL carries the password).

The schema, the migrations, the codecs and the query builder are the same on both. A schema parity
test (`postgres.integration.test.ts`) compares the tables, columns, nullability and mapped types of
the two. What differs, and why:

- **Queue/gate transactions** take the instance gate advisory lock before repository/project and
  job rows (multi-row transitions lock jobs by ascending id). Enqueue/settings share it; gate changes
  and runner mutations take it exclusively. Disable cancels waiting Dynamic work while running
  leases stay valid; release/expiry read the gate atomically and fail instead of requeueing Dynamic
  work while off. Exact order and process-quiescence rollback boundary: `contracts/README.md`.
- The **claim** of a job (`repositories/jobs-claim.ts`): SQLite relies on its single write lock and
  `begin immediate`, Postgres on `FOR UPDATE SKIP LOCKED` plus the partial unique index
  `jobs_one_running_per_pull_request_unique` (present on both) and a savepoint retry when a
  concurrent claim is rejected by it.
- **Migrations** run behind Postgres' advisory lock (Kysely's own), so several instances starting at
  once take turns and each migration is applied once; a failure rolls the whole batch back
  (transactional DDL). SQLite's equivalent is its write lock (see "Migrations").
- The **backup scheduler** starts only for SQLite. With Postgres the operator backs up the database,
  one log line says so, and `/api/backup/status` reports backups as not applicable (`src/backup/`).

## SQLite: connection settings

Applied by `openDatabase` on every connection: `busy_timeout` from the configuration (default
5000 ms, set before anything else so even the switch to WAL waits for a lock), `journal_mode = WAL`,
`foreign_keys = ON`. Kysely transactions start with `begin immediate`, so a transaction takes the
write lock up front, waits for it up to the busy timeout, and never fails halfway with
`SQLITE_BUSY_SNAPSHOT`.

Switching a brand-new file to WAL while another process does the same fails at once with
`SQLITE_BUSY` (the busy timeout does not apply there), so `openDatabase` retries that one step
until the busy timeout has passed.

`journal_mode = WAL` is checked: if SQLite answers with another mode (an in-memory database, a file
system without shared memory), opening fails with `DATABASE_OPEN_FAILED` instead of running in a
mode the rest of this document does not describe.

**Inside a transaction, always use `trx`, never the outer `db`.** The app has one connection and
Kysely serializes access to it with a mutex. A query on `db` inside `db.transaction().execute(async
(trx) => ...)` waits for the transaction to finish while the transaction waits for that query: it
hangs forever, with no timeout and no error. Repositories take the executor (`Kysely<Database>` or
the transaction) as a parameter for this reason: pass `trx` to them inside a transaction.

better-sqlite3 is synchronous: while a write waits for a lock held by another connection, the whole
Node thread waits. That is fine for the short transactions in this app. Keep transactions short and
never hold one open across an `await` on something slow (network, model, subprocess).

## Migrations

- Written in TypeScript with Kysely's schema builder, one file per migration in `migrations/`,
  named `YYYYMMDDHHMMSS_what_it_does.ts` (the UTC time the migration was written; the first one,
  `0001_create_app_meta`, is the only exception and sorts before all of them) and registered in
  `migrations/index.ts`. Kysely runs them in the alphabetical order of the keys there. Timestamps
  keep parallel branches from picking the same number. When a branch merges after another one added
  migrations, check the order: a migration must never sort before one that is already merged, because
  Kysely refuses to run it. A database that applied a migration under an old name must be recreated.
- They run automatically when the server starts: `src/instrumentation.ts` (`register`, which Next.js
  calls once before the server accepts requests) calls `initializeDatabaseOnStart`. It is not run by
  `next build`.
- All pending migrations of one start run in a single transaction. If one fails, nothing of the
  batch is applied or recorded, and the start ends with exit code 1 and one line naming the
  migration (`MIGRATION_FAILED`). Two instances starting on the same file take turns on the write
  lock; each migration runs exactly once.
- If another process holds the write lock for longer than the busy timeout (for example a second
  instance that is still migrating a big file), the start ends with `DATABASE_LOCKED` and a message
  that says nothing is broken, not with `MIGRATION_FAILED`.
- Migrations run inside a transaction, where `PRAGMA foreign_keys` is a no-op. The usual SQLite recipe
  for changing a table (create new table, copy, drop, rename, with `foreign_keys = OFF` around it)
  therefore does not work as written: either avoid rebuilds (add columns, create new tables) or use
  `PRAGMA defer_foreign_keys = ON` inside the migration and let the check run at commit.
- A migration that has run anywhere is never edited. Add a new one instead. There is no automatic
  `down`; write one only if it is useful for a developer.
- A missing database directory, an unwritable directory or a file that is not a database also stop
  the start with a clear message that names the path. The directory is not created for you: a wrong
  `DATABASE_PATH` or an unmounted volume must not silently create a new, empty database.

### Workspaces and the migration that introduced them

Migrations `20261011160000_create_workspaces`, `20261011160100_add_workspace_to_customer_data` and
`20261011160200_prepare_users_for_accounts` (docs/decisions/0001-editions-setup-and-accounts.md, sections
2.6, 2.7, 2.10):

- `workspaces` (id, name, unique slug, created by, created at) and `workspace_members` (workspace, user,
  role, created at; primary key (workspace, user); the role is restricted to `owner`, `admin`, `member`
  by a check constraint, the same list as `WORKSPACE_ROLES` in `src/workspaces/roles.ts`).
- `workspace_id` (required) on `integrations`, `repositories`, `jobs` and `app_settings`; a project
  belongs to a workspace through its repository. `repositories` and `jobs` repeat it so that no query
  needs a join to scope. Two composite foreign keys make the database itself refuse a link across
  workspaces: a repository must name an integration of its own workspace, a job a repository of its own.
  `app_settings` is per workspace (primary key (workspace, key)): the review defaults of one workspace
  are not those of another. The unique index `(type, external_id)` on `integrations` stays global: one
  installation is linked to one workspace only.
- `users.github_login` is optional (a user can exist without a GitHub account); `users.imported_at` is
  null except for users the import of an existing installation marks.
- **Backfill.** A database that holds data (a row in `users`, `integrations`, `repositories`, `projects`,
  `jobs` or `app_settings`) gets one workspace, "Default workspace" (slug `default`), and every row of
  the four tables moves into it; no row is lost or changed otherwise. A database without data gets no
  workspace: the first-run setup makes it. **The migration creates no membership**; who becomes a member
  is decided by the import of an existing installation (`src/legacy-import/`, it looks at the allow list of that
  day).
- **How the tables are rebuilt.** SQLite cannot add a NOT NULL column that references another table,
  and the usual rebuild recipe needs `PRAGMA foreign_keys = OFF`, which does nothing inside the
  migration transaction. So the chain `integrations`, `repositories`, `projects`, `jobs`, `job_comments`
  is rebuilt parents first (rename to `*_old`, create, copy), the old tables are dropped leaf first and
  the indexes are created last. No foreign key is violated at any point. `users` is not rebuilt (its
  children cascade on delete): `github_login` is replaced by a nullable copy of itself.
- **Postgres.** The same migration runs on Postgres with two guarded differences, none of which
  touches the SQLite statements or their order: Postgres refuses a composite foreign key whose target
  has no matching unique constraint, so `integrations_id_workspace_unique` is created before the
  `repositories` table on Postgres (and after it, in its shipped place, on SQLite); and Postgres keeps
  an explicitly named constraint's name when a table is renamed, so `job_comments_pk` is freed before
  the new `job_comments` reuses it. A fresh SQLite `sqlite_master` is byte-for-byte the shipped one.
- **Time budget.** The migration of a database with 10 000 jobs that each hold a result of about 2 KB
  must finish within 10 seconds in one transaction (`workspace-migration.integration.test.ts`). It
  takes about 0.4 seconds on a laptop; the budget is generous so that a slow CI machine does not make
  the test flaky. The size of the results matters: dropping `jobs_old` deletes its rows, and for every
  row SQLite looks for rows that refer to it through `superseded_by`. Without the index
  `jobs_old_superseded_by` that is a scan per row, and this very database took 44 to 47 seconds. Any
  later change that rebuilds a table with a self-reference needs the same index. If you make the
  migration slower, say why here.

### Instance settings, rate limits and the instance admin flag

Migrations `20261011170000_create_instance_settings`, `20261011170100_create_rate_limits` and
`20261011170200_add_instance_admin_flag_to_users` (docs/decisions/0001-editions-setup-and-accounts.md,
sections 2.2, 2.3 and 2.10):

- `instance_settings` (key, JSON value, `updated_by` user id or null, `updated_at`): the settings of the
  whole instance (`instance-settings-repository.ts`, typed by key). The first-run setup state is two
  explicit rows, `setup_completed_at` and `import_state`; a database from before them reads as null and
  `none` (`src/setup/README.md`). `tenancy` and `sign_up_rule` are written by the setup; `import_state`, `github_app`,
  `sign_in_methods` and `import_notice` (what the import could not migrate, for the admin portal) by the import of an
  existing installation (`src/legacy-import/`).
- `rate_limits` (key, `window_started_at`, `count`): shared counters with a window for the endpoints that
  must limit the same way whichever app instance a request reaches (`rate-limits-repository.ts`, `hit` is
  one statement, so attempts that arrive together are all counted). The email and password sign in
  uses it (`src/auth/sign-in-limit.ts`); the setup code has its own counters in memory, by design.
- `users.is_instance_admin` (0 or 1, default 0): set for the account the setup creates.

None of these is customer data, so none is workspace scoped (`scoping.test.ts` lists them as instance
level).

### Secrets, password reset tokens and email verification tokens

Migrations `20261011200000_create_secrets` and `20261011200100_create_password_reset_tokens` (sections 2.3
and 2.7):

- `secrets` (name, ciphertext, nonce, `key_version`, `last_four`, `updated_by`, `updated_at`): the encrypted
  credentials of the instance, one row per name (`secrets-repository.ts`, used through `src/secrets/`). The
  name is the row id that is bound into the ciphertext.
- `password_reset_tokens` (`token_hash`, `user_id`, `created_at`, `expires_at`, `used_at`): single-use reset
  links; only the SHA-256 hash of the token is kept (`src/auth/password-reset.ts`). A row goes with its user.
- `email_verification_tokens` (`token_hash`, `user_id`, `email`, `password_hash`, `created_at`, `expires_at`, `used_at`), migration
  `20261011210000_create_email_verification_tokens` (section 2.5): single-use verification links, valid 24 hours;
  only the SHA-256 hash of the token is kept, and a link is bound to the address it was made for and to the password hash of the sign-up that made it
  (`src/signup/`). A row goes with its user.
- `instance_settings` gained two keys: `sign_in_methods` and `max_workspaces_per_user` (typed in
  `instance-settings-repository.ts`, which also reads a value with who saved it and when).
  A third key, `smtp`, holds the mail server's settings (the password is in `secrets`, never here); the repository
  can also `remove` a setting. A fourth, `github_app`, holds the GitHub App's non-secret settings (app id, slug,
  client id, the "private app" flag, where it came from; the private key, webhook secret and client secret are in
  `secrets`, `src/github-config/`).

### Signed states, the address conflict and the accounts indexes

Migrations `20261012120000_create_signed_states`, `20261012120100_add_users_email_conflict` and
`20261012120200_unique_accounts` (sections 2.4, 2.5 and 2.9):

- `signed_states` (`id` = the nonce, `purpose`, `user_id`, `session_hash`, `code_verifier`, `data`, `created_at`,
  `expires_at`, `used_at`): the single-use side of the signed `state` values of the round trips through GitHub (the
  manifest flow, linking a GitHub identity), `src/signed-state/`. A row goes with its user and is removed by the
  clean-up once it has expired.
- `users.email_conflict`: GitHub's verified primary address when another account has it already, so an imported
  user's placeholder address could not be replaced (`src/github-signin/decide.ts`). Null otherwise.
- Unique indexes on `accounts`: `(provider_id, account_id)` (an identity belongs to one user) and `(user_id,
provider_id)` (a user has one identity per way to sign in), so linking a GitHub identity is safe when two requests
  race.

### Workspace secrets and the remembered keys of jobs

Migrations `20261012140000_create_workspace_secrets` and `20261012140100_create_job_claimed_keys` (sections 2.7, 2.8
and 2.10):

- `workspace_secrets` (`workspace_id`, `name`, `binding`, `ciphertext`, `nonce`, `key_version`, `last_four`,
  `updated_by`, `updated_at`; primary key (workspace, name)): the encrypted credentials of one workspace, today its LLM
  key (`workspace-secrets-repository.ts`, scoped, used through `src/secrets/workspace-store.ts`). The workspace id
  and the name are bound into the ciphertext; `binding` is the provider the key was entered for. A row goes with
  its workspace.
- `job_claimed_keys` (`job_id`, `ciphertext`, `nonce`, `key_version`, `created_at`): the LLM key handed to a runner
  with the claim of a job, encrypted, so any app instance can mask a result (`job-claimed-keys-repository.ts`,
  instance level; `src/runner-api/claimed-keys.ts`). A row goes with its job and with the cleanup a week after the
  job finished.

### Workspace entitlements

Migration `20261014120000_create_workspace_entitlements` (#271; epic #268). It adds an empty table and touches no
existing row:

- `workspace_entitlements` (`workspace_id` as the primary key, `plan_label`, `key_mode` `own` or `managed`, `limits`
  as JSON text, `period_start`, `suspended` as 0 or 1, `suspension_code`, `updated_at`, `updated_by`): what an
  operator allows one workspace (`workspace-entitlements-repository.ts`, scoped; one row per workspace, so `get`
  and `put` take no id). The checks refuse a key mode other than the two, a suspended flag other than 0 and 1, and
  a suspension code on a workspace that is not suspended. The row goes with its workspace. `put` validates
  (`src/workspaces/entitlements-validation.ts`) and never lets `period_start` move to an earlier time: one upsert
  whose `where` compares the stored and the new start, so a repeated or late reset is harmless. There is no
  `remove` yet: deleting a row would end that guard (a later `put` could store an earlier start); #275 decides
  whether it needs one.
- The instance setting `default_entitlements` (`instance-settings-repository.ts`, the same fields without the
  workspace) applies to every workspace without a row. `set` validates it the same way and checks the period
  start under a transaction lock (`entitlements-lock.ts`: an advisory lock on Postgres). The generic `remove(key)`
  would end the guard for the default in the same way; it is not blocked yet (follow-up for #275).
- **Reading is checked too.** The columns of a row and the JSON of the default are not trusted: both are read
  through `readEntitlements` (the same rules as a write, except the clock). `get()` and `getDefaultEntitlements()`
  never throw on damaged data; an entry that cannot be read comes back as `{ invalid: true }`, which the resolver
  turns into `invalid` (fail closed, see `src/workspaces/README.md`). The generic `get`/`getWithMeta` of the
  settings do not accept `default_entitlements` (type `ReadableSettingKey`), so nobody reads the raw JSON by
  accident.
- No row and no default means unlimited, as before. Only `resolveEntitlements` (`src/workspaces/entitlements.ts`)
  interprets the data; see `src/workspaces/README.md`, "Entitlements".

## Workspace scoping

Every repository that reads or writes customer data is created for one workspace:
`createIntegrationsRepository(db, workspaceId, ...)`, and the same for repositories, projects,
app settings, jobs and runs. Every query it runs filters or sets `workspace_id`, and an id of another
workspace is simply not there: fetching, changing or deleting it behaves like a missing id.
`WorkspaceId` is a plain string; a repository takes it as its second parameter, always named
`workspaceId`.

- `repositories/scoping.test.ts` reads the source of the repositories and fails when a module is
  neither scoped nor on the explicit list of instance level modules, or when an exported function of a
  scoped one takes a database connection without a `workspaceId`.
- `repositories/scoped-isolation.integration.test.ts` calls every method of every scoped repository
  with the scope of one workspace against the ids of another and checks that nothing comes back and
  nothing changes. It has a row for every method; a method without one fails the test.

Not scoped, each for a reason (the list is in `scoping.test.ts`):

| Module                                                               | Why                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app-meta`, `allowed-login-pins`, `webhook-deliveries`, `workspaces` | Not customer data (facts about the installation, the sign-in allow list, delivery ids, the owners themselves)                                                                                                                                                                     |
| `integration-directory-repository.ts`                                | Reads integrations of any workspace. A webhook names an installation before anybody knows the workspace, and the synchronization walks every connection. It only reads, and the answer carries `workspaceId`; everything done next goes through scoped repositories               |
| `runner-jobs-repository.ts`                                          | The lease side of the job queue (claim, heartbeat, complete, release, expiry). Runners serve the whole instance with one token, so a claim hands out the oldest due job of any workspace; every change is fenced by the lease token, and the job it returns carries `workspaceId` |

A signed-in user works in the workspace named by the address (`/w/<slug>`) and only in one they are a member
of (`src/workspaces/README.md`); the repositories of members and invitations below follow the same rule,
and the question "which invitations wait for this address?" is answered by the instance level
`invitation-directory-repository.ts`, which only reads.

## Portable schema conventions

The MVP runs on SQLite only, but the schema stays portable so that Postgres remains possible later.
Every table follows these rules; `migrate.integration.test.ts` checks the ones it can on the real
schema.

| Kind            | Column type          | Stored as                                                                                                                                      |
| --------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Identifier      | `text`               | An application generated id (for example a UUID). Never `autoincrement` or a database sequence                                                 |
| Timestamp       | `text`, named `*_at` | ISO 8601 in UTC with milliseconds, e.g. `2026-10-10T12:30:15.042Z` (`formatTimestamp`). Time is injected into repositories (`now: () => Date`) |
| JSON            | `text`               | `JSON.stringify` output (`encodeJson` / `decodeJson`); `undefined` is refused, use `null` for "no value"                                       |
| Boolean         | `integer`            | `1` or `0` (`encodeBoolean` / `decodeBoolean`)                                                                                                 |
| Everything else | `text` or `integer`  | Numbers that are not booleans are `integer`; no floating point, no `blob`, no dates or booleans as native types                                |

More rules: foreign keys are declared and enforced; use only schema builder features that exist on
both SQLite and Postgres (no `STRICT`, no SQLite-only pragmas in migrations); keep SQL out of
repositories where the query builder can express it.

Kysely's own bookkeeping tables (`kysely_migration`, `kysely_migration_lock`) use `varchar` columns
and are exempt.

## Using the connection

`getDatabase()` (`startup.ts`) returns the connection that the server opened in `register()`. It
works at request time only: `next build` workers (page data collection, prerendering) never call
`register`, so a route or component that reads the database while it is being prerendered gets
"The database is not initialized". Read the database in code that only runs per request (route
handlers, server actions, dynamic rendering, for example after `await connection()`), never at
build time. The `src/db` modules import `server-only`, so importing them in a client component
fails the build.

## Repositories

A repository is a small module that takes a `Kysely<Database>` (or a transaction) and exposes
functions in domain terms, for example `createAppMetaRepository(db).get("key")`. It converts between
application values and column values through `codecs.ts`; callers never see a stored `0`/`1`, a JSON
string or a timestamp string format. Route handlers and server code get the connection from
`getDatabase()` (`startup.ts`) and pass it in; tests pass in a database from
`src/test-support/test-database.ts`.

`integrations` (migration `20261010134000_create_integrations`, repository `integrations-repository.ts`, plus the
instance level `integration-directory-repository.ts`) holds the connections to git platforms; see `src/integrations/README.md`. It keeps no secret of a GitHub App, and the
repository refuses secret-looking keys in `config`.

`repositories` (migration `20261010143000_create_repositories`, repository `repositories-repository.ts`)
holds the repositories each integration can see. A repository the platform stops listing becomes
inactive (`active = 0`), never deleted; `reconcile` makes the rows of one integration match a
complete list in one transaction.

`projects` (migration `20261010190000_create_projects`, repository `projects-repository.ts`) holds
the repositories that are reviewed: one row per repository (`repository_id` unique), created by the
first activation or the first save of settings (then off), switched off with `active = 0`, never deleted; see `src/projects/README.md`.
`settings` holds the project's JSON overrides: the Diff review settings and, for one project, the
project-only review kind, Dynamic model and optional skill (`src/review-settings/README.md`). Missing
keys read as their defaults, so no migration is needed for new JSON fields. `updateSettingsWith`
computes the next settings from the stored ones in the write transaction, reading them under a lock on
the workspace-scoped repository row (SQLite's `begin immediate` write lock; Postgres `FOR UPDATE`), so
a read-modify-write on either database cannot lose a concurrent update. `updateSettings` /
`updateSettingsWith` run an optional `afterChange` hook in that same transaction (the settings-change
hook #195 uses).

`webhook_deliveries` (migration `20261010170000_create_webhook_deliveries`, repository
`webhook-deliveries-repository.ts`) holds the delivery ids the webhook route has accepted, so a
redelivery produces no second trigger; rows are pruned after 7 days; see `src/webhooks/README.md`.

`jobs` (migration `20261010191500_create_jobs`, rebuilt by `20261011160100_add_workspace_to_customer_data`;
the scoped repository `jobs-repository.ts` creates, drops and reads jobs, the instance level
`runner-jobs-repository.ts` with the claim in `jobs-claim.ts` hands them to runners) is the job queue (the index `jobs_repository_recent`, migration `20261011100000_add_jobs_repository_recent_index`, serves the runs pages: newest job of a repository, `runs-repository.ts`); the rules (dedupe, supersession, leases, attempts, timeouts) are
in `src/jobs/README.md`. `jobs-claim.ts` holds the one statement written for a dialect (SQLite's
single write lock or Postgres' `FOR UPDATE SKIP LOCKED` plus a savepoint retry; see its head
comment); everything else is query builder code.

`app_settings` (migration `20261010201500_create_app_settings`, rebuilt per workspace by
`20261011160100_add_workspace_to_customer_data`, repository `app-settings-repository.ts`) holds settings of
one workspace, one row per setting with a JSON value; the first is `review_defaults`, the default values of
the review settings of the workspace (`src/review-settings/README.md`).

`workspaces` and `workspace_members` (migration `20261011160000_create_workspaces`, repositories
`workspaces-repository.ts` for the questions that start from a user and `workspace-members-repository.ts` for
the members of one workspace) are described under "Workspaces and the migration that introduced them" above
and in `src/workspaces/README.md`.

`invitations` (migration `20261012100000_create_invitations`, scoped repository `invitations-repository.ts`,
instance level `invitation-directory-repository.ts`): the links that bring a person into a workspace. Columns:
`workspace_id`, the canonical `email` it is bound to, the `role` (the same check as `workspace_members`),
`token_hash` (SHA-256 of the 256 bit token, unique; the token itself is never stored, a resend replaces the
hash), `invited_by`, `created_at`, `expires_at` (7 days), and the ways it ends: `accepted_at` with
`accepted_by`, or `revoked_at`. A partial unique index allows one open (neither accepted nor revoked)
invitation per workspace and address; an expired one is ended by the code before a new one is made. Every
statement that ends or renews an invitation only touches an open one, and accepting only an open one that has
not expired (`invitations-repository.integration.test.ts`).

`installation_link_requests` and `unclaimed_installations` (migration `20261012150000_create_installation_binding`, section 2.9;
`src/installation-binding/`): a request is a person's ask to link an installation whose organization role the app could not
read, decided by the instance admin (scoped repository `installation-link-requests-repository.ts`, instance level
`installation-link-request-directory-repository.ts`). Columns: `workspace_id`, `requested_by`, the requester's GitHub login,
the installation id and its account (`account_login`, `account_type`, `account_id`), a `status` (pending, approved,
denied, withdrawn; a check constraint), the evidence (`token_can_access` and `role_result` with `role_detail`; never a
token), and the times and the admin who decided. A partial unique index allows one pending request per workspace and
installation, and a pending request is refreshed instead of repeated. `unclaimed_installations` (instance level
`unclaimed-installations-repository.ts`) notes the installations of the App that no workspace has linked (id, account, first and
last seen, whether a webhook or a synchronization saw it). `integrations.status` gained the value `disconnected` (the column is
text without a check). Both tables are in the merge of the instance admin with an imported operator (`USER_REFERENCES`).

`app_meta` (a key/value table for facts about the installation) exists to prove the setup. Product
tables come with the tickets that need them: add the migration, the row type in `schema.ts` and the
repository in the same change.

## Testing

`server-only` throws when it is imported outside Next.js server code, so Vitest resolves it to an
empty module (`vitest.config.mts`) and the child process runs with `--conditions=react-server`.

Anything that touches this layer is an `*.integration.test.ts` against a real SQLite file (see
`TESTING.md`). `src/test-support/db-template.global-setup.ts` migrates one template file per run,
`createTestDatabase()` copies it into a fresh temporary directory for each test and removes it
afterwards, so workers never share data. Tests that need a second connection or a second app
instance use a real child process (`db-process.ts`, `db-child.ts`).

Postgres tests run only when `TEST_DATABASE_URL` points at a Postgres server (CI provides a service
container; a developer starts a throwaway `postgres:18`). `src/test-support/postgres-test-database.ts`
creates one database per test (`createPostgresTestDatabase`), migrated to the latest schema and
dropped afterwards; `connectPostgres` opens a second connection to the same database for
two-instance tests. `pg` is the Postgres driver, in the app image next to `better-sqlite3`.
