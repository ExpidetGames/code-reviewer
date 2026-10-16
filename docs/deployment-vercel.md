# Deploying Code Reviewer on Vercel (hosted deployment)

This is the guide for the **hosted deployment** (umbrella #316): the App as a serverless Vercel project, a
Dispatcher as a second Vercel project, and every review job run by a short-lived Worker inside a fresh Vercel
Sandbox VM. Follow it top to bottom for a first deployment. Every variable, command and step in it was checked
against the code on `development`; section 9 says what no test has proven yet, and that is a lot: **nobody has
run the whole path on Vercel yet** (the first real deployment is the one this guide is written for).

A self-hosted installation (Docker Compose, Coolify) is not affected by anything here and keeps working
unchanged: see section 8 and [`deployment-coolify.md`](deployment-coolify.md).

## Contents

1. [What you are deploying](#1-what-you-are-deploying)
2. [What you need first](#2-what-you-need-first)
3. [Environment variables](#3-environment-variables)
4. [First deployment, step by step](#4-first-deployment-step-by-step)
5. [Operations](#5-operations)
6. [Sizing the Worker VMs](#6-sizing-the-worker-vms)
7. [Rolling back](#7-rolling-back)
8. [Self-hosted and Coolify: nothing changes](#8-self-hosted-and-coolify-nothing-changes)
9. [Known limits and what is not verified](#9-known-limits-and-what-is-not-verified)
10. [Follow-ups](#10-follow-ups)

## 1. What you are deploying

The words below are used exactly like this in the code, the other documents and the log lines
([`dispatcher.md`](dispatcher.md) has the interfaces).

| Term | Meaning |
|---|---|
| **App** | The Next.js app with the database. Receives GitHub webhooks, creates jobs, stores results, serves the UI. It never reviews. Vercel project 1, root directory `app/`. |
| **Dispatcher** | The middle layer. It is woken for a job, claims exactly that job, receives the per-job credential from the App and starts a Worker. It never reviews and never sees the git token or the model key. Vercel project 2, root directory `dispatcher/`, a Hono app. |
| Trigger | How the Dispatcher learns about a job. Hosted: the **Webhook-Trigger** (the App calls it, signed). Self-hosted split (later, #334): the Poll-Trigger. |
| Dispatcher core | Claim, per-job credential handling, concurrency cap, launch error handling. No platform code. |
| Launcher | How a Worker is started. Hosted: the **Sandbox-Launcher** (a fresh VM from the golden snapshot, our hardened container run through Docker inside it). Self-hosted split (later, #334): the Docker-Launcher. |
| **Worker** | The isolated process tree that runs exactly one job: the **Diff-Worker** (PR-Agent) or the **Dynamic-Worker** (OpenCode engine). It knows only the App URL, the job id and a per-job credential. |
| **Worker contract** | What the Worker may do with that credential and nothing more: fetch the job, heartbeat, deliver the result (`/api/workers/v1`, `contracts/worker-api.v1.json`). The same whoever started the Worker. |
| **Golden snapshot** | A snapshot of a VM with a pinned Docker installed and the Worker image already built. Every job gets a fresh clone; a snapshot never holds job data. |

"Runner" is a retired concept, but its names stay: `RUNNER_*` variables, `/api/runners/v1`, the image names.

### One job, end to end (webhook mode)

```
GitHub ──webhook──▶ App ──queues the job, then signed POST /dispatch──▶ Dispatcher (Trigger)
                     ▲                                                     │ core: claim by job id
                     │◀──── claim (RUNNER_TOKEN) / per-job credential ─────┤
                     │                                                     ▼ Sandbox-Launcher
                     │                                      fresh VM from the golden snapshot (fra1)
                     │                                      docker run, credential on stdin only
                     └──── Worker: fetch job, heartbeat, deliver result ◀──── Worker container
```

1. A pull request event reaches the App, which stores a job and, after the transaction committed, sends one signed
   `POST` to the Dispatcher's `/dispatch`.
2. The Dispatcher checks the signature, answers at once (`202`) and continues in the background: it claims exactly
   that job with `RUNNER_TOKEN`. The App enforces the pool cap in the same step and answers with the per-job
   credential. Nothing else reaches the Dispatcher: no git token, no model key.
3. The Sandbox-Launcher creates a VM from the golden snapshot (`persistent: false`, region `fra1`), prepares Docker,
   checks the image id against `SANDBOX_IMAGE_DIGEST` and runs the hardened Worker container. The App URL, the job id
   and the credential go in on **stdin only**.
4. The Worker fetches its job from the App (this is where the git token and the model key are minted, for this job
   only), heartbeats, delivers the result and exits. The Dispatcher stops the VM.
5. The App's cron sweep (once a minute) repairs what can go wrong in between: lapsed leases, resends of wake-ups
   that nobody acknowledged, jobs nobody claimed in time. **It is also the only thing that sends the wake-up for a job
   that is not due yet when it is queued**: an automatic review after a push waits the debounce (90 seconds by default)
   and is sent by the first sweep after that (section 5.7). The per-minute cron is therefore **required**, not a
   convenience.

### The two modes

| | **Poll / Docker** (self-hosted) | **Webhook / Sandbox** (hosted, this guide) |
|---|---|---|
| App runtime | `APP_RUNTIME=server`, a long-lived process, SQLite or Postgres | `APP_RUNTIME=serverless`, functions, Postgres only |
| How a job is found | The runner asks the App every few seconds (`RUNNER_DISPATCH=poll`, the default) | The App wakes the Dispatcher (`RUNNER_DISPATCH=webhook`) |
| Who starts the review | The runner container itself (`RUNNER_MODE=legacy`, today's job loop) | A Worker in a fresh Sandbox VM per job |
| State | `docker compose`, volumes | Postgres, the golden snapshot |
| Status | Today, unchanged. The split variant (Poll-Trigger plus Docker-Launcher) is #334, later | The subject of this guide |

### What the App gains in serverless mode

- No work at start: the schema is migrated by a command (`pnpm migrate`), the first-run setup code is made by a
  command (`pnpm setup-code`), and `/api/health` answers `503` with `{"status":"error","code":"SCHEMA_BEHIND"}` while
  the database lacks a migration of this version.
- Two crons (`app/vercel.json`): `/api/internal/repository-sync` once a day and `/api/internal/dispatch-sweep` **every
  minute**. Both need `CRON_SECRET`.

## 2. What you need first

**Vercel.**

- A team on a plan that allows what `app/vercel.json` and `dispatcher/vercel.json` ask for: a cron that runs **every
  minute** and, for the Dispatcher, a function
  `maxDuration` of **1800 seconds**. 1800 s is the *extended* maximum for Pro and Enterprise teams on Node.js 22 or 24
  and is a **beta limit**; 800 s is the generally available maximum and Hobby is limited to 300 s
  (`dispatcher/README.md`, "The Sandbox-Launcher"). Check your plan's current limits before you start: they are the
  platform's and they change.
- **The per-minute cron is a hard requirement.** It is the App's sweep (`/api/internal/dispatch-sweep`). In webhook
  mode a push-triggered review (a job that waits the debounce, 90 seconds by default) is sent to the Dispatcher **only**
  by that sweep, so **without it push-triggered reviews never start**; an unacknowledged wake-up, a send that failed and a job
  given back after a failed launch are never resent either, and the lease of a Worker that stopped reporting expires
  only late, when another job happens to be claimed. Reviews that are due when they are queued (a pull request
  opened, reopened or marked ready, a person's *Review now*, or any job when `REVIEW_DEBOUNCE_SECONDS` is `0`) are
  sent at once by the enqueue hook and need the cron only if that first send fails. Even with the cron, a debounced review starts **up to about 60 seconds later**
  than on the self-hosted path, where the runner polls every few seconds: it becomes due, then waits for the next
  sweep (the platform may run a cron a little after its minute). A plan that allows only daily crons cannot run this
  deployment; the daily `repository-sync` is not a substitute.
- Access to Vercel Sandbox for the team, in region `fra1`. Every project and snapshot of this deployment is in `fra1`
  and there is **no failover region** (snapshots are region-bound).
- Two projects, from the same Git repository:

  | Project | Root directory | Framework | Config |
  |---|---|---|---|
  | App | `app/` | Next.js | `app/vercel.json`: region `fra1`, `pnpm install --frozen-lockfile`, function durations, the two crons |
  | Dispatcher | `dispatcher/` | Hono (detected from the default export of `src/index.ts`) | `dispatcher/vercel.json`: region `fra1`, `maxDuration` 1800 for `src/index.ts`, one cron (the reaper, every 5 minutes) |

  Both need Node.js 24 (`engines` in both `package.json` files, `.nvmrc`). Set the Node.js version of each project to
  24.x if the project's default differs.
- Crons run **only for the production deployment** of a project. A preview or staged deployment never sweeps (App) and never reaps (Dispatcher).
- A production domain for each project. The **App's URL must be reachable without a login** by GitHub (webhooks), by
  the Worker inside the VM (it calls the App's Worker API and has no way to send a bypass header) and by Vercel's cron.
  Do not put Vercel's Deployment Protection in front of the App's production domain. The Dispatcher is called only
  by the App and by the canary; if you protect it, use Protection Bypass for Automation and set the bypass secret in the two places
  named in section 3.

**An external Postgres, version 15 or newer** (Postgres 18 is what CI tests against, see `compose.large.yml`),
reachable from Vercel's `fra1` functions and from the machine that runs `pnpm migrate`, with TLS. You need **two
roles** and **two URLs**:

| Role | URL | Used by | Needs |
|---|---|---|---|
| **migrate** | `DATABASE_URL_MIGRATE`, a **direct** connection (no pooler: the migration holds a session advisory lock) | `pnpm migrate` and `pnpm setup-code`, run by you, never by a Vercel function | Owns the database and its schema: creates and alters tables and indexes |
| **app** | `DATABASE_URL`, a **direct or session-mode** connection, **never a transaction pooler** | The App's functions | Reads and writes the tables the migrate role created; no DDL |

**Why `DATABASE_URL` must not be a transaction pooler.** The App serializes the integration sync of one GitHub
installation with a *session-level* advisory lock (`pg_advisory_lock`, then `pg_advisory_unlock` on the same session:
`withPostgresAdvisoryLock` in `app/src/db/postgres.ts`; it runs on installation webhooks and in the daily
`repository-sync`). Behind a pooler that hands out a different server connection per transaction, the lock and its
unlock can land on different backends: the serialization is lost, and a lock can stay held on a pooled backend so that
later syncs of that installation wait forever. A direct connection is right, and so is a pooler in **session mode**
(one client keeps one server connection for its whole session). Transaction mode and statement mode are not fine.
Keep `DATABASE_POOL_MAX` small (default 3, 20 at most): every function instance has its own pool, so the number of
connections your database must accept is the number of instances times that. The sweep's own lock is a transaction
lock and would survive a transaction pooler; the sync lock is why the URL cannot (follow-up: #371).

The migrations create tables and indexes only (no extension, type, function or sequence), so the app role needs
`usage` on the schema and `select, insert, update, delete` on the tables, including the tables created later. Run the
commands from a terminal; the three secrets (the admin password and the two role passwords) are read or generated into
shell variables, never typed into a command line, so they stay out of the shell history and the process list. Role
passwords are **hex** (`openssl rand -hex 32`), which cannot break a `postgres://` URL the way a base64 password with
`/`, `+` or `@` does.

```sh
read -rs -p 'Postgres admin password: ' PGPASSWORD; export PGPASSWORD; echo
MIGRATE_PW=$(openssl rand -hex 32); APP_PW=$(openssl rand -hex 32)
# 1. Roles and database, as the administrator, connected to any database:
psql -h <host> -U <admin> -d postgres -v ON_ERROR_STOP=1 <<SQL
create role cr_migrate login password '$MIGRATE_PW';
create role cr_app login password '$APP_PW';
create database code_reviewer owner cr_migrate;
SQL
# 2. The schema's privileges, as the administrator, connected to the new database:
psql -h <host> -U <admin> -d code_reviewer -v ON_ERROR_STOP=1 <<SQL
revoke all on schema public from public;
grant usage, create on schema public to cr_migrate;
grant usage on schema public to cr_app;
SQL
# 3. Default privileges, as the migrate role (it owns the tables, so they cover every table it creates from now on):
PGPASSWORD=$MIGRATE_PW psql -h <host> -U cr_migrate -d code_reviewer -v ON_ERROR_STOP=1 <<SQL
alter default privileges in schema public
  grant select, insert, update, delete on tables to cr_app;
SQL
```

If the admin is not a superuser (managed Postgres), creating a database *owned by* another role needs the admin to be
a member of that role (`grant cr_migrate to <admin>;` first, or your provider's way of doing it). Copy the two
passwords into your password manager now (`printf '%s\n' "$MIGRATE_PW" "$APP_PW"` prints them once, to the terminal
only), then `unset MIGRATE_PW APP_PW`. Steps 1 and 2 show how the URLs are built from them without printing or
recording them.

The privileges of step 3 only cover tables that `cr_migrate` creates **after** it. If the smoke test or the logs show
`permission denied for table ...` (migrate was run before step 3, or by another role), repair it; do not widen the
role:

```sh
read -rs -p 'cr_migrate password: ' PGPASSWORD; export PGPASSWORD; echo
psql -h <host> -U cr_migrate -d code_reviewer -v ON_ERROR_STOP=1 <<SQL
grant select, insert, update, delete on all tables in schema public to cr_app;
SQL
```

The role split is exercised in CI (`app/src/db/role-split.integration.test.ts` runs exactly the SQL above against a real
Postgres: migrate as `cr_migrate`, then health, read and write as `cr_app`, and the repair).

Back up the database yourself (the App starts no backup scheduler with Postgres) and keep a copy of `APP_SECRET`
**apart from it**: a database restored without its `APP_SECRET` loses every stored credential
(`docs/deployment-large.md`, section 5).

**A GitHub App for the hosted instance.** Not the one of any other installation: a GitHub App has exactly one webhook
URL and one callback URL, so the hosted instance needs its own. It is created from the deployed App with one click
(admin portal, Integrations) in step 3, [`github-app.md`](github-app.md) has the details. Nothing about it is an
environment variable.

**GitHub environments** in the repository settings (a workflow cannot protect itself, so you set these):

| Environment | Holds | Protection to set |
|---|---|---|
| `hosted-snapshot` | secrets `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` (of the **Dispatcher's** Vercel project) | Deployment branches: selected branches `main` and `development` only. Required reviewers, with **Prevent self-review** switched on (otherwise whoever starts the run can approve it). The workflow's job runs only from `main` and `development` by its own condition (like the canary's); the branch rule of the environment is the second layer, because a workflow cannot protect itself. |
| `hosted-canary` | secret `RUNNER_TOKEN` (the same value as the Dispatcher project's), and `VERCEL_AUTOMATION_BYPASS_SECRET` only if the Dispatcher is behind Deployment Protection | Deployment branches: selected branches `main` and `development` only. Required reviewers with **Prevent self-review**, as above. Nothing of any other purpose in it. |

Plus one repository variable, `DISPATCHER_CANARY_HOSTS`: the exact host name(s) of the Dispatcher, comma separated
(no scheme, no path). Unset or empty, the canary refuses every URL. Leave `GOLDEN_SNAPSHOT_ENABLED` unset for now
(section 5.1).

**On your machine**, a checkout of `development` (or the release tag), Node.js 24, pnpm 10 and `openssl`:
`pnpm --dir app install --frozen-lockfile` and `pnpm --dir dispatcher install --frozen-lockfile`. The commands in
step 1 to 3 run from there.

## 3. Environment variables

Set them in each Vercel project (Settings, Environment Variables) for the **Production** environment. A change
applies only to deployments made after it: redeploy after every change. "Secret" means: mark it *Sensitive* in
Vercel and never write it in a file, a log or an issue. Placeholders for every variable are in `.env.example`
(App) and `dispatcher/.env.example` (Dispatcher).

### Generating the secrets

Every secret below is random and **different from every other secret** (the App refuses a signing secret that equals
another credential of the App, the Dispatcher one that equals its `RUNNER_TOKEN`). Generate each one into a shell
variable and hand it straight to its destination, so that the value is never typed into a command line, never printed
and never in the shell history:

```sh
# a 64 character secret: RUNNER_TOKEN, CRON_SECRET (one per project), RUNNER_WEBHOOK_SECRET, OPERATOR_API_TOKEN
SECRET=$(openssl rand -hex 32)
printf '%s' "$SECRET" | vercel env add RUNNER_TOKEN production --sensitive     # in the linked project's directory
# the same value into the second place that needs it, then forget it:
printf '%s' "$SECRET" | gh secret set RUNNER_TOKEN --env hosted-canary
unset SECRET
# APP_SECRET, a different call:
SECRET=$(openssl rand -base64 32); printf '%s' "$SECRET" | vercel env add APP_SECRET production --sensitive; unset SECRET
```

`vercel env add NAME production` reads the value from standard input when it is piped (`vercel link` the project's
directory first, `app/` or `dispatcher/`). `printf` is a shell built-in with the value in a variable, so the value is not in the
history or the process list; `echo "<value>" | ...`, which the CLI's own examples show, would put it in the history. The
dashboard (Settings, Environment Variables) works too, with *Sensitive* on. Keep a copy of `APP_SECRET`, and only that
one, in your password manager: it is the one value that cannot be rotated (section 5.2). Rules the code enforces for
every secret: at least 32 characters, no white space or control characters.

### 3.1 The App project

| Variable | Required | Secret | Meaning |
|---|---|---|---|
| `APP_RUNTIME` | yes, set it | no | `serverless`. Vercel sets `VERCEL=1` and that selects serverless by itself, but set it explicitly so a typo cannot start the other mode. Any other value than `server` or `serverless` stops the start (`APP_RUNTIME_INVALID`). |
| `APP_SECRET` | yes | **yes** | The master key: signs sessions and encrypts the credentials in the database. At least 32 characters. Never reused between environments. Changing it signs everybody out and makes stored credentials unreadable. |
| `BETTER_AUTH_URL` | yes, **before the first deployment** | no | The public https address of the App, no path (its production domain, so add the domain to the project first). Without it the App refuses to start (`AUTH_CONFIG_INVALID`). GitHub sends people back to `<this>/api/auth/callback/github`. |
| `DATABASE_URL` | yes | **yes** | The **app role's** Postgres URL (`postgres://` or `postgresql://`; SQLite is refused in serverless mode). **A direct or session-mode connection, never a transaction pooler** (section 2). |
| `DATABASE_POOL_MAX` | optional | no | Connections per function instance, 1 to 20, default 3. Every instance has its own pool: keep it small. |
| `RUNNER_TOKEN` | yes | **yes** | The **dispatcher credential**: what the Dispatcher claims jobs with. At least 32 characters. **Same value as the Dispatcher's `RUNNER_TOKEN`.** There is one token, no overlap while rotating (section 5.2). |
| `CRON_SECRET` | yes | **yes** | Vercel sends it as `Authorization: Bearer ...` to both cron routes. At least 32 characters. Without it every cron call is refused (`401`): no wake-up is resent, lapsed leases expire only late (when another job is claimed) and **push-triggered reviews never start** (section 5.7). Vercel adds the header by itself once the variable exists. |
| `RUNNER_DISPATCH` | yes, **in step 7** | no | `webhook`. Leave it unset (`poll`) until step 7: in poll mode nothing wakes a Dispatcher. |
| `RUNNER_WEBHOOK_URL` | with `webhook` | no | The Dispatcher's wake-up endpoint: `https://<dispatcher production domain>/dispatch`. https, no credentials in it. |
| `RUNNER_WEBHOOK_SECRET` | with `webhook` | **yes** | The key the App signs the wake-up call with. At least 32 characters. **Same value as the Dispatcher's `DISPATCHER_SIGNING_SECRET`.** Different from every other secret. |
| `RUNNER_WEBHOOK_KEY_ID` | optional | no | The key's name, `a-z 0-9 _ -`, at most 32 characters, default `k1`. **Same value as the Dispatcher's `DISPATCHER_SIGNING_KEY_ID`.** Change it on every rotation. |
| `RUNNER_WEBHOOK_SECRET_PREVIOUS`, `RUNNER_WEBHOOK_KEY_ID_PREVIOUS` | optional | **yes** (secret) | The key being replaced, both or neither. Only checked and carried; the App signs with the current key only. |
| `RUNNER_WEBHOOK_BYPASS_TOKEN` | only if the Dispatcher is protected | **yes** | The project's Protection Bypass for Automation secret, sent as `x-vercel-protection-bypass`. Different from the signing secret. |
| `RUNNER_DISPATCH_MAX_RUNNING` | **set it** | no | The pool cap the sweep keeps to when it sends wake-ups, 1 to 1000. **Must equal the Dispatcher's `DISPATCHER_MAX_RUNNING`.** Unset, the App still works (the claim enforces the Dispatcher's cap) but the sweep wakes the Dispatcher for jobs it cannot take. |
| `RUNNER_DISPATCH_GIVE_UP_SECONDS` | optional | no | A job that waited this long without a claim fails with `dispatch_unavailable`. 60 to 604800, default **3600** in webhook mode, off in poll mode, `0` turns it off. It is also the longest a job may queue while the pool is full: set it above the queue you accept. |
| `OPERATOR_API_TOKEN` | optional | **yes** | Switches on the operator API (`/api/operator/v1`: workspaces, entitlements and limits, usage). Unset, the API does not exist (404). At least 32 characters, different from `RUNNER_TOKEN` and `APP_SECRET`. |
| `REVIEW_DEBOUNCE_SECONDS` | optional | no | How long a push waits before its review may start, 0 to 600, default 90. |
| `LLM_MODEL`, `LLM_MAX_TOKENS` | optional | no | The instance's model and context window. For workspaces on their own key they are only the defaults a review setting can override. For **`managed` workspaces** (section 3.5) they are the **model pin**: the instance, not the workspace, chooses the model, for Diff and for Dynamic jobs. `LLM_MODEL` is an OpenRouter name, default `anthropic/claude-haiku-5.5`; a model for Dynamic jobs must be tool-capable (`dynamic-review.md`, "The model"). The LLM key is **not** an environment variable. |

Not set in the project, on purpose:

- `DATABASE_URL_MIGRATE`: the direct URL of the **migrate role**. Only `pnpm migrate` and `pnpm setup-code` read it,
  from the shell you run them in. The App never reads it; do not give it to a function.
- `VERCEL`: set by the platform.
- `NODE_ENV`, `NEXT_RUNTIME`: set by Next.js.
- `DATABASE_PATH`: the file of the SQLite image, unused with Postgres.
- `BETTER_AUTH_SECRET`: the deprecated name of `APP_SECRET`; a new instance never sets it.
- The `GITHUB_*`, `ALLOWED_GITHUB_*`, `LLM_PROVIDER` and `LLM_API_KEY` variables: legacy, for an update of an old
  installation. A hosted instance never sets them.
- `BACKUP_*`, `DATABASE_BUSY_TIMEOUT_MS`: SQLite only.

### 3.2 The Dispatcher project

A refusal at start names the variable, never its value (`ConfigError`: `required`, `invalid`, `too_short`,
`not_distinct`).

| Variable | Required | Secret | Meaning |
|---|---|---|---|
| `RUNNER_API_URL` | yes | no | The App's public URL, `https://<app production domain>` (no path, query or credentials). Also the address the **Worker** inside the VM calls, so it must be reachable from the internet. |
| `RUNNER_TOKEN` | yes | **yes** | The dispatcher credential. **Same value as the App's `RUNNER_TOKEN`** and as the `hosted-canary` secret. |
| `DISPATCHER_MAX_RUNNING` | yes | no | The pool cap, 1 to 1000: how many launches may be in progress, and the cap the App enforces atomically at the claim. **Must equal the App's `RUNNER_DISPATCH_MAX_RUNNING`.** Each running job is one VM. |
| `DISPATCHER_SIGNING_KEY_ID` | yes | no | The key id the App signs with. **Same as the App's `RUNNER_WEBHOOK_KEY_ID`** (`k1` if that is unset). |
| `DISPATCHER_SIGNING_SECRET` | yes | **yes** | **Same value as the App's `RUNNER_WEBHOOK_SECRET`.** At least 32 characters, different from `RUNNER_TOKEN`. |
| `DISPATCHER_SIGNING_KEY_ID_PREVIOUS`, `DISPATCHER_SIGNING_SECRET_PREVIOUS` | optional | **yes** (secret) | The previous key, accepted while keys rotate. Both or neither. |
| `SANDBOX_SNAPSHOT_ID` | yes | no | The golden snapshot: `snapshotId` of the record from step 4. **Unset, the Dispatcher has no Launcher and claims nothing** (every wake-up is answered `200 ignored` with `not_capable`). Set with `SANDBOX_IMAGE_DIGEST` or not at all. |
| `SANDBOX_IMAGE_DIGEST` | with the snapshot | no | The Worker image id in that snapshot (`imageDigest` of the same record), `sha256:` and 64 hex characters. The Launcher refuses a VM whose image has another id. **Always change the two together.** |
| `DISPATCHER_ENGINES` | optional | no | `pr-agent`, `opencode` or both (default both). `pr-agent` for a Diff-only deployment: it has no capability probe and no canary VM. |
| `DISPATCHER_JOB_TIMEOUT_SECONDS` | optional | no | How long a Worker may live, 60 to 21600, default **1200**. Keep it plus the launch (at most 300 s) under the function limit of 1800 s, or supervision ends with the function (section 9). |
| `DISPATCHER_WORKER_CONFIG` | optional | no | JSON `{"diff": {...}, "dynamic": {...}}`: the VM size (`launcher.vcpus`) and the container memory (`container.memory.limit` / `reservation`) per Worker kind. Section 6. A wrong value fails when the function initialises (the variable is named in the log), not at the first job. |
| `DISPATCHER_POOL_ID` | optional | no | Sent as `X-Runner-Id`; the App counts the running jobs of the pool by it. Default `dispatcher`. |
| `SANDBOX_HANDOVER_SECONDS` | optional | no | How long the container must run before the Worker counts as having taken over, 1 to 120, default 20. |
| `SANDBOX_VM_TIMEOUT_MARGIN_SECONDS` | optional | no | Seconds added to the job's timeout for the VM's own timeout, the backstop that ends a VM nobody stopped. At most 3600, at least 180 and 150 above the hand-over time, default 300. |
| `DISPATCHER_PROBE_TTL_SECONDS` | optional | no | How long a capability probe's answer counts, 60 to 86400, default 3600. |
| `DISPATCHER_PROBE_REUSE_SECONDS` | optional | no | A forced probe (`POST /probe`) within this time of the last answer is served from it, 0 to 600, default 60; `0` runs every one. |
| `DISPATCHER_PROBE_TIMEOUT_SECONDS` | optional | no | How long a probe may take, canary VM included, 30 to 600, default 150. |
| `RUNNER_DYNAMIC_CAPABILITIES` | optional | no | Narrows the model's capabilities for Dynamic jobs and the canary: a JSON object on one line, at most 4096 characters. Normally unset (`docs/dynamic-review.md`, "The model"). Read only when `DISPATCHER_ENGINES` includes `opencode`. |
| `RUNNER_DYNAMIC_MAX_COST_USD` | optional | no | The most one Dynamic run may cost, a plain positive decimal such as `2.5`. Unset: the Worker's default. |
| `CRON_SECRET` | yes, with the snapshot | **yes** | The secret Vercel's cron sends to the reaper route (`/api/cron/reap-sandboxes`, every 5 minutes) as `Authorization: Bearer ...`. At least 32 characters, different from `RUNNER_TOKEN` and every signing secret, and **a value of its own: do not reuse the App project's `CRON_SECRET`**. The route exists only when `SANDBOX_SNAPSHOT_ID` is set. Unset, every caller gets `401` and the log warns `reaper_cron_secret_missing`: nothing stops a VM that outlived its job (section 5.5). A malformed value (short, or equal to another secret) stops the start when the snapshot is set; without the snapshot it is ignored with a warning. |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | all three or none | **yes** (the token) | Platform access by access token. **None: the Dispatcher uses the project's own OIDC token**, which Vercel provides inside a function and which needs nothing to rotate. Prefer that. |

Not set by you: `VERCEL_OIDC_TOKEN` (the platform provides it). Only the Node entry (`pnpm start`, not used on
Vercel) reads `DISPATCHER_SHUTDOWN_GRACE_SECONDS` and `PORT`.

### 3.3 What must match between the two projects

| App | Dispatcher | Notes |
|---|---|---|
| `RUNNER_TOKEN` | `RUNNER_TOKEN` (and the `hosted-canary` secret) | One credential, three places |
| `RUNNER_WEBHOOK_SECRET` | `DISPATCHER_SIGNING_SECRET` | The signing key |
| `RUNNER_WEBHOOK_KEY_ID` (default `k1`) | `DISPATCHER_SIGNING_KEY_ID` | Its name |
| `RUNNER_DISPATCH_MAX_RUNNING` | `DISPATCHER_MAX_RUNNING` | The pool cap, both must be set |
| `RUNNER_WEBHOOK_URL` = `https://<dispatcher>/dispatch` | (the Dispatcher's own domain) | |
| `BETTER_AUTH_URL` (the App's domain) | `RUNNER_API_URL` | The same address. The Dispatcher hands it to every Worker as the App URL |
| `RUNNER_WEBHOOK_BYPASS_TOKEN` | the Dispatcher project's bypass secret | Only with Deployment Protection |
| `CRON_SECRET` | `CRON_SECRET` | **Not** the same value: each project has its own, because each cron route must open with its own secret only |

### 3.4 The GitHub side

| Where | Name | Meaning |
|---|---|---|
| environment `hosted-snapshot` | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Platform access for the snapshot build; `VERCEL_PROJECT_ID` is the **Dispatcher's** project. The pipeline hands the token to the platform client and to nothing else. **A Vercel access token acts for its owner in the whole team (or account) it is created for, not for one project**, whatever `VERCEL_PROJECT_ID` says: create it from a dedicated account that has the lowest team role that can create Sandboxes and snapshots, give it an expiry if the dashboard offers one (and a calendar reminder to rotate it before that day), and if the dashboard offers a token limited to the one project, use that. |
| environment `hosted-canary` | `RUNNER_TOKEN`, `VERCEL_AUTOMATION_BYPASS_SECRET` (optional) | The canary's credential and the bypass |
| repository variable | `DISPATCHER_CANARY_HOSTS` | The only host(s) the canary may send the credential to |
| repository variable | `GOLDEN_SNAPSHOT_ENABLED` | `true` makes a push to `main` build a snapshot. Unset: only manual runs |

### 3.5 LLM keys: a workspace's own, or the operator's

- **`own` (the default).** Every workspace enters its own OpenRouter key (Settings, LLM access); it is stored
  encrypted with `APP_SECRET`. A workspace without one fails its runs with `llm_not_configured`.
- **`managed`.** The operator's own key serves the workspaces whose entitlements say `keyMode: "managed"`. The
  instance admin saves that key in the admin portal under **LLM key** (`/admin/llm`): OpenRouter, write-only, encrypted
  in the database with `APP_SECRET` (so whoever holds the database and `APP_SECRET` can decrypt it), never shown again,
  never in a log, a Runs page or an answer of the operator API, and never given to the Dispatcher: the Worker receives
  it from the App when it fetches its job. It is **not** an environment variable and **not** a call of the operator API.
- **Setting a workspace to `managed`** is an entitlement, set with the operator API (`OPERATOR_API_TOKEN` must be set):
  `PUT /api/operator/v1/workspaces/{id}/entitlements` with `"keyMode": "managed"`, the whole entitlements body
  (`contracts/operator-api.v1.json`). A cost limit (`managedCostLimitMicroUsd`) needs `managed` and is a soft cap
  (section 9). The change takes effect at the next claim; a running job is not touched.
- **Upgrade every App instance first.** An instance of a release before #276 does not know the key mode: it would run a
  managed workspace's jobs on the workspace's own key and model and outside the cost limit. Roll the new App out
  completely before the first workspace is set to `managed`.
- **The model is the instance's** while a job runs on the operator's key: `LLM_MODEL` and `LLM_MAX_TOKENS` apply and the
  workspace's `model`, `maxTokens` and Dynamic model review settings are not used (they take effect again if the
  workspace goes back to `own`). The workspace's Settings, LLM access page shows a note instead of a key form.
- **No usable operator key** (none saved, or one that cannot be decrypted, for example after a changed `APP_SECRET`):
  every job of a managed workspace fails with **`llm_not_configured`**, and the log names `operator_key_missing` or
  `operator_key_unreadable`. Save the key in the admin portal and the next job runs. Save it **before** you set the
  first workspace to `managed`.

## 4. First deployment, step by step

Do the steps in this order (migrate, App, setup code, snapshot, Dispatcher, canary, webhook, smoke test); each one has a check. Nothing is lost if you stop between steps.

### Step 1. Migrate the database

```sh
read -rs -p 'cr_migrate password: ' MIGRATE_PW; echo
export DATABASE_URL_MIGRATE="postgres://cr_migrate:${MIGRATE_PW}@<direct host>:5432/code_reviewer?sslmode=require"
unset MIGRATE_PW
pnpm --dir app migrate
```

(`read -rs` keeps the password out of the history and the process list. The URL stays in this shell only; close the
shell when you are done with steps 1 to 3.)

`pnpm migrate` takes the advisory lock `code-reviewer:migrate`, applies every pending migration in one transaction
and exits 0 (`[migrate] applied N migration(s): ...` or `[migrate] the schema is up to date, nothing to apply.`) or
exits 1 with one line and a code (a failed batch is rolled back). Two runs take turns. The URL is not printed.
**Check:** run it again; it must say that nothing is left to apply.

Run it again before **every** later deployment, before the new version takes traffic. The App never migrates by
itself.

### Step 2. Deploy the App (still in poll mode)

1. Create the App project (root directory `app/`) and add its **production domain** first: `BETTER_AUTH_URL` must be
   that address, and the App refuses to start without it.
2. Set the variables of section 3.1 **except** the `RUNNER_DISPATCH` and `RUNNER_WEBHOOK_*` ones (poll mode is the
   default; webhook mode is step 7), including `BETTER_AUTH_URL` and `CRON_SECRET`, with the commands of "Generating the
   secrets". The database URL of the app role, read from a prompt and piped, never printed:

   ```sh
   read -rs -p 'cr_app password: ' APP_PW; echo
   printf '%s' "postgres://cr_app:${APP_PW}@<host>:5432/code_reviewer?sslmode=require" | vercel env add DATABASE_URL production --sensitive
   unset APP_PW
   ```
3. Deploy the production branch.

**Check:** `https://<app>/api/health` answers `200 {"status":"ok"}`. `503` with `SCHEMA_BEHIND` means step 1 was
not run against this database, `503` without a code means the database is not reachable with `DATABASE_URL`. In the
function log the start line says the operator API state (`[operator-api] off` or `on`).

Also check that the crons exist (the project's Cron Jobs settings list two) and that the sweep is not refused: its
runs show `200` once `CRON_SECRET` is set (`401 CRON_UNAUTHORIZED` means the variable is missing or not 32
characters, and the deployment was made before it was set).

### Step 3. The setup code, then the first-run setup in the browser

A serverless instance has no log the operator reads, so the setup code is made by a command, with the same
`APP_SECRET` as the deployment:

```sh
read -rs -p 'APP_SECRET of the deployment: ' APP_SECRET; echo; export APP_SECRET
APP_RUNTIME=serverless pnpm --dir app setup-code
```

(with `DATABASE_URL_MIGRATE` still exported; `unset APP_SECRET` afterwards). It prints `[setup-code] Setup code: <6 digits>`, valid for 60
minutes; running it again makes a new code and ends the old one. It refuses to print to anything but a terminal
(`SETUP_CODE_NOT_A_TERMINAL`; `--allow-pipe` overrides, only if you know where the output goes), on a database
that is behind (`SETUP_CODE_SCHEMA_BEHIND`: run step 1) and on an instance that is already set up
(`SETUP_ALREADY_DONE`).

Open `https://<app>`, enter the code and answer the three questions (tenancy, who may sign up, the admin account).
After that:

1. In the admin portal, **Integrations**, create the GitHub App of this instance with one click
   ([`github-app.md`](github-app.md)): its webhook URL is `https://<app>/api/webhooks/github-app`. Use the
   hosted instance's **own** App.
2. Install the App on one test repository, activate the repository as a project, and in the workspace enter an LLM
   key (Settings, LLM access). Without it a run ends `llm_not_configured`.
3. Only if you operate `managed` workspaces (section 3.5): save the operator's key under **LLM key** (`/admin/llm`) now.
   It is optional for the first deployment and the smoke test.

Do not open test pull requests yet: no Dispatcher exists, so a job would only wait (the sweep sends it after step 7).

### Step 4. Build the golden snapshot

The snapshot is built inside a builder VM by the workflow `.github/workflows/golden-snapshot.yml`; the Worker image
is built from the commit **inside that VM**, with no registry and no registry credential
([`golden-snapshot.md`](golden-snapshot.md) has every step and failure code).

1. Create the **Dispatcher project** now (root directory `dispatcher/`, no variables yet, no deployment needed): the
   token and project id of the `hosted-snapshot` environment point at it, because the Launcher creates job VMs in the
   project it runs in and the snapshot has to be in that project.
2. Set the three secrets of `hosted-snapshot` (section 3.4), for example `printf '%s' "$TOKEN" | gh secret set VERCEL_TOKEN --env hosted-snapshot` with the token read into `TOKEN` by `read -rs`.
3. Actions, *Golden snapshot*, *Run workflow* on `development` (or the release tag's branch): `target` stays
   `sandbox`; `pinned_snapshot` stays empty on the first run. A reviewer approves the environment.
4. About two minutes later the run summary shows the **record**:

   ```json
   { "version": 1, "snapshotId": "snap_...", "imageDigest": "sha256:<64 hex>", "builtAt": "<UTC time>", "region": "fra1", "target": "sandbox", "commit": "<sha>" }
   ```

   It is also the artifact `golden-snapshot-record` (90 days). Keep it: `snapshotId` and `imageDigest` go into the
   Dispatcher project in step 5. The record is not a secret and **is not committed** (nobody commits account or
   snapshot ids).

The run fails closed: any failed check withdraws the snapshot, and the log line `golden_snapshot_failed` has the
code ([`golden-snapshot.md`](golden-snapshot.md), "Failure codes"). **Before the first Dynamic activation** also do
the manual check of the first real snapshot named there (create a VM from it, list images and containers, look for
anything that is not an apt, Docker or build artifact).

### Step 5. Deploy the Dispatcher

Set the variables of section 3.2 in the Dispatcher project: `RUNNER_API_URL`, `RUNNER_TOKEN`,
`DISPATCHER_MAX_RUNNING` (start small, for example `2`), `DISPATCHER_SIGNING_KEY_ID` (`k1`),
`DISPATCHER_SIGNING_SECRET`, `SANDBOX_SNAPSHOT_ID` and `SANDBOX_IMAGE_DIGEST` from the record, `CRON_SECRET` (the reaper's, section 5.5), and optionally
`DISPATCHER_ENGINES`, `DISPATCHER_WORKER_CONFIG` (section 6). Leave `VERCEL_TOKEN` and its siblings unset to use the
project's OIDC token. Deploy.

**Check:** `https://<dispatcher>/health` answers `200 {"status":"ok"}`. The settings are read when the function
initialises, so a bad value shows as failing requests and a log line that names the variable
(`SANDBOX_SNAPSHOT_ID is required`, `DISPATCHER_WORKER_CONFIG is invalid`, ...), not as a failed build. If you
protect the project with Deployment Protection, every path answers the platform's login page until the bypass header
is sent: confirm `curl -s -o /dev/null -w '%{http_code}' -H 'x-vercel-protection-bypass: <secret>' https://<dispatcher>/health`
prints `200` before step 7, or every wake-up waits half an hour (section 5.3).

Check the reaper too: the Dispatcher's Cron Jobs settings list it, and its first runs answer `200` (`401` means
`CRON_SECRET` is missing or malformed in this project). **If the project is behind Deployment Protection, that the
platform's cron gets past it is not verified** (I could not confirm it from the platform's documentation): look at the
first run, and if it is refused, either switch protection off for the production domain (the Dispatcher checks a
signature or a credential on every route that does anything) or reap by hand (section 5.5).

Then add the Dispatcher's production host (exact, no scheme or path) to the repository variable
`DISPATCHER_CANARY_HOSTS` and the Dispatcher's `RUNNER_TOKEN` to the `hosted-canary` environment (and the bypass secret,
if it is protected).

### Step 6. Run the canary

Actions, *Dispatcher canary*, *Run workflow* on `main` or `development` (the job refuses other branches): `url` is
`https://<dispatcher>`, `engines` is `pr-agent,opencode` (or `pr-agent` for a Diff-only deployment). A reviewer
approves the `hosted-canary` environment. The step first checks the URL against `DISPATCHER_CANARY_HOSTS` without any
secret, waits for `GET /health`, then calls `POST /probe`, which creates a canary VM from the snapshot, runs the
image's `probe` mode with the real container flags and reports.

**Pass:** exit 0, the deployment advertises every required engine from a probe that ran just now. **Fail** (exit 1):
read the stable reasons in the output (`dispatcher/README.md`, "The capability probe"; for a platform error the code is
one of the closed `ProbeFailure` list, for a `denied` verdict the reasons of the startup self-check in
[`dynamic-review.md`](dynamic-review.md)) and do not go on. Exit 2 means a wrong URL or option and nothing was sent.

For the very first deployment the production deployment is the candidate, as above. **For every later release the
candidate is a staged production deployment** (section 5.1): that is the only place where the new snapshot can be proven
before production uses it.

### Step 7. Switch the App to webhook mode

In the App project add `RUNNER_DISPATCH=webhook`, `RUNNER_WEBHOOK_URL=https://<dispatcher>/dispatch`,
`RUNNER_WEBHOOK_SECRET` and `RUNNER_WEBHOOK_KEY_ID` (the Dispatcher's two signing values), `RUNNER_DISPATCH_MAX_RUNNING`
(= `DISPATCHER_MAX_RUNNING`) and, if needed, `RUNNER_WEBHOOK_BYPASS_TOKEN`. Redeploy.

**Check:** the deployment starts. A webhook mode with a missing URL, a short or reused signing secret stops the start
with `DEPLOY_CONFIG_INVALID` naming the variables (never the values).

**Switch soon after step 3, and before pull requests are opened.** In poll mode the give-up is off. The first
webhook-mode sweep applies `RUNNER_DISPATCH_GIVE_UP_SECONDS` (default 3600) to every job that has been queued longer
than that: such a job is **not woken, it fails with `dispatch_unavailable`** (no attempt is counted, and the next push or
*Review now* runs it again). Steps 4 to 6 take well under an hour, and you opened no pull request before this step,
so normally nothing waits. If something does, let it fail and trigger it again, or raise the give-up time for the
switch and lower it afterwards. Jobs queued for less than the give-up time are woken by the first sweep within a
minute.

### Step 8. Smoke test: a Diff review, then a Dynamic review

**Diff.** Open (or push to) a pull request on the test repository, or use *Review now* on its page.

- Runs page: the run goes `queued`, `running`, `succeeded`; a review comment appears on the pull request.
- Dispatcher function log: `launched` for the job id (`launch_failed` with a `code` if it did not).
- The platform lists one VM named `cr-diff-<job id>-<random>` while it works (dashboard, or `Sandbox.list`), and it
  is gone, or stopped, afterwards.
- A run that stays `queued` for more than a few minutes: section 5.3.
- **Push to the open pull request** once the first review is done: the new review does not start at once. It starts
  after the debounce (90 seconds) plus up to about a minute for the next sweep (section 5.7). If it never starts, the
  sweep is not running.

**Dynamic.** Dynamic Review is off for an instance until the admin turns it on, and it is only available when
the canary of step 6 passed with `opencode`:

1. Admin, Setup, Instance, **Dynamic Review**: tick *Allow Dynamic Review on this instance*. Read
   [`dynamic-review.md`](dynamic-review.md), "Activation, step by step", step 1 and its rollback first: every App
   instance must already run the version that routes by review kind.
2. On the test project's settings page set the review kind to Dynamic.
3. Open a pull request. The first Dynamic wake-up after the Dispatcher has been idle for an hour (or on a cold
   instance) answers `503` with `Retry-After` while the probe runs (section 9); the App asks again.
4. The Run shows the kind, the model and a result URL, and the summary comment is published.

**Done when:** one Diff run and one Dynamic run have succeeded, the Dispatcher log shows no `launch_failed`, the
sweep answers `200` every minute, and no VM of the test is left running.

## 5. Operations

### 5.1 Rebuild the snapshot (with a pin)

Rebuild on every image release (a stale snapshot is a stale Worker image: the Launcher's digest check refuses it),
when the pinned Docker version or `docker/sandbox/vm-prepare.sh` changes, or when the platform's base image changes.
The full procedure is in [`golden-snapshot.md`](golden-snapshot.md), "Rebuild"; the short form:

1. Run the workflow with **`pinned_snapshot` set to the `snapshotId` the Dispatcher uses now**. Retention really
   deletes old builders and their snapshots after a successful run (it keeps the newest two and every pin): a snapshot
   in use that is neither is **deleted**, and the Dispatcher then fails every job with `sandbox_snapshot_missing`.
2. Take the new record from the summary.
3. Put the new `SANDBOX_SNAPSHOT_ID` and `SANDBOX_IMAGE_DIGEST` into the Dispatcher project's **production**
   variables **without promoting anything**: a variable change affects only deployments made afterwards, so the live
   deployment keeps the old pair. Then make a **staged production deployment**, which uses the production variables
   but is not assigned the production domains:

   ```sh
   cd dispatcher && vercel deploy --prod --skip-domain      # prints the deployment URL
   ```

   Why not a preview deployment: a preview gets the project's *Preview* variables, which the guide does not set (it would
   fail at start for want of `RUNNER_TOKEN` and the snapshot pair), its host changes with every deployment, and neither
   the reaper nor any cron runs there.
4. Prove it. The canary refuses a host that is not in the repository variable `DISPATCHER_CANARY_HOSTS` (exact host
   names, comma separated), and the staged deployment has a host of its own: add it to the variable first. If the project's
   Deployment Protection covers generated deployment URLs, the canary needs the project's bypass secret as
   `VERCEL_AUTOMATION_BYPASS_SECRET` in `hosted-canary`; with protection off it needs nothing more. Run the *Dispatcher
   canary* workflow with `url` = the staged deployment (step 6). The probe creates its canary VM from the **new** snapshot, because
   that deployment carries the new pair.
5. Only on exit 0 promote: `vercel promote <deployment-url>`. On a failure, do not promote; put the old pair back into the
   variables (a later deployment must not pick the new pair up by accident) and delete the staged deployment.
6. Remove the staged deployment's host from `DISPATCHER_CANARY_HOSTS` (the credential must go only to hosts you mean
   it for), and on the next snapshot run pass the **new** snapshot id as the pin.

`GOLDEN_SNAPSHOT_ENABLED=true` makes every push to `main` build a snapshot, but nothing changes a deployment by
itself: marking a snapshot current is always this manual step, and a rebuilt image whose digest differs from the
configured one is refused by the Launcher until you do it.

### 5.2 Rotating secrets

| Secret | How |
|---|---|
| **Webhook signing key** (`RUNNER_WEBHOOK_SECRET`, `DISPATCHER_SIGNING_SECRET`) | No gap, in this order: (1) in the Dispatcher project set the new key as current (`DISPATCHER_SIGNING_KEY_ID`, `DISPATCHER_SIGNING_SECRET`) and the old one as `..._PREVIOUS`, redeploy; (2) in the App project set the new key (`RUNNER_WEBHOOK_KEY_ID`, `RUNNER_WEBHOOK_SECRET`), redeploy; (3) after at least 5 minutes (the receiver's clock tolerance) remove the previous key from the Dispatcher and redeploy. Use a **new key id** each time. |
| **`RUNNER_TOKEN`** (the dispatcher credential) | The App accepts exactly one, so there is a short gap: set the new value in the App and the Dispatcher projects and in the `hosted-canary` environment, redeploy **both**. Claims that arrive between the two deployments fail and the job stays queued, to be resent by the sweep; running Workers are not affected (they use their per-job credential, not this token). Do it when the queue is quiet. |
| **Vercel access** | With OIDC (no `VERCEL_TOKEN` in the Dispatcher project) there is nothing to rotate for the Launcher. For the snapshot pipeline: create a new access token (a dedicated one, with an expiry if the dashboard offers it: section 3.4), update `VERCEL_TOKEN` in `hosted-snapshot` (and in the Dispatcher project if you chose token auth there, then redeploy), run a harmless check (a snapshot run, or the canary), then revoke the old token. |
| **Bypass secret** | Regenerate it in the Dispatcher project's Deployment Protection settings, then update `RUNNER_WEBHOOK_BYPASS_TOKEN` (App, redeploy) and `VERCEL_AUTOMATION_BYPASS_SECRET` (`hosted-canary`). Wake-ups fail with `DISPATCH_REJECTED` in between. |
| **`CRON_SECRET`** (App and Dispatcher, two separate values) | Change it in the project, redeploy. Vercel sends the new value to the next cron call; until the deployment is live the calls are refused (`401`) and a minute of the sweep is lost. |
| **`OPERATOR_API_TOKEN`** | Change it, redeploy, give the operator's client the new one. |
| **`APP_SECRET`** | Not rotatable: changing it signs everybody out and makes every stored credential (GitHub App key, mail password, workspace LLM keys) unreadable. |

Any secret that was ever in a log, a chat or an issue is rotated the same way.

### 5.3 Reading what the Runs page and the logs say

A run's error code is shown on the Runs pages with a fixed sentence. Four belong to the hosted deployment:

| Where | Code | Meaning and what to do |
|---|---|---|
| Runs page | `dispatch_unavailable` | The job waited `RUNNER_DISPATCH_GIVE_UP_SECONDS` (60 minutes by default) without anyone claiming it, no attempt is counted, and the next push or review request runs it again. Look at the **App's** sweep and send logs (`DISPATCH_SEND_FAILED`, `DISPATCH_REJECTED`) and at the Dispatcher's log. Usual causes: `RUNNER_WEBHOOK_URL` or the signing key do not match (`DISPATCH_REJECTED`: a wrong URL or secret looks like this and the App waits 30 minutes between tries), the Dispatcher is down or protected, `SANDBOX_SNAPSHOT_ID` is unset (`not_capable`), the pool is full for longer than the give-up time, or the sweep itself is refused (`CRON_SECRET`). |
| Runs page | `launch_failed` | The Worker could not be started even after three attempts. The cause is a launch code in the **Dispatcher's** log (line `launch_failed`, field `code`, plus `retryable`): the table in `dispatcher/README.md` ("The Sandbox-Launcher") lists them (`sandbox_auth_failed`, `sandbox_snapshot_missing`, `image_mismatch`, `docker_not_ready`, `worker_exited_early`, ...). |
| Runs page | `worker_exited` | The Worker was started and took over, but its container ended with an error before it reported a result, three times. The Dispatcher gave the job back as soon as it saw the end, instead of after the two minute lease. The Dispatcher's log has `worker_exited` with the `exitCode` (2: the Worker could not set up, for example a bad image or configuration; 137: killed, usually out of memory: raise the container's memory limit) and `released` with the same `reason`. |
| Dispatcher log only | `capability_not_proven` | A Dynamic job was claimed but no fresh passing probe answer counted at launch. The job is released as `launch_failed` (so the Runs page shows that). It means the probe went stale or failed between the claim and the launch, or the canary VM cannot prove the hardening: run the canary, read the reasons, and see `dynamic_isolation_self_check_failed` in [`dynamic-review.md`](dynamic-review.md). Diff jobs are not affected. |

Others you will meet: `no_capable_runner` (a Dynamic job nobody could run for 30 minutes: the probe says no, or
`DISPATCHER_ENGINES` has no `opencode`), `dynamic_review_disabled` (the gate is off), `lease_expired` (the Worker
stopped reporting), `quota_exhausted`, `workspace_suspended` and `entitlements_invalid` (the workspace's limits, set
through the operator API), `llm_not_configured` (the workspace has no LLM key, or it is `managed` and the operator has no usable key: section 3.5). The wake-up call's answers (`202`,
`200 ignored` with `not_claimable` or `not_capable`, `429`, `503`) and the App's back-off are in
`app/src/dispatch/README.md`, "What an answer means".

Logs: the App function logs `[sweep] requeued=.. given_up=.. sent=..` for a run that did something, `[dispatch]
DISPATCH_SEND_FAILED ...`, `[database] SCHEMA_BEHIND ...`; the Dispatcher logs `launched`, `launch_failed`,
`released`, `release_failed`, `lease_lost`, `probe_passed`, `probe_denied`, `probe_failed`. None holds a secret or a
URL.

### 5.4 Switching Dynamic Review off, and stopping the Dispatcher

- **Dynamic off, instantly:** Admin, Setup, Instance, Dynamic Review, untick. Waiting Dynamic jobs are cancelled
  `dynamic_review_disabled`; running ones finish.
- **Diff only:** set `DISPATCHER_ENGINES=pr-agent` and redeploy: no probe, no canary VM.
- **No Launcher:** unset `SANDBOX_SNAPSHOT_ID` and `SANDBOX_IMAGE_DIGEST` and redeploy: the Dispatcher claims nothing.
  Waiting jobs are not lost: Diff jobs fail with `dispatch_unavailable` after the give-up time, Dynamic ones with
  `no_capable_runner` after 30 minutes.
- **No more wake-ups:** `RUNNER_DISPATCH=poll` in the App. Jobs stay queued; nobody claims them.

### 5.5 Stopping VMs that outlived their job (the reaper)

The Dispatcher stops a job's VM from `waitUntil` work, which lives as long as the function. A job longer than the
function's limit, a restart or a failed stop leave the VM running, idle and billed, until its own timeout (job
timeout plus `SANDBOX_VM_TIMEOUT_MARGIN_SECONDS`). The **reaper** (#364) is the second line: Vercel's cron calls
`GET /api/cron/reap-sandboxes` of the Dispatcher every 5 minutes with `CRON_SECRET`, and it stops the VMs of this
deployment that outlived their purpose.

- It lists only VMs named `cr-...` with the tag `app = code-reviewer` and checks each again: only a running,
  non-persistent VM of exactly the shape our code creates is ever stopped. The snapshot pipeline's builder and check
  VMs and anything else in the project never match.
- A VM younger than 2 minutes is never touched. One older than its own lifetime plus 2 minutes is stopped whatever the
  App says. A job VM whose job the App reports as not `running` is stopped; if the App's answer cannot be read the VM
  is **kept** (only its lifetime ends it then). A canary VM is ended by its lifetime only.
- The answer and the log hold counts and stable codes only: `listed`, `candidates`, `stopped`, `kept`, `unreadable`,
  `failed`; events `vm_reaped`, `vm_reap_failed`, `job_state_unreadable`, `reap_done`, `reap_list_failed`. A `500` with
  `REAP_LIST_FAILED` means the platform's listing failed; nothing was stopped and the next run tries again.
- **To check it:** Vercel's Cron Jobs settings of the Dispatcher project show the runs. During the smoke test, list the
  project's VMs after a job: none should be left running with a `cr-` name.
- **Deployment Protection:** whether the platform's cron is let through when the Dispatcher project is protected is not
  verified (step 5 says how to look).
- **If it does not run** (no `CRON_SECRET`, no snapshot configured, protection in the way, a plan that does not allow the cron), list the
  project's VMs now and then (names start with `cr-`, tags `app`, `kind`, `job`) and stop any that is older than a job
  can be. Leftover builders of the snapshot pipeline (`code-reviewer-golden-builder-*`) are handled in
  [`golden-snapshot.md`](golden-snapshot.md).

The reaper is not verified against the live platform: that the platform's listing honours the name prefix together with a tag
and reports `status`, `createdAt`, `timeout` and `tags` as the SDK types say, and that the project's cron may run every five
minutes. The reaper checks every VM itself, so it does not depend on the platform's filter.

### 5.6 Updating the App or the Dispatcher

Order: **migrate, then deploy**. `pnpm --dir app migrate`, then deploy the App. Do not rely on the platform to hold
traffic back from a deployment that is ahead of the database: it answers `/api/health` with `SCHEMA_BEHIND`, but
nothing stops it from being promoted. A migration always works for the version that is still running (additions
first, removals one release later), so an App instance **behind** the database is healthy and an instance **ahead**
of it reports `SCHEMA_BEHIND`. Update the Dispatcher after the App when a release changes the runner API
(`GET /api/runners/v1/version` lists the App's features; a Dispatcher that finds one missing answers `503` and claims
nothing).

### 5.7 What depends on the per-minute sweep

The App's sweep (`GET /api/internal/dispatch-sweep`, every minute, `CRON_SECRET`) is part of the path of a review,
not only a repair service (`app/src/dispatch/README.md`, "The cron sweep"). In webhook mode:

| Job | Who sends the wake-up | Without the sweep |
|---|---|---|
| Due when queued: opened, reopened, ready for review, *Review now*, any job with `REVIEW_DEBOUNCE_SECONDS=0` | The App's enqueue hook, at once; **a send that fails is retried only by the sweep** | Works if the first send succeeds; a failed send is never retried |
| **Not due yet** when queued: an automatic review after a push (debounce, 90 s by default) | **The sweep**, when the job becomes due | **Never starts** |
| A wake-up nobody acknowledged, or a job given back after a failed launch | The sweep, at the next run after the acknowledgement timeout (2 minutes) | Never resent |
| A running job whose Worker stopped reporting | The sweep expires its lease and requeues it | Expires late: every claim also expires lapsed leases (`claimNext`), so it ends only when some job, possibly the next one of the same pull request, is claimed |
| A job nobody claimed for `RUNNER_DISPATCH_GIVE_UP_SECONDS` | The sweep fails it with `dispatch_unavailable` | Waits forever |

So a debounced review starts after **the debounce plus up to about 60 seconds** (it is sent at the first sweep after it
is due; Vercel may run a cron slightly late), against a few seconds on a self-hosted runner. If a team finds that too
slow, `REVIEW_DEBOUNCE_SECONDS=0` makes automatic reviews due at once, so the enqueue hook sends them without waiting for the
sweep, at the price of one review per push instead of one per burst of pushes.

**To see that it runs:** the App project's Cron Jobs settings list `/api/internal/dispatch-sweep` and its runs answer
`200`; the log shows `[sweep] requeued=.. given_up=.. sent=..` for every run that did something (a debounced review that
was sent shows as `sent=1`); `401 CRON_UNAUTHORIZED` means `CRON_SECRET` is missing or short, and `404` means the App is
not in serverless mode (`APP_RUNTIME`). The cron runs only for the **production** deployment, so a staged or preview
deployment never sweeps. If a push-triggered review does not start within the debounce plus about two minutes, look at
the sweep first, then at section 5.3.

## 6. Sizing the Worker VMs

A Sandbox VM has 1 vCPU or an even number up to 8, and **2 GiB of memory per vCPU**: the smallest is 1 vCPU / 2 GB.
`DISPATCHER_WORKER_CONFIG` sets the size per Worker kind:

```json
{"dynamic": {"launcher": {"vcpus": 2}, "container": {"memory": {"limit": "3g", "reservation": "2g"}}}}
```

| Setting | Default | Notes |
|---|---|---|
| `launcher.vcpus` | 1 (1 vCPU / 2 GB) for both kinds | `1`, `2`, `4`, `6` or `8` |
| `container.memory.limit` | `1536m` | Leaves room for `dockerd` and the OS in a 2 GB VM; a limit that leaves the VM less than 256 MiB is refused. A 2 GB limit on a 2 GB VM gets killed by the VM's own memory cgroup (spike #317) |
| `container.memory.reservation` | `1280m` | |

Measured on the platform (spike #317 and the snapshot runs, region `fra1`): create from snapshot about 2 s, Docker
ready about 1 s after, the container's self-check plus start about 7 s, the whole path to "advertised" about 12 s; an
idle Worker container peaks near 360 MB. **The Dynamic-Worker's real worst case is not measured** (the spike ran no real
review): start with 2 vCPU / 4 GB and a 3 GiB limit for `dynamic` if you see `OOMKilled` or `worker_exited_early`, and
leave `diff` at the default until a real Diff review shows otherwise. A size change is configuration, not code, and
the canary uses the Dynamic size, so run it after changing it.

## 7. Rolling back

| What | How |
|---|---|
| **The App** | Vercel's instant rollback to the previous production deployment. Safe as long as the migrations since were additive (the previous version runs on a database that is ahead of it). A migration that has run is never undone. |
| **The Dispatcher** | Roll back the deployment, or set the previous `SANDBOX_SNAPSHOT_ID` **together with** its `SANDBOX_IMAGE_DIGEST` and redeploy. |
| **The snapshot** | Take the previous record (artifact of that run, or the builder `code-reviewer-golden-builder-<time>` whose `currentSnapshotId` you want) and put both values back. Then pin the snapshot in use in the next build so retention does not delete it ([`golden-snapshot.md`](golden-snapshot.md), "Roll back"). The previous snapshot exists only while retention has not removed it. |
| **Webhook mode** | `RUNNER_DISPATCH=poll` stops the wake-ups. It is not a way back to the self-hosted runner: the hosted App has no runner that polls (section 8). |
| **Dynamic Review** | The gate (section 5.4). |
| **A secret** | Section 5.2. |

## 8. Self-hosted and Coolify: nothing changes

An installation on Docker Compose or Coolify keeps its runner as it is: `RUNNER_MODE` unset means `legacy` (the job
loop that claims with `RUNNER_TOKEN` and reviews inside the runner container), `RUNNER_DISPATCH` unset means
`poll`, `APP_RUNTIME` unset means `server`. Updating such an installation to a release that contains the hosted
deployment changes no behavior and needs no new variable, and the images, `compose.yml`, `compose.coolify.yml` and
`/api/runners/v1` stay as they are ([`deployment-coolify.md`](deployment-coolify.md),
[`deployment-large.md`](deployment-large.md)).

The **split** for self-hosted installations (the Poll-Trigger and the Docker-Launcher: a Dispatcher that polls and
starts a Worker as its own process and user inside the hardened container) is **#334** and later; the default flips
to `split` only after a soak (#335). Until those issues land, the Dispatcher project in `dispatcher/` has no engine
on the Node entry and there is nothing to migrate to. The migration step table (the `RUNNER_MODE` switch) will be
added to `deployment-coolify.md` and `dynamic-review.md` with #334.

A self-hosted installation and a hosted one never share a database or a GitHub App.

## 9. Known limits and what is not verified

**Not verified on the real platform (the first deployment is the test):**

- The **Dispatcher on Vercel**: deploying `dispatcher/`, `waitUntil` supervision for a job's whole life, the 1800 s
  function limit (a beta limit), the cold-start and the probe behavior, and the OIDC authentication of the Sandbox
  SDK from a function. The spike did not deploy a function (its probe T14 was not run). The unit and integration
  tests run against the doubles in `fakes/`.
- The **mapping of the platform's errors** to launch codes goes by status and by words of the message; the platform's
  error bodies are undocumented, so it is not verified against the live API (`dispatcher/README.md`).
- **The whole chain on the real platform**: signed wake-up, claim, VM, Worker, result on a real GitHub pull request.
  CI runs the whole flow on fakes in the lane **`e2e-hosted`** (#332; `make test-e2e-hosted`, which needs a Postgres
  in `E2E_DATABASE_URL`; `TESTING.md`, "Hosted e2e lane"): the App in serverless mode on Postgres, the Dispatcher, the
  real Worker and PR-Agent, the Sandbox-Launcher over the local Sandbox double, and the failure journeys (Dispatcher
  down, give-up, launch failures, a Worker that dies, the pool cap, a probe that fails, secrets in logs); the privileged
  lane `e2e-dynamic` adds the Dynamic journey with the real container's hardening. None of it touches Vercel, a real
  GitHub or a real model: this guide's step 8 is the manual twin on the real platform.
- **The reaper** against the live platform (section 5.5), and whether the platform's cron reaches it while the Dispatcher project is behind Deployment Protection.
- The **database role split** of section 2 on **your** Postgres provider. CI runs the guide's SQL against a plain
  `postgres:18` (`app/src/db/role-split.integration.test.ts`); a managed provider's rules for roles and owners may differ.
- **Dynamic Review memory**: the worst case in a 2 GB VM is unmeasured (section 6).
- The **golden snapshot** passed its checks in two real runs (the pinned Docker versions, the scan, the probe line).
  Retention was broken on the real platform in those runs and fixed in #365; its behavior on the real platform since
  the fix is not recorded. See "Not verified yet" in [`golden-snapshot.md`](golden-snapshot.md).

**Limits by design:**

- **One region.** `fra1` for the functions, the VMs and the snapshots; no failover.
- **The cost limit of a workspace is a soft cap** (`managedCostLimitMicroUsd`): cost is known only when a run settles,
  so runs in flight are not in the sum and a workspace can end above its limit by what the concurrent runs cost. The run
  limits are exact. A run with an unknown cost counts for nothing (`unknownCostCount` in the operator API's summary).
  A limit for runs on a workspace's own key is #361. Limits and the key mode are set through the operator API; the
  operator's own key (section 3.5) is saved by the instance admin only, and a workspace set to `managed` before every App
  instance runs the release that knows the key mode is served by the wrong key and outside the limit.
- **A managed workspace has no model of its own**: the instance's `LLM_MODEL` and `LLM_MAX_TOKENS` apply to all of them
  until managed quality tiers exist (#280, #283).
- **A Worker whose end the Dispatcher does not see still holds its slot until its lease lapses** (two minutes after its
  last heartbeat); only the next sweep then puts the job back, and the pull request shows "Running" meanwhile. A Worker
  that exits non-zero before it has reported a result is released at once when the Dispatcher sees the container end
  (`worker_exited`, section 5.3). The lease is still the safeguard where it does not: the wait for the container failed
  (`worker_wait_failed`: what became of the Worker is unknown, so nothing is released), the Dispatcher's function ended
  before the container did, and a Launcher that does not supervise the Worker. The attempt is lost either way (three, then
  `failed`); the delay is the cost.
- **A debounced review starts up to about 60 seconds later than self-hosted**, and only while the per-minute cron
  runs (section 5.7); the first automatic review of a pull request (opened) is sent at once.
- **The capability probe.** One answer per Dispatcher *instance*, held in memory for `DISPATCHER_PROBE_TTL_SECONDS`
  (1 hour). The first Dynamic wake-up after the hour, and the first one on every **cold instance**, finds nothing
  proven, starts a probe (one canary VM, tens of seconds) and is answered `503` with `Retry-After: 20`; Dynamic jobs
  are delayed by that, and a `failed` probe holds Dynamic back for another minute. Many cold instances mean many canary
  VMs. Diff jobs never wait for a probe.
- **The pool cap is not a hard billing cap**: it limits launches in progress; an App-side limit per workspace is the
  other lever. A VM that outlives a function is stopped by the reaper at the next 5 minute run once its job has ended
  (section 5.5); if the reaper cannot run, its own timeout is the bound.
- **Dynamic Review on hosted** is gated on the hosted egress work (#82): the supervisor's own egress inside the VM
  is unrestricted by design, the Vercel firewall is not part of the security boundary, and the platform operator
  can read job secrets by construction (`dispatcher/README.md`). The container's hardening is proven per probe, not
  assumed: if the probe does not pass, `opencode` is not advertised.
- **The 30 minute function limit** is a beta limit of the platform. A job whose time plus its launch outlasts the
  function loses its supervision: the reaper (or, failing that, the VM timeout) ends the VM, billed meanwhile (section 5.5).
- **Retired:** the runner's concept. A runner still means what it did on a server.

## 10. Follow-ups

- #334 and #335 the self-hosted split and flipping its default: then section 8 gets its step table.
- A deploy workflow that runs `pnpm migrate` and the canary in order is not part of the repository; today steps 1, 2,
  5 and 6 are manual.
