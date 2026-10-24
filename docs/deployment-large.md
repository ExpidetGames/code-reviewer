# Deploying Code Reviewer, the large topology

> **Internal reference, not a supported way to run code-review.com.** The source is visible but not
> licensed for use, copying or hosting, and the service cannot be self-hosted (`LICENSE`, #677). This
> guide stays only because `compose.large.yml` and its test still exist; both are candidates for
> removal together with the self-host mode.

The small topology (`compose.yml`) runs the app and the runner on one machine with SQLite. This guide
is for the large one: an **external Postgres**, **several app instances** and **several runners**,
behind a reverse proxy. The product is identical; only the topology and the database differ
(`docs/decisions/0001-editions-setup-and-accounts.md`, section 2.1). `compose.large.yml` is the
example to start from — read it next to this guide. The hosted deployment on Vercel, which also uses an
external Postgres but runs the App as functions, is described in [`deployment-vercel.md`](deployment-vercel.md).

`DATABASE_URL` selects the database:

| `DATABASE_URL` | Meaning |
|---|---|
| empty, a path or `sqlite:/data/app.db` | SQLite (the small topology; `DATABASE_PATH` keeps working) |
| `postgres://...` or `postgresql://...` | the external Postgres |

## 1. What you need

- A Postgres server (managed or your own) and a database for the app. `postgres:18` is what the
  example uses and what CI tests against.
- One or more hosts that can run the app and runner containers (Docker Compose, Kubernetes, a cloud
  runtime: the app and the runner are stateless except for the database).
- A reverse proxy that terminates TLS and forwards to `app:3000`, with a health check on
  `/api/health`.
- The images built from this checkout (`compose.build.yml`); no image is published.

## 2. Start it

```sh
export APP_SECRET="$(openssl rand -base64 32)"     # keep a copy apart from the database backups
export RUNNER_TOKEN="$(openssl rand -hex 32)"
export POSTGRES_PASSWORD="..."                      # the database user's password
export BETTER_AUTH_URL="https://reviews.example.com"
# Start with ONE app replica and finish the first-run setup, then scale the app out:
docker compose -f compose.large.yml up -d --wait
docker compose -f compose.large.yml up -d --scale app=2 --wait
```

`compose.large.yml` builds `DATABASE_URL` from `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`,
so the app and the database agree on it. Open `BETTER_AUTH_URL`: the app asks for the **setup code**,
printed once in the log of the single app instance (`docker compose logs app`).

**The first-run setup is per process** (ADR 2.2): the setup code, its attempt counter and the setup
session live in one app process, so the setup must be done on ONE app replica. Behind a round-robin
proxy the code from one instance is rejected by another and `/api/setup/complete` fails. `replicas: 1`
is therefore what `compose.large.yml` starts with; finish the setup, then `--scale app=2`. From then on
the replicas are interchangeable: the settings, sessions and secrets live in Postgres, and a change on
one is effective on the others on the next request (section 4).

## 3. Environment variables

Everything a product decision depends on (who may sign up, the GitHub App, mail, limits, LLM keys)
lives in the database and is edited in the admin portal — one instance's change is effective on the
others on the next request. The environment keeps only the technical and operational settings:

| Variable | Required | Meaning |
|---|---|---|
| `APP_SECRET` | yes | The master key: signs sessions, encrypts stored credentials. At least 32 characters. **Back it up separately from the database** (section 5). `BETTER_AUTH_SECRET` is its deprecated name |
| `RUNNER_TOKEN` | yes | The token the app and the runners share |
| `BETTER_AUTH_URL` | yes | The public address behind the proxy; sessions and links are bound to it |
| `DATABASE_URL` | yes (large) | The Postgres connection URL. Its password is never logged |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | for the example | Used to build `DATABASE_URL` and to configure the `postgres` service |
| `DATABASE_POOL_MAX` | no | The most connections the pool opens (default 10). Raise it with more app instances |
| `RUNNER_CONCURRENCY`, `RUNNER_JOB_TIMEOUT_SECONDS`, `RUNNER_POLL_INTERVAL_SECONDS`, `RUNNER_ID` | no | How a runner works; see `compose.yml` |
| `GITHUB_APP_*`, `ALLOWED_GITHUB_*`, `LLM_API_KEY` | no | Imported once by an update from before accounts, then ignored. GitHub, mail, the sign-up rule and per-workspace LLM keys are configured in the admin portal |

`DATABASE_BUSY_TIMEOUT_MS`, `BACKUP_TIME` and `BACKUP_DIR` belong to the small (SQLite) topology and
do nothing here.

## 4. How several instances behave

- **First-run setup** is the exception: the setup code, its counter and the setup session live in one
  process, so do it on a single app replica before scaling out (section 2, ADR 2.2).
- **Configuration** is read from the database without a per-process cache, so a change made on one
  instance is effective on the others on the next request.
- **Sessions** live in the database: sign in on one instance and the next request may reach another.
- **Rate limits, the setup state and encrypted secrets** are rows in the database, so attempts are
  counted together whichever instance they reach.
- **The job queue** hands each job to exactly one runner. The claim uses `SELECT ... FOR UPDATE SKIP
  LOCKED`, and a partial unique index keeps at most one job running per pull request even when two
  runners claim at the same moment.
- **Migrations** run behind an advisory lock: when several instances start at once, exactly one
  migrates and the others wait, then find nothing left to do. A failing migration leaves the database
  unchanged.

## 5. Backups

An external Postgres is **the operator's to back up**: the app starts no backup scheduler, logs one
line saying so, and `/api/backup/status` reports backups as not applicable. Use the database's own
tooling (`pg_dump`, a managed service's snapshots, PITR).

Back up two things, **separately**:

1. **The database** (`pg_dump` / snapshots).
2. **`APP_SECRET`** (and the `POSTGRES_PASSWORD`). A database restored without its `APP_SECRET` loses
   every stored credential: the GitHub App key, the SMTP password, every workspace's LLM key. It cannot
   be recovered from the database.

## 6. Updates and rollback

- Build and push a new `sha-<short>` image tag (the publish workflow does this on `development` and
  `main`), then roll the services: `docker compose -f compose.large.yml up -d --wait`. Because the app
  is stateless, a rolling update (one replica at a time) loses no job: a runner that is stopped reports
  what it holds as `runner_shutdown`, and the app requeues it for another runner.
- Migrations run automatically on the first new instance that starts, behind the advisory lock. Do not
  start two different versions that write the same tables for long.
- Rollback means starting the previous image tag again. A migration that has already run is not
  undone; keep the previous image ready.
- A release that removes a comment command (`/ask`, `/improve`, `/describe`) follows the order of the
  single-server guide: stop the old app producers, let the new app migrate (it cancels waiting jobs of a
  removed command with `command_removed`), then replace the runners. A runner holding a claimed job may
  finish it under its lease; a removed command a new runner receives fails with `invalid_command` and is
  reported. The runner API stays version 1 and keeps accepting the previous release's review payload. A
  rollback neither resurrects a cancelled job nor restores normalized `allowedCommands`.

## 7. Out of scope

Read replicas, connection poolers other than the driver's pool, automated Postgres backups and a Helm
chart are not part of this example. For a single-machine deployment keep `compose.yml`
(README, "Run with Docker Compose"); for a one-server managed deployment see
`docs/deployment-coolify.md`.
