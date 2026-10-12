# The update of an existing installation

An installation that ran the release before accounts updates without losing anything: its data stays, its GitHub
App, its LLM key and its allow list move into the new model once, and the operator finishes a short setup (the
code in the log, an admin account, two choices) instead of a long one. The decision is in
`docs/decisions/0001-editions-setup-and-accounts.md`, section 2.11; the operator's guide is "Updating from a
version before accounts" in the README and `docs/deployment-coolify.md`.

| File             | Role                                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup-step.ts` | `backupBeforeUpdateOnStart`: the backup that comes first, taken before the migrations touch the file; a failing backup ends the start. `holdsInstallationToImport`: the plain read that decides whether an import is pending. |
| `environment.ts` | `readLegacyEnvironment`: which old variables are set, which of them can be imported (the GitHub App, the LLM key), the allow list. A variable that is not usable is named and never imported.                                 |
| `members.ts`     | `decideMembers`, `pickOwner`: who passes the allow list of the moment (pure; the organization check is a function the caller gives).                                                                                          |
| `import.ts`      | `importExistingInstallation`: the checks that ask GitHub, then ONE transaction that writes everything and sets `import_state` to `done`.                                                                                      |
| `startup.ts`     | `importOnStart`: the wiring to the server (database, master key, GitHub) and the log lines; called from `src/instrumentation.ts` right after the migrations.                                                                  |
| `notice.ts`      | The one-time notice for the admin (`instance_settings` key `import_notice`): who was not made a member and why, the logins that never signed in, the organization that is not migrated, what could not be imported.           |

## What happens on the first start of the new version

`src/instrumentation.ts` runs, in this order: the checks of the settings, **the backup** (only when the database
holds users and the import has not run), the migrations, **the import**, the setup code. The state is read from the
explicit markers in `instance_settings`, never from whether a row exists:

- users exist, `setup_completed_at` is null and `import_state` is `none`: an existing installation whose import has
  not run. It is backed up and imported.
- `import_state` is `done`, `setup_completed_at` is null: a restart before the wizard finished. Nothing is imported
  again, no backup is taken, a new code is printed.
- no users: a fresh installation. The old variables are ignored with one line in the log.

**The backup** (`src/backup/`, the same module as the daily one, into `BACKUP_DIR`) is taken before the migrations,
so it is the file as the previous release left it: restore it and start the previous release again to go back. If it
cannot be written the start ends with `UPDATE_BACKUP_FAILED` and exit code 1, and the database has not been touched.
A start that runs the import again after a failure takes another backup, which is harmless.

**The import** is one all-or-nothing transaction (`import.ts`):

| What              | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data              | One default workspace holds every integration, repository, project, job and the review defaults. That assignment is the migration `20261011160100`; the import makes the workspace when it is missing.                                                                                                                                                                                                                                                                                                                      |
| Users             | Every user is marked `imported_at`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Members           | Users who pass the allow list **at import time**: a listed login whose pinned GitHub id matches (an id given as `login:id` wins, an unbound login binds to the oldest account that has it), or, with `ALLOWED_GITHUB_ORG`, a live membership check with the user's own stored GitHub token (decrypted with the master key). Either rule is enough. The earliest created member is the Owner. A user whose check cannot be completed (no token, a token another secret encrypted, GitHub unreachable) is blocked and listed. |
| No sign-up rule   | None is derived from the list or the organization. The sign-up rule is chosen in the wizard.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GitHub App        | `GITHUB_APP_ID`, `_SLUG`, `_PRIVATE_KEY` (or `_PATH`) and `_WEBHOOK_SECRET` go into the encrypted store (`origin: "import"`). The "private app" flag is unknown (`null`): the portal asks, and until then nothing attaches by itself.                                                                                                                                                                                                                                                                                       |
| LLM               | `LLM_PROVIDER` / `LLM_API_KEY` become the default workspace's key; `LLM_MODEL` is copied into its review defaults when it differs from the built-in model and the team chose none. `LLM_MAX_TOKENS` stays an instance setting.                                                                                                                                                                                                                                                                                              |
| Sign in           | `sign_in_methods` is written with GitHub off: the App has no user authorization yet, and the admin enables it. `GITHUB_OAUTH_*` are not imported (a GitHub OAuth app is not the GitHub App).                                                                                                                                                                                                                                                                                                                                |
| Notice and marker | The notice for the portal, then `import_state` = `done`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

The network is only used **before** the transaction opens (the organization checks, four at a time, five seconds
each), so a write lock is never held while GitHub is waited for. Nothing that is configured already is overwritten,
and a later start does nothing (`import_state` `done`), so a change the admin made stays.

A variable that is set but unusable (a broken private key, a model name that is none) is **not** imported; the log
and the notice name the variable and never a value. Everything else is imported. If anything else goes wrong the
transaction rolls back, the start ends with `IMPORT_FAILED` and one readable line, and fixing the cause and
starting again runs the whole import from the beginning.

## After the import

The instance is not set up (`import_state` `done`, `setup_completed_at` null): the code is printed and the wizard
runs (`src/setup/`). **Webhooks and the runner API keep working** with the imported settings meanwhile (the gate
treats an existing installation like that, `src/setup/gate.ts`), so reviews are never interrupted. At the end of the
wizard the admin becomes an Owner of the default workspace in single-tenant mode; in multi-tenant mode only if the
import left the workspace without an Owner.

After that, sign in is by email and password until the admin enables sign in with GitHub in the portal. People who
used GitHub then sign in with it and are recognised by their numeric GitHub id (`src/github-signin/`).

The old variables are **ignored from the import on**: the credential store reads the database only
(`src/github-config/credentials.ts`), the LLM key of a job is the workspace's own (`src/llm/resolve.ts`), the allow
list decides nothing. The log says so once per start, listing variable **names**. `APP_SECRET` is read first and
`BETTER_AUTH_SECRET` is used in its place when it is not set, so sessions and stored tokens stay valid; if both are
set and differ, sessions are rejected and the organization check cannot decrypt the old tokens.

## Tests

`import.integration.test.ts` runs the real `importOnStart` over a database made by the previous release's
migrations (`src/test-support/legacy-installation.ts`) and the fake GitHub: the members, the owner, the pins, the
organization, the failures, the rollback after every step, the log without secrets. `backup-step.integration.test.ts`
covers the backup (restores to the previous release's file; a failing backup changes nothing). `members.test.ts` and
`environment.test.ts` are the unit tests. The journey `e2e/upgrade/update-from-previous-release.e2e.ts` starts the
built app on such a database with the old environment, with the real runner and PR-Agent, and walks through the
operator's steps; `docker/smoke/upgrade.sh` does the same with the image and a frozen dump of the previous release's
database (`docker/smoke/fixtures/previous-release.sql`).
