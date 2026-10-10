# Database layer

Kysely on SQLite (better-sqlite3). The whole layer lives in this folder; nothing else in the app
opens a database or writes SQL.

| File                        | Role                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                 | Reads `DATABASE_PATH` and `DATABASE_BUSY_TIMEOUT_MS` from the environment                                                                                                    |
| `connection.ts`             | `openDatabase(config)`: checks the directory, opens the file, sets the pragmas                                                                                               |
| `dialect.ts`                | Kysely's SQLite dialect with `begin immediate` transactions and transactional DDL                                                                                            |
| `migrate.ts`, `migrations/` | `migrateToLatest(db)` and the ordered list of migrations                                                                                                                     |
| `startup.ts`                | What the server does on start; `getDatabase()` hands the connection out                                                                                                      |
| `schema.ts`                 | Row types of every table (`Database`)                                                                                                                                        |
| `codecs.ts`                 | The only code that knows how JSON, booleans and timestamps are stored                                                                                                        |
| `repositories/`             | One small module per table (or aggregate); the only code that queries it. Exception: `users`, `sessions`, `accounts` and `verifications` belong to Better Auth (`src/auth/`) |
| `errors.ts`                 | `DatabaseError` with stable codes (`DATABASE_CONFIG_INVALID`, `DATABASE_DIRECTORY_UNAVAILABLE`, `DATABASE_OPEN_FAILED`, `DATABASE_LOCKED`, `MIGRATION_FAILED`)               |

## Why better-sqlite3

Kysely needs a driver, and its own SQLite dialect is built for better-sqlite3. It is the most
widely used and actively maintained SQLite driver for Node, is synchronous (no connection pool to
reason about for a single-file database), ships prebuilt binaries for Node 24, and Next.js already
lists it in its default `serverExternalPackages`, so it works in the server bundle without extra
configuration. The alternative, Node's built-in `node:sqlite`, has no Kysely dialect yet.
`pnpm-workspace.yaml` allows its install script (`onlyBuiltDependencies`) so the native binary is
available after `pnpm install --frozen-lockfile`.

## Connection settings

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

`integrations` (migration `20261010134000_create_integrations`, repository `integrations-repository.ts`) holds the connections to
git platforms; see `src/integrations/README.md`. It keeps no secret of a GitHub App, and the
repository refuses secret-looking keys in `config`.

`repositories` (migration `20261010143000_create_repositories`, repository `repositories-repository.ts`)
holds the repositories each integration can see. A repository the platform stops listing becomes
inactive (`active = 0`), never deleted; `reconcile` makes the rows of one integration match a
complete list in one transaction.

`projects` (migration `20261010190000_create_projects`, repository `projects-repository.ts`) holds
the repositories that are reviewed: one row per repository (`repository_id` unique), created by the
first activation, switched off with `active = 0`, never deleted; see `src/projects/README.md`.

`webhook_deliveries` (migration `20261010170000_create_webhook_deliveries`, repository
`webhook-deliveries-repository.ts`) holds the delivery ids the webhook route has accepted, so a
redelivery produces no second trigger; rows are pruned after 7 days; see `src/webhooks/README.md`.

`jobs` (migration `20261010191500_create_jobs`, repository `jobs-repository.ts`, claim in
`jobs-claim.ts`) is the job queue; the rules (dedupe, supersession, leases, attempts, timeouts) are
in `src/jobs/README.md`. `jobs-claim.ts` holds the one statement written for SQLite (see its head
comment); everything else is query builder code.

`app_settings` (migration `20261010201500_create_app_settings`, repository `app-settings-repository.ts`) holds
settings of the whole instance, one row per setting with a JSON value; the first is `review_defaults`, the
global default values of the review settings (`src/review-settings/README.md`).

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
