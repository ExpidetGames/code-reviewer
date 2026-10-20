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
| `schema-status.ts`          | `readSchemaStatus(db)`: whether every migration of this version has been applied, read-only (serverless `/api/health`)                                                                                                                                              |
| `migrate-cli.ts`            | `pnpm migrate`: the migrations against `DATABASE_URL_MIGRATE` behind a session advisory lock, for the serverless mode                                                                                                                                               |
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

## Serverless mode

`APP_RUNTIME=serverless` (selected by itself when the hosting platform sets `VERCEL=1`; `src/runtime/mode.ts`)
is for functions that start cold, many at a time. The default, `server`, is the long-lived process
described everywhere else in this file and is unchanged. In serverless mode:

- **Postgres only.** SQLite is refused (`DATABASE_SERVERLESS_NEEDS_POSTGRES`; the message names no value),
  and the SQLite driver is never loaded (`startup.ts` imports `connection.ts` only when a server starts).
- **A lazy, small pool.** `getDatabase()` opens the pool on its first call, and the pool connects on the first
  query, so a cold instance that never reads the database never connects. `DATABASE_POOL_MAX` defaults to 3
  (1 to 20: every instance has its own pool), idle connections close after 5 seconds, and the pool is
  handed to the platform's hook (`attachDatabasePool` of `@vercel/functions`), which keeps the instance
  alive until they have closed.
- **No start-up work.** `src/startup-serverless.ts` only checks the settings, and a bad one throws (it never
  calls `process.exit`, which would end the function). No migration, no backup of an old database, no
  legacy import, no setup code in memory (it lives in the database: `pnpm setup-code`, `src/setup/README.md`), no sync with GitHub, no
  cleanup or backup timer. The repositories are synchronized by the webhooks and by a daily cron
  (`src/cron/`, route `/api/internal/repository-sync`, `CRON_SECRET`); the hourly cleanup, the expiry of lapsed leases and
  the resends are done by a once-a-minute sweep (`/api/internal/dispatch-sweep`, #328, `src/dispatch/README.md`).
- **Migrations are a command.** `pnpm migrate` connects with `DATABASE_URL_MIGRATE` (a DIRECT Postgres
  connection: a pooler that ends the session between statements would drop the advisory lock), takes the
  session advisory lock `code-reviewer:migrate` for the whole run, applies what is pending and exits 0, or
  prints one line with the error code and exits 1. Run it at deployment time, before the new version takes
  traffic. The app never migrates: `GET /api/health` answers 503 `{"status":"error","code":"SCHEMA_BEHIND"}`
  while the database lacks a migration of this version (`schema-status.ts`; read-only, and a complete
  schema is not asked about again).
- **Mixed versions during a rollout.** Old instances keep running while the new version is deployed. The
  order is: migrate, then deploy. A migration therefore must work for the version that is still running:
  add tables and columns (nullable, or with a default); drop or rename in a later release, once no instance
  of the old version is left. A database that is AHEAD of an instance (it knows fewer migrations) is
  healthy for that instance. An instance deployed before its migration reports `SCHEMA_BEHIND` on
  `/api/health` (503), but **nothing makes the platform hold traffic back** for that: a production deployment is promoted
  when it is built, whatever `/api/health` says. So the order is a rule for the operator, not something the platform
  enforces: run `pnpm migrate` first, then deploy (`docs/deployment-vercel.md`, section 5.6).

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
  uses it (`src/auth/sign-in-limit.ts`); the setup code has its own counters (in memory on a server, in `setup_codes` in a serverless deployment).
- `users.is_instance_admin` (0 or 1, default 0): set for the account the setup creates.

Migration `20261015110000_create_setup_codes` (#321): `setup_codes` (`id`, `code_hash`, `created_at`, `expires_at`,
`used_at`, `failures`, `window_started_at`, `attempts_in_window`) holds the first-run setup code of a serverless
deployment, at most one row (`setup-codes-repository.ts`, `src/setup/database-code-store.ts`). The code is stored as a
keyed hash only. A server never reads or writes the table. The migration is additive, so an instance from before it
keeps working while the migration runs (it never reads the table).

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
  whose `where` compares the stored and the new start, so a repeated or late reset is harmless. `remove()` deletes the row (#275, the operator API's `DELETE`), and
  that ends the guard for the workspace: the stored start was what it compared with. The operator API documents
  the consequence (`src/operator-api/README.md`): a later `put` with an earlier start is accepted, and a `put`
  without a start begins now.
- The instance setting `default_entitlements` (`instance-settings-repository.ts`, the same fields without the
  workspace) applies to every workspace without a row. `set` validates it the same way and checks the period
  start under a transaction lock (`entitlements-lock.ts`: an advisory lock on Postgres). The generic `remove(key)`
  would end the guard for the default in the same way. The operator API offers no removal of the default (#275), so
  nothing in the app calls it for this key.
- **Reading is checked too.** The columns of a row and the JSON of the default are not trusted: both are read
  through `readEntitlements` (the same rules as a write, except the clock). `get()` and `getDefaultEntitlements()`
  never throw on damaged data; an entry that cannot be read comes back as `{ invalid: true }`, which the resolver
  turns into `invalid` (fail closed, see `src/workspaces/README.md`). The generic `get`/`getWithMeta` of the
  settings do not accept `default_entitlements` (type `ReadableSettingKey`), so nobody reads the raw JSON by
  accident.
- No row and no default means unlimited, as before. Only `resolveEntitlements` (`src/workspaces/entitlements.ts`)
  interprets the data; see `src/workspaces/README.md`, "Entitlements".

Migration `20261017160000_add_workspace_entitlements_model_access` (#428; epic #420) adds one nullable text column
`model_access` to `workspace_entitlements`: JSON `{"catalogEntries":[...]}`, or NULL for every released entry (what every
earlier row has). Nothing else changes and no existing row is touched; an app of the previous release never names the
column, so it keeps inserting and reading rows. `put` does not write the column when the entitlements leave
`modelAccess` out (the upsert's update set omits it), and the default keeps its stored list the same way under the lock. A write that leaves the field out over a stored
default that cannot be read is refused (`catalog_entry_invalid`, field `modelAccess`, nothing written): a damaged row
stays unreadable under such a write, and the default must not widen to every released entry; stating `modelAccess` repairs it.
The default (`default_entitlements`) holds the field inside its JSON and needs no column.

### Usage records

Migration `20261014150000_create_usage_records` (#272; epic #268). It adds an empty table and touches no existing row:

- `usage_records` (`id`, `workspace_id`, `job_id` unique, `review_kind`, `key_mode`, `model_tier`, `state`
  `reserved`/`settled`/`void`, `cost_micro_usd`, `prompt_tokens`, `completion_tokens`, `reserved_at`, `settled_at`):
  what each run consumed (`usage-records-repository.ts`, scoped; the claim and the completion in
  `runner-jobs-repository.ts` write it through that repository with the job's own workspace). Checks refuse an
  unknown state, kind or key mode, a settled record without its time (or any other with one), a measurement on a
  record that is not settled, and a negative amount. Cost and tokens are `integer` (32 bit on Postgres; the code stores a
  larger number as unknown). The id is text; readers page through the settled records by `(settled_at, id)`. Rows are
  never deleted. See `src/usage/README.md`.

Migration `20261015200000_add_usage_record_settled_reason` (#273). It adds one nullable column, `settled_reason`, to
`usage_records` and touches no row: why a record was settled without a report of its run (`no_result`). A check
allows only that value. A previous release's app instance never names the column, so it keeps working against the
migrated database; its writes leave the reason empty.

### Job dispatches

Migration `20261015120000_create_job_dispatches` (#326; epic #316). It adds an empty table and touches no existing row,
so an app of the previous release on the same database is unaffected:

- `job_dispatches` (`job_id` primary key and foreign key to `jobs`, `state` `pending`/`acked`/`stopped`, `attempts`,
  `consecutive_failures`, `next_dispatch_at`, `acked_at`, `last_attempt_at`, `last_status`, `last_code`, `created_at`,
  `updated_at`): where the signed wake-up call of a job stands (`job-dispatches-repository.ts`, instance level: the
  sender and the sweep work from a job id and the table holds no repository data). Written only with
  `RUNNER_DISPATCH=webhook`; in the default poll mode it stays empty. A partial index serves the due rows. The sweep
  (#328) removes the rows of jobs that finished a week ago and makes a `stopped` row pending again after 10 minutes.
  See `src/dispatch/README.md`.

### Refusal notices

Migration `20261016090000_create_refusal_notices` (#281; epic #268). It adds an empty table and touches no existing row,
so an app of the previous release on the same database is unaffected (it never reads the table):

- `refusal_notices` (`id`, `workspace_id` and `repository_id` foreign keys, `pr_number`, `period_start`, `code`
  `quota_exhausted`/`workspace_suspended`, `state` `pending`/`posted`/`dropped`, `attempts`, `next_attempt_at`,
  `posted_at`, `created_at`, `updated_at`): the record that a pull request got the notice of a refused review in a
  period. Scoped (`refusal-notices-repository.ts`); a unique index on workspace, repository, pull request and period
  start is the dedupe, a partial index serves the cron sweep's read of the due ones (`refusal-notices-sweep.ts`,
  instance level). See `src/refusal-notices/README.md`.

### Plan handoff tokens

Migration `20261016120000_create_plan_handoff_tokens` (#284; epic #268). It adds an empty table and touches no existing
row, so an app of the previous release on the same database is unaffected (it never reads the table):

- `plan_handoff_tokens` (`token_hash` primary key: the SHA-256 of a token of 256 random bits, never the token;
  `workspace_id` and `user_id` foreign keys, `user_id` `on delete cascade`; `role` `owner`/`admin`, the role at the click;
  `created_at`, `expires_at` five minutes later, `used_at`, `revoked_at`): the single-use hand-over of an Owner or Admin
  to the operator-configured plan page. Making one is scoped (`plan-handoff-tokens-repository.ts`: it revokes the same
  person's unused tokens of the workspace and inserts, in one transaction); redeeming one is by the hash alone and
  instance level (`plan-handoff-redeem-repository.ts`: one guarded `update … returning`, then the role is read again).
  Rows are removed a day after they expired (`src/maintenance/cleanup.ts`); the table is listed in the user merge
  (`github-signin/merge.ts`, ends with the retired user). See `src/plan-handoff/README.md`.

### Model catalog entries

Migration `20261017140000_create_model_catalog_entries` (#425; epic #420). It adds an empty table and touches no existing
row, so an app of the previous release on the same database is unaffected (it never reads the table):

- `model_catalog_entries` (`id` primary key, opaque `mce_…`; `name` and `name_key`, the name folded to lower case with a
  unique index, so two names never differ only in case and no expression index is needed; `description`; `provider` and
  `model_id`, operator only; `serves_diff` and `serves_dynamic`, 0 or 1 with a check that at least one is 1; `status`
  `draft`/`released`/`retired` (a check); `sort_order`; `created_at`, `updated_at`; `updated_by` → `users.id` `on delete
set null`): the operator's list of the models that workspaces on the operator's key may use. Instance level
  (`catalog-repository.ts`): no workspace owns an entry. A released entry is never hard-deleted. See
  `src/model-catalog/README.md`. The user merge moves `updated_by` (`github-signin/merge.ts`).

### The models.dev catalog

Migration `20261019200000_create_models_dev_catalog` (#548; epic #420). It adds three empty tables and touches no existing
row, so an app of the previous release on the same database is unaffected (it never reads them). Instance level
(`models-dev-repository.ts`, `src/models-dev/README.md`): the catalog is read from models.dev at run time, not owned by a
workspace, and **nothing in it is ever deleted**.

- `models_dev_providers` (`provider_id` primary key, the id models.dev uses; `name`; `url_state` `trusted` / `url_changed` /
  `rejected` with a check, and a check that only `rejected` may lack a `trusted_url`; `trusted_url` is where a real key is
  sent, `pending_url` the address that differs from it and waits for an admin, `url_problem` why an address was refused,
  `url_changed_at`; `first_seen_at`, `unlisted_at`, `updated_at`).
- `models_dev_models` (primary key `provider_id` + `model_id`, foreign key to the provider; `name`, `family`,
  `context_limit`, `output_limit`, `input_limit`, the flags `reasoning`, `temperature` and `attachment` as 0 or 1,
  `modalities` as JSON, `upstream_status` (`deprecated` is a warning), `cost` as JSON with decimal strings (USD per million
  tokens, tiers included), `upstream_updated`, `interleaved` as JSON; `first_seen_at`, `unlisted_at`, `updated_at`).
- `models_dev_fetch_state` (one row, `id = 'models.dev'` by a check): `last_attempt_at`, `last_success_at`, `last_status`
  `ok` / `failed`, `last_error` (a stable code of `MODELS_DEV_FETCH_ERROR_CODES`) and `last_summary` as JSON. A run writes
  `last_attempt_at` before it starts (`recordAttempt`; a row made that way reads `failed` / `models_dev_interrupted` until
  the run ends), so a run the platform stops is not repeated at once.

Every text in the first two tables is untrusted data from models.dev, length-capped and one line before it is stored. A fetch
reads the provider rows `FOR UPDATE` on Postgres (`listProviders({ forUpdate: true })`) inside the transaction that writes
them, so a guarded update of one provider by an admin (#554) is not written over; on SQLite every transaction begins
`begin immediate`.

### Model enablement and price confirmation

Migration `20261020090000_create_model_decisions` (#549; epic #420). It adds two empty tables and touches no existing row, so
an app of the previous release on the same database is unaffected. Instance level (`model-enablements-repository.ts`,
`model-price-confirmations-repository.ts`, `src/model-prices/README.md`): the admin's decisions about models of the
models.dev catalog, not owned by a workspace, and **a confirmation is never changed or deleted**.

- `model_enablements` (`(provider_id, model_id)` primary key and foreign key to `models_dev_models`; `enabled` 0 or 1 with a
  check; `changed_by`, `changed_at`): whether the admin enabled the model for the managed key. One row per model, changed in
  place. No row means the admin has not decided (the model is "new" while it is also newer than the first fetch).
- `model_price_confirmations` (`seq` identity / rowid, the order rows were written in; `(provider_id, model_id)` foreign key to
  `models_dev_models`; `source` `catalog` / `admin`; `price` the confirmed price book and `reference_price` the price models.dev
  and the override file stated at that time, both JSON text with amounts as decimal strings of whole micro-USD per million
  tokens; `reference_hash` SHA-256 of the reference; `reason`; `confirmed_by`, `confirmed_at`): checks make a correction carry
  a reason and a confirmation as shown carry a reference. The latest row of a model counts; the price is stale once today's
  reference hashes differently. Triggers refuse an update, a delete and (Postgres) a truncate, like the billing journal.
  `confirmed_by` and `changed_by` have no foreign key: the history stays as written when a user is deleted.

### Billing journal and balances

Migration `20261019150000_create_billing_journal` (#495; epic #489, ADR 0006, 2.7). It adds two empty tables and touches no
existing row, so an app of the previous release on the same database is unaffected (it never reads them):

- `billing_journal_entries` (`seq` primary key, the order entries were written in: a Postgres identity, the SQLite row id
  (an `integer primary key`, which only grows because nothing is ever deleted; not `autoincrement`, see the convention
  below); `id` text, unique; `workspace_id` → `workspaces.id`; `type`, one of `top_up`, `start_credit`,
  `reservation`, `usage`, `release`, `refund`, `chargeback`, `correction`; `amount_micro_usd`, a signed integer; `ref_key`, the job
  id or the provider reference; `job_id`, `review_kind`, `minutes`; `ai_micro_usd` and `infra_micro_usd` of a `usage`;
  `reverses_entry_id` → the same table; `provider`, `provider_ref`, `actor_user_id`, `note`; `created_at`). **Append-only.**
  Checks: the type; the sign per type (`top_up`, `start_credit`, `release` positive; `reservation`, `usage`, `refund`,
  `chargeback` negative; `correction` non-zero either way); a `usage` carries both parts and they add up to its amount, no
  other type has parts; only a `correction` reverses; a `reservation`, `usage` or `release` has its job. Unique:
  `(workspace_id, type, ref_key)` (D14, the idempotency key) and `reverses_entry_id` (an entry is reversed once).
  `job_id` and `actor_user_id` have **no foreign key** on purpose: the account merge and the deletion of a user rewrite
  their references, and a journal that is never updated must not be blocked by, or rewritten with, a row that goes.
- `billing_balances` (`workspace_id` primary key → `workspaces.id`, `balance_micro_usd`, `reserved_micro_usd` with a check
  `>= 0`, `updated_at`): the cache of the journal, one row per workspace, created by the first entry. `balance` is the sum of
  all entries (a reservation is a debit, so it already excludes held money); `reserved` is the open reservations.
  The repository (`billing-journal-repository.ts`, scoped) updates it in the transaction of every entry; `verify()` compares
  it with the journal.
- **Immutability.** Triggers refuse an `UPDATE` and a `DELETE` of an entry on every connection: on Postgres a function
  (`billing_journal_entries_guard`) and a row trigger for update and delete plus a statement trigger for `TRUNCATE`; on
  SQLite one trigger each for update and delete. Every refusal carries `billing_journal_entries_immutable`. A mistake is a
  new `correction` entry. SQLite fires a delete trigger for `insert or replace` only with recursive triggers on, and
  that is a **per-connection** pragma: `openDatabase` turns it on (`connection.ts`), but the tools that open the file
  themselves (`admin-cli`, `backup`, `restore`, the legacy import) and the `sqlite3` shell do not, so on those an
  `insert or replace` could still overwrite an entry. No code does that; update and delete are refused everywhere. The down migration drops the guard function on Postgres, which a
  table drop leaves behind (the same note as the removed billing migrations below).
- **Money is an integer** in micro-USD, never a float and never a 32 bit column (it would stop at about USD 2,147):
  `integer` on SQLite, which is 64 bit already, so the "text and integer columns only" convention holds there, and
  `bigint` on Postgres. Postgres returns a `bigint` as text, so the repository converts every amount with `Number`
  (exact up to 2^53).
- **Concurrency.** Everything that writes is one transaction and idempotent on the key. `reserve` and `reserveUpTo` take
  the balance row's lock (Postgres `FOR UPDATE`; SQLite's `begin immediate` already serializes writers), answer a
  repeated job from the entry they wrote, and `settle` and `release` take the same lock before they read what the job
  has, so a settlement never charges a job a concurrent release voided. `append` takes it too, before it writes: every
  writer is "balance row first", so no two can wait for each other (an `append` that wrote first deadlocked with a
  `settle` on the same key). The hold itself is `UPDATE billing_balances SET balance = balance - :hold, reserved = reserved + :hold WHERE
workspace_id = :w AND balance >= :hold`; no row changed means the hold is refused and nothing is written. Every other
  entry adds to the balance unconditionally, so the balance goes below zero only through a settlement, refund, chargeback
  or correction. The balance row is updated, then inserted if missing, never upserted: Postgres checks the row it would
  insert (`reserved >= 0`) before it looks for a conflict. See `src/billing/README.md`.
- **Open question: deleting a workspace.** `workspace_id` is a plain foreign key (no cascade) and the journal refuses
  `DELETE`, so a workspace with a journal entry can never be deleted. No code deletes a workspace today. Whoever builds
  workspace deletion has to decide (retention and erasure on request against an immutable ledger) before it can work.

### Top-up intents and provider events

Migration `20261019170000_create_billing_topup_intents` (#497; epic #489, ADR 0006, 2.12 and 2.13). It adds two empty
tables and touches no existing row:

- `billing_topup_intents` (`id` primary key; `workspace_id` → `workspaces.id`; `adapter`; `amount_micro_usd`, what WE asked
  for, a check `> 0`; `state`, a check of `pending`/`paid`/`failed`/`expired`; `provider_checkout_ref` and
  `provider_payment_ref`, opaque provider ids, null until known; `credited_micro_usd`, what the payment credited (net), 0
  until paid, and `refunded_micro_usd` and `disputed_micro_usd`, the running totals of what refunds and disputes took
  back of it, with a check that neither is negative and that together they never exceed the credit; `created_at`,
  `updated_at`). Unique per adapter on each
  of the two refs (NULLs do not collide), so one payment or checkout belongs to one intent. Written before any checkout
  exists; the only way a payment reaches a workspace. **Workspace scoped**
  (`billing-topup-intents-repository.ts`); `billing-topup-intent-directory-repository.ts` finds an intent from an event
  before the workspace is known (read only, instance level, listed in `scoping.test.ts`).
- `billing_webhook_events` (primary key `(provider, event_id)`; `outcome`; `subject` and `occurred_at`, which order the
  states of one refund or dispute, or name the payment of a payment event; `received_at`; `review_state`, `open` for an
  event an operator must review (a payment nobody could credit, a refund that could not be debited, a signed event that
  is no event) and `resolved` once it was, null otherwise). The first idempotency layer: an id, an outcome and an order, **no
  payload, no amount, no name**, so it is instance level (`billing-webhook-events-repository.ts`). Not pruned yet.

The amount column is `integer` on SQLite and `bigint` on Postgres, like the journal. See `src/billing/README.md`.

### The newest jobs of the instance

Migration `20261019183000_add_jobs_created_at_index` (#541). It adds the index `jobs_created_at_id` on `jobs (created_at,
id)` and touches no column and no row, so the release that is still running is not affected while it runs. The runs page
of the instance admin (`job-directory-repository.ts`) lists the newest jobs of every workspace in that order; without the
index each call sorts every job of the instance. `job-directory-repository.integration.test.ts` reads the query plan on
SQLite.

### A database that ran the removed billing migrations

Three migrations of an earlier billing design existed on `development` for a few days and are deleted (#491):
`20261018120000_create_billing_plans`, `20261018140000_protect_billing_plan_versions` and
`20261018160000_create_billing_plan_prices`. They never reached `main`, so **no production database ran them**, and no
removal migration exists: a deleted migration is deleted. A fresh database and a database of `main` migrate to latest
without them (`migrations/upgrade-from-main.integration.test.ts`).

A **local, preview or staging** database that ran `development` in that time has the three migrations recorded without a
file, and the migrator refuses to start (`previously executed migration ... is missing`, reported as
`MIGRATION_FAILED`). The fix is a manual maintainer step, never automated, and never against production data:

1. Look first, read-only: `SELECT name FROM kysely_migration WHERE name LIKE '%billing%';`. No row: nothing to do. Check
   `SELECT count(*) FROM billing_plans;` too: the tables hold only what an admin typed into the removed plans page.
2. Back the database up (`src/backup/`), then run, in one transaction (the tests run these very statements,
   `migrations/upgrade-from-main.integration.test.ts`):

   ```sql
   DROP TABLE billing_plan_versions;
   DROP TABLE billing_plan_prices;
   DROP TABLE billing_plans;
   DELETE FROM kysely_migration
     WHERE name IN (
       '20261018120000_create_billing_plans',
       '20261018140000_protect_billing_plan_versions',
       '20261018160000_create_billing_plan_prices'
     );
   DELETE FROM instance_settings WHERE key = 'billing_settings';
   DELETE FROM instance_settings
     WHERE key = 'default_entitlements' AND value LIKE '%"source":"billing"%';
   ```

   The order matters: a version points at its prices (`monthly_price_id`, `yearly_price_id`) and the prices and the
   versions point at the plans, so versions go first. SQLite and Postgres take these statements as they are; dropping a
   table drops its triggers on both.

   **Postgres only**, in the same transaction: a table drop does not drop the two trigger functions the migrations
   created, and they would stay in the schema. SQLite has no functions, and its triggers went with the tables.

   ```sql postgres
   DROP FUNCTION IF EXISTS billing_plan_versions_guard(), billing_plan_prices_guard();
   ```

   The two `DELETE FROM instance_settings` statements leave nothing behind that changes behaviour, which is why they are part of the reset and
   not optional:

   - `billing_settings` of the old shape can say `enabled: true` (with an environment, a client token and grace days).
     The code still reads that as on, and the billing routes of a later issue would run on a database with no payment
     adapter and no rates. The row goes, and billing is off ("never configured") until someone switches it on.
   - A `default_entitlements` row with `"source":"billing"` is the Free plan that billing wrote, not a choice of the
     operator. Left in place it would silently become the operator's default for every workspace without its own
     limits (its limits and `modelAccess` included). The rule: a default that carries the marker goes, and the instance
     has no default again until the operator saves one (operator API `PUT /api/operator/v1/entitlements/default`). A
     default without the marker was saved by an operator and stays.

3. Start the app: the remaining migrations run as usual. The two encrypted rows of `secrets` named after the removed
   payment provider (`<provider>_api_key`, `<provider>_webhook_secret`) are ignored and may be deleted by hand.

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

| Module                                                               | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app-meta`, `allowed-login-pins`, `webhook-deliveries`, `workspaces` | Not customer data (facts about the installation, the sign-in allow list, delivery ids, the owners themselves)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `integration-directory-repository.ts`                                | Reads integrations of any workspace. A webhook names an installation before anybody knows the workspace, and the synchronization walks every connection. It only reads, and the answer carries `workspaceId`; everything done next goes through scoped repositories                                                                                                                                                                                                                                                              |
| `usage-feed-repository.ts`                                           | The settled usage records of every workspace in one ordered feed, and the grouped count of runs that settled without a cost per workspace and key mode (#385), for the operator API (#278): the operator serves many workspaces from one token. It only reads (never a `reserved` or `void` record), and every record and count carries `workspaceId`; the reads of one workspace go through the scoped usage records repository                                                                                                 |
| `job-directory-repository.ts`                                        | The jobs of every workspace for the instance admin's job view (#541): the operator looks at a run by its id without being a member of its workspace, to see what a run did. It only reads (a page of the newest jobs without their results, and one job by its id), and every answer names its workspace; the only callers are the pages of the admin portal behind the admin guard. What a member sees of a run goes through the scoped runs repository                                                                         |
| `runner-jobs-repository.ts`                                          | The lease side of the job queue (claim, heartbeat, complete, release, expiry). Runners serve the whole instance with one token, so a claim hands out the oldest due job of any workspace; every change is fenced by the lease token, and the job it returns carries `workspaceId`                                                                                                                                                                                                                                                |
| `claim-admission.ts`                                                 | The check of the entitlements of a job the claim just took (#277), inside the claim transaction of the lease side of the queue, for whichever workspace the job is in. It reads, through repositories created for that job's workspace (the instance default and the workspace row it locks are not customer data), and decides; the ending of a refused job is the lease side's own statement                                                                                                                                   |
| `plan-handoff-redeem-repository.ts`                                  | The redemption of a handoff token by the external plan page through the operator API (#284). The caller holds only the token, so there is no workspace to scope to before it is looked up by its hash; it never lists, and the answer names the workspace the token was made for. Making a token is the scoped plan handoff tokens repository; the clean-up only deletes expired rows                                                                                                                                            |
| `refusal-notices-sweep.ts`                                           | The notices of refused reviews that are due to be posted again (#281), for the cron sweep that serves the whole instance. It only reads the `pending` rows whose wait is over, and every answer carries `workspaceId`; the record itself goes through the scoped refusal notices repository                                                                                                                                                                                                                                      |
| `catalog-repository.ts`                                              | The operator's model catalog (#425): instance configuration, not customer data; no workspace owns an entry. Its one read across workspaces is `countProjectsUsing`, one number per entry of how many projects use it (those that select it, and in a workspace on the operator's key those that fall back to it as the instance default; for the operator's "used by" and the confirmation when the model behind it changes); it returns no row, project or workspace. The member view selects only the columns a member may see |
| `models-dev-repository.ts`                                           | The catalog read from models.dev (#548): the providers and models a job can use, and the state of the last fetch. Fetched at run time from a public source, so not customer data, and no workspace owns a row. It stores and reads whole rows, takes no workspace, returns none, and never deletes (a row that disappears upstream gets `unlisted_at`)                                                                                                                                                                           |
| `model-enablements-repository.ts`                                    | Whether the admin enabled a catalog model for the managed key (#549): one row per model, changed in place, who and when of the last change. Instance configuration, not customer data; no workspace owns a row.                                                                                                                                                                                                                                                                                                                  |
| `model-price-confirmations-repository.ts`                            | The append-only history of what an admin confirmed as a catalog model's price (#549); the latest row counts, the database refuses an update and a delete. Instance configuration, not customer data; no workspace owns a row.                                                                                                                                                                                                                                                                                                    |

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

`getDatabase()` (`startup.ts`) returns the connection that the server opened in `register()` (in
serverless mode it opens the pool on its first call, see "Serverless mode"). It
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

The serverless mode is tested at three levels: the unit suite also runs in CI with `APP_RUNTIME=serverless`
(job `app-serverless`; the tests of the server start pin `APP_RUNTIME=server`), the lazy database and the
refusals are unit tests (`startup.serverless.test.ts`, `config.serverless.test.ts`,
`../instrumentation.serverless.test.ts`), and `pnpm migrate`, the schema check and the cold-instance health
answer are Postgres integration tests (`migrate-cli.integration.test.ts`, `schema-status.integration.test.ts`,
`../health/health-schema.integration.test.ts`).
