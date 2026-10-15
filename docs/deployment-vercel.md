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
   that nobody acknowledged, jobs nobody claimed in time.

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
  minute** (the sweep; a plan with once-a-day crons only cannot run it) and, for the Dispatcher, a function
  `maxDuration` of **1800 seconds**. 1800 s is the *extended* maximum for Pro and Enterprise teams on Node.js 22 or 24
  and is a **beta limit**; 800 s is the generally available maximum and Hobby is limited to 300 s
  (`dispatcher/README.md`, "The Sandbox-Launcher"). Check your plan's current limits before you start: they are the
  platform's and they change.
- Access to Vercel Sandbox for the team, in region `fra1`. Every project and snapshot of this deployment is in `fra1`
  and there is **no failover region** (snapshots are region-bound).
- Two projects, from the same Git repository:

  | Project | Root directory | Framework | Config |
  |---|---|---|---|
  | App | `app/` | Next.js | `app/vercel.json`: region `fra1`, `pnpm install --frozen-lockfile`, function durations, the two crons |
  | Dispatcher | `dispatcher/` | Hono (detected from the default export of `src/index.ts`) | `dispatcher/vercel.json`: region `fra1`, `maxDuration` 1800 for `src/index.ts` |

  Both need Node.js 24 (`engines` in both `package.json` files, `.nvmrc`). Set the Node.js version of each project to
  24.x if the project's default differs.
- Crons run **only for the production deployment** of the App. A preview deployment never sweeps.
- A production domain for each project. The **App's URL must be reachable without a login** by GitHub (webhooks), by
  the Worker inside the VM (it calls the App's Worker API and has no way to send a bypass header) and by Vercel's cron.
  Do not put Vercel's Deployment Protection in front of the App's production domain. The Dispatcher is called only
  by the App and by the canary; if you protect it, use Protection Bypass for Automation and set the bypass secret in the two places
  named in section 3.

**An external Postgres** (Postgres 18 is what CI tests against, see `compose.large.yml`) reachable from Vercel's
`fra1` functions and from the machine that runs `pnpm migrate`, with TLS. You need **two roles** and **two URLs**:

| Role | URL | Used by | Needs |
|---|---|---|---|
| **migrate** | `DATABASE_URL_MIGRATE`, a **direct** connection (not a transaction pooler: the migration holds a session advisory lock that a pooler would drop) | `pnpm migrate` and `pnpm setup-code`, run by you, never by a Vercel function | Owns the database and its schema: creates and alters tables and indexes |
| **app** | `DATABASE_URL`, may be a pooler | The App's functions | Reads and writes the tables the migrate role created; no DDL |

The migrations create tables and indexes only (no extension, type, function or sequence), so the app role needs `usage`
on the schema and `select, insert, update, delete` on the tables, including tables created later:

```sql
-- as an administrator; replace the placeholders, keep the passwords out of shell history
create role cr_migrate login password '<generated>';
create role cr_app login password '<generated>';
create database code_reviewer owner cr_migrate;
-- connected to code_reviewer:
revoke all on schema public from public;
grant usage on schema public to cr_app;
alter default privileges for role cr_migrate in schema public
  grant select, insert, update, delete on tables to cr_app;
```

The test suite runs with a single owner role; **this split has not been exercised by CI**. After the first
`pnpm migrate`, the smoke test of step 8 is the proof: if the app role lacks a privilege, the statement that failed
names it in the function log. If in doubt, run the App with the migrate role's URL first and tighten later.

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
| `hosted-snapshot` | secrets `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` (of the **Dispatcher's** Vercel project) | Deployment branches: selected branches `main` and `development` only. Required reviewers: at least one person other than whoever starts the run. The workflow does not check the branch itself, so without the branch rule a manual run could execute any branch's code with the token. |
| `hosted-canary` | secret `RUNNER_TOKEN` (the same value as the Dispatcher project's), and `VERCEL_AUTOMATION_BYPASS_SECRET` only if the Dispatcher is behind Deployment Protection | Deployment branches: selected branches `main` and `development` only. Required reviewers as above. Nothing of any other purpose in it. |

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
another credential of the App, the Dispatcher one that equals its `RUNNER_TOKEN`). Create each with its own call:

```sh
openssl rand -hex 32      # RUNNER_TOKEN, CRON_SECRET, RUNNER_WEBHOOK_SECRET, OPERATOR_API_TOKEN: 64 characters
openssl rand -base64 32   # APP_SECRET
```

Keep the values in your password manager. Rules the code enforces: at least 32 characters, no white space or control
characters.

### 3.1 The App project

| Variable | Required | Secret | Meaning |
|---|---|---|---|
| `APP_RUNTIME` | yes, set it | no | `serverless`. Vercel sets `VERCEL=1` and that selects serverless by itself, but set it explicitly so a typo cannot start the other mode. Any other value than `server` or `serverless` stops the start (`APP_RUNTIME_INVALID`). |
| `APP_SECRET` | yes | **yes** | The master key: signs sessions and encrypts the credentials in the database. At least 32 characters. Never reused between environments. Changing it signs everybody out and makes stored credentials unreadable. |
| `BETTER_AUTH_URL` | yes | no | The public https address of the App, no path (its production domain). GitHub sends people back to `<this>/api/auth/callback/github`. |
| `DATABASE_URL` | yes | **yes** | The **app role's** Postgres URL (`postgres://` or `postgresql://`; SQLite is refused in serverless mode). May be a pooler. |
| `DATABASE_POOL_MAX` | optional | no | Connections per function instance, 1 to 20, default 3. Every instance has its own pool: keep it small. |
| `RUNNER_TOKEN` | yes | **yes** | The **dispatcher credential**: what the Dispatcher claims jobs with. At least 32 characters. **Same value as the Dispatcher's `RUNNER_TOKEN`.** There is one token, no overlap while rotating (section 5.2). |
| `CRON_SECRET` | yes | **yes** | Vercel sends it as `Authorization: Bearer ...` to both cron routes. At least 32 characters. Without it every cron call is refused (`401`): leases never expire and no wake-up is resent. Vercel adds the header by itself once the variable exists. |
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
| `LLM_MODEL`, `LLM_MAX_TOKENS` | optional | no | Instance settings for PR-Agent's model. The LLM key is **not** an environment variable: every workspace enters its own (Settings, LLM access). |

Not set in the project, on purpose:

- `DATABASE_URL_MIGRATE`: the direct URL of the **migrate role**. Only `pnpm migrate` and `pnpm setup-code` read it,
  from the shell you run them in. The App never reads it; do not give it to a function.
- `VERCEL`: set by the platform. `NODE_ENV`: set by Next.js.
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
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | all three or none | **yes** (the token) | Platform access by access token. **None: the Dispatcher uses the project's own OIDC token**, which Vercel provides inside a function and which needs nothing to rotate. Prefer that. |

Not set by you: `VERCEL_OIDC_TOKEN` (the platform provides it). Only the Node entry (`pnpm start`, not used on
Vercel) reads `DISPATCHER_SHUTDOWN_GRACE_SECONDS` and `PORT`.

**Pending #364 (the VM reaper, PR #368, not merged when this was written):** a Dispatcher cron
(`/api/cron/reap-sandboxes`, every 5 minutes) that stops VMs whose job has ended will need its own `CRON_SECRET` in
this project (at least 32 characters, different from `RUNNER_TOKEN` and the signing secrets). Until it merges, the
Dispatcher has no cron and nothing stops a VM that outlived its function except the VM's own timeout (section 9).

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

### 3.4 The GitHub side

| Where | Name | Meaning |
|---|---|---|
| environment `hosted-snapshot` | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Platform access for the snapshot build. The token is an access token with access to the **Dispatcher's** project; the pipeline hands it to the platform client and to nothing else |
| environment `hosted-canary` | `RUNNER_TOKEN`, `VERCEL_AUTOMATION_BYPASS_SECRET` (optional) | The canary's credential and the bypass |
| repository variable | `DISPATCHER_CANARY_HOSTS` | The only host(s) the canary may send the credential to |
| repository variable | `GOLDEN_SNAPSHOT_ENABLED` | `true` makes a push to `main` build a snapshot. Unset: only manual runs |

## 4. First deployment, step by step

Do the steps in this order (migrate, App, setup code, snapshot, Dispatcher, canary, webhook, smoke test); each one has a check. Nothing is lost if you stop between steps.

### Step 1. Migrate the database

```sh
export DATABASE_URL_MIGRATE='postgres://cr_migrate:<password>@<direct host>:5432/code_reviewer?sslmode=require'
pnpm --dir app migrate
```

`pnpm migrate` takes the advisory lock `code-reviewer:migrate`, applies every pending migration in one transaction
and exits 0 (`[migrate] applied N migration(s): ...` or `[migrate] the schema is up to date, nothing to apply.`) or
exits 1 with one line and a code (a failed batch is rolled back). Two runs take turns. The URL is not printed.
**Check:** run it again; it must say that nothing is left to apply.

Run it again before **every** later deployment, before the new version takes traffic. The App never migrates by
itself.

### Step 2. Deploy the App (still in poll mode)

Create the App project (root directory `app/`), set the variables of section 3.1 **except** the `RUNNER_DISPATCH` and
`RUNNER_WEBHOOK_*` ones, and deploy the production branch. Give the production deployment its domain and set
`BETTER_AUTH_URL` to it.

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
APP_RUNTIME=serverless APP_SECRET='<the same value>' pnpm --dir app setup-code
```

(with `DATABASE_URL_MIGRATE` still exported). It prints `[setup-code] Setup code: <6 digits>`, valid for 60
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

Do not open test pull requests yet: no Dispatcher exists, so a job would only wait (the sweep sends it after step 7).

### Step 4. Build the golden snapshot

The snapshot is built inside a builder VM by the workflow `.github/workflows/golden-snapshot.yml`; the Worker image
is built from the commit **inside that VM**, with no registry and no registry credential
([`golden-snapshot.md`](golden-snapshot.md) has every step and failure code).

1. Create the **Dispatcher project** now (root directory `dispatcher/`, no variables yet, no deployment needed): the
   token and project id of the `hosted-snapshot` environment point at it, because the Launcher creates job VMs in the
   project it runs in and the snapshot has to be in that project.
2. Set the three secrets of `hosted-snapshot` (section 3.4).
3. Actions, *Golden snapshot*, *Run workflow* on `development` (or the release tag's branch): `target` stays
   `sandbox`; `pinned_snapshot` stays empty on the first run. A reviewer approves the environment.
4. About two minutes later the run summary shows the **record**:

   ```json
   { "version": 1, "snapshotId": "snap_...", "imageDigest": "sha256:<64 hex>", "region": "fra1", "target": "sandbox", "commit": "..." }
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
`DISPATCHER_SIGNING_SECRET`, `SANDBOX_SNAPSHOT_ID` and `SANDBOX_IMAGE_DIGEST` from the record, and optionally
`DISPATCHER_ENGINES`, `DISPATCHER_WORKER_CONFIG` (section 6). Leave `VERCEL_TOKEN` and its siblings unset to use the
project's OIDC token. Deploy.

**Check:** `https://<dispatcher>/health` answers `200 {"status":"ok"}`. The settings are read when the function
initialises, so a bad value shows as failing requests and a log line that names the variable
(`SANDBOX_SNAPSHOT_ID is required`, `DISPATCHER_WORKER_CONFIG is invalid`, ...), not as a failed build. If you
protect the project with Deployment Protection, every path answers the platform's login page until the bypass header
is sent: confirm `curl -s -o /dev/null -w '%{http_code}' -H 'x-vercel-protection-bypass: <secret>' https://<dispatcher>/health`
prints `200` before step 7, or every wake-up waits half an hour (section 5.3).

Then add the Dispatcher's production host to the repository variable `DISPATCHER_CANARY_HOSTS` and the
Dispatcher's `RUNNER_TOKEN` to the `hosted-canary` environment (and the bypass secret, if it is protected).

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

Running the canary on a preview deployment of the next release **before** promoting it is the normal release
sequence; for the very first deployment the production deployment is the candidate.

### Step 7. Switch the App to webhook mode

In the App project add `RUNNER_DISPATCH=webhook`, `RUNNER_WEBHOOK_URL=https://<dispatcher>/dispatch`,
`RUNNER_WEBHOOK_SECRET` and `RUNNER_WEBHOOK_KEY_ID` (the Dispatcher's two signing values), `RUNNER_DISPATCH_MAX_RUNNING`
(= `DISPATCHER_MAX_RUNNING`) and, if needed, `RUNNER_WEBHOOK_BYPASS_TOKEN`. Redeploy.

**Check:** the deployment starts. A webhook mode with a missing URL, a short or reused signing secret stops the start
with `DEPLOY_CONFIG_INVALID` naming the variables (never the values). The jobs that waited since step 3 are woken by
the next sweep within a minute.

### Step 8. Smoke test: a Diff review, then a Dynamic review

**Diff.** Open (or push to) a pull request on the test repository, or use *Review now* on its page.

- Runs page: the run goes `queued`, `running`, `succeeded`; a review comment appears on the pull request.
- Dispatcher function log: `launched` for the job id (`launch_failed` with a `code` if it did not).
- The platform lists one VM named `cr-diff-<job id>-<random>` while it works (dashboard, or `Sandbox.list`), and it
  is gone, or stopped, afterwards.
- A run that stays `queued` for more than a few minutes: section 5.3.

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
3. Deploy the Dispatcher to a preview (or the production deployment before promoting) with the new
   `SANDBOX_SNAPSHOT_ID` and `SANDBOX_IMAGE_DIGEST`, run the **canary** on it (step 6). Only on exit 0 switch the
   production Dispatcher and redeploy.
4. On the run after that, pass the **new** snapshot id as the pin.

`GOLDEN_SNAPSHOT_ENABLED=true` makes every push to `main` build a snapshot, but nothing changes a deployment by
itself: marking a snapshot current is always this manual step, and a rebuilt image whose digest differs from the
configured one is refused by the Launcher until you do it.

### 5.2 Rotating secrets

| Secret | How |
|---|---|
| **Webhook signing key** (`RUNNER_WEBHOOK_SECRET`, `DISPATCHER_SIGNING_SECRET`) | No gap, in this order: (1) in the Dispatcher project set the new key as current (`DISPATCHER_SIGNING_KEY_ID`, `DISPATCHER_SIGNING_SECRET`) and the old one as `..._PREVIOUS`, redeploy; (2) in the App project set the new key (`RUNNER_WEBHOOK_KEY_ID`, `RUNNER_WEBHOOK_SECRET`), redeploy; (3) after at least 5 minutes (the receiver's clock tolerance) remove the previous key from the Dispatcher and redeploy. Use a **new key id** each time. |
| **`RUNNER_TOKEN`** (the dispatcher credential) | The App accepts exactly one, so there is a short gap: set the new value in the App and the Dispatcher projects and in the `hosted-canary` environment, redeploy **both**. Claims that arrive between the two deployments fail and the job stays queued, to be resent by the sweep; running Workers are not affected (they use their per-job credential, not this token). Do it when the queue is quiet. |
| **Vercel access** | With OIDC (no `VERCEL_TOKEN` in the Dispatcher project) there is nothing to rotate for the Launcher. For the snapshot pipeline: create a new access token, update `VERCEL_TOKEN` in `hosted-snapshot` (and in the Dispatcher project if you chose token auth there, then redeploy), run a harmless check (a snapshot run, or the canary), then revoke the old token. |
| **Bypass secret** | Regenerate it in the Dispatcher project's Deployment Protection settings, then update `RUNNER_WEBHOOK_BYPASS_TOKEN` (App, redeploy) and `VERCEL_AUTOMATION_BYPASS_SECRET` (`hosted-canary`). Wake-ups fail with `DISPATCH_REJECTED` in between. |
| **`CRON_SECRET`** | Change it in the project, redeploy. Vercel sends the new value to the next cron call; until the deployment is live the calls are refused (`401`) and a minute of the sweep is lost. |
| **`OPERATOR_API_TOKEN`** | Change it, redeploy, give the operator's client the new one. |
| **`APP_SECRET`** | Not rotatable: changing it signs everybody out and makes every stored credential (GitHub App key, mail password, workspace LLM keys) unreadable. |

Any secret that was ever in a log, a chat or an issue is rotated the same way.

### 5.3 Reading what the Runs page and the logs say

A run's error code is shown on the Runs pages with a fixed sentence. Three belong to the hosted deployment:

| Where | Code | Meaning and what to do |
|---|---|---|
| Runs page | `dispatch_unavailable` | The job waited `RUNNER_DISPATCH_GIVE_UP_SECONDS` (60 minutes by default) without anyone claiming it, no attempt is counted, and the next push or review request runs it again. Look at the **App's** sweep and send logs (`DISPATCH_SEND_FAILED`, `DISPATCH_REJECTED`) and at the Dispatcher's log. Usual causes: `RUNNER_WEBHOOK_URL` or the signing key do not match (`DISPATCH_REJECTED`: a wrong URL or secret looks like this and the App waits 30 minutes between tries), the Dispatcher is down or protected, `SANDBOX_SNAPSHOT_ID` is unset (`not_capable`), the pool is full for longer than the give-up time, or the sweep itself is refused (`CRON_SECRET`). |
| Runs page | `launch_failed` | The Worker could not be started even after three attempts. The cause is a launch code in the **Dispatcher's** log (line `launch_failed`, field `code`, plus `retryable`): the table in `dispatcher/README.md` ("The Sandbox-Launcher") lists them (`sandbox_auth_failed`, `sandbox_snapshot_missing`, `image_mismatch`, `docker_not_ready`, `worker_exited_early`, ...). |
| Dispatcher log only | `capability_not_proven` | A Dynamic job was claimed but no fresh passing probe answer counted at launch. The job is released as `launch_failed` (so the Runs page shows that). It means the probe went stale or failed between the claim and the launch, or the canary VM cannot prove the hardening: run the canary, read the reasons, and see `dynamic_isolation_self_check_failed` in [`dynamic-review.md`](dynamic-review.md). Diff jobs are not affected. |

Others you will meet: `no_capable_runner` (a Dynamic job nobody could run for 30 minutes: the probe says no, or
`DISPATCHER_ENGINES` has no `opencode`), `dynamic_review_disabled` (the gate is off), `lease_expired` (the Worker
stopped reporting), `quota_exhausted`, `workspace_suspended` and `entitlements_invalid` (the workspace's limits, set
through the operator API), `llm_not_configured` (the workspace has no LLM key). The wake-up call's answers (`202`,
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

### 5.5 Stopping VMs that outlived their job

**Pending #364 (PR #368).** The Dispatcher's supervision runs in the function; if the function ends before the
container does (a job of more than about 1500 s, a platform restart, a lost instance), nothing stops the VM and its
own timeout (`job timeout + SANDBOX_VM_TIMEOUT_MARGIN_SECONDS`) is the backstop. The reaper cron is the fix, not
merged yet. Until it is, list the project's VMs now and then (their names start with `cr-`, tags `app`, `kind`,
`job`) and stop any that is older than a job can be. Leftover builders of the snapshot pipeline
(`code-reviewer-golden-builder-*`) are handled in [`golden-snapshot.md`](golden-snapshot.md).

### 5.6 Updating the App or the Dispatcher

Order: **migrate, then deploy**. `pnpm --dir app migrate`, then deploy the App. Do not rely on the platform to hold
traffic back from a deployment that is ahead of the database: it answers `/api/health` with `SCHEMA_BEHIND`, but
nothing stops it from being promoted. A migration always works for the version that is still running (additions
first, removals one release later), so an App instance **behind** the database is healthy and an instance **ahead**
of it reports `SCHEMA_BEHIND`. Update the Dispatcher after the App when a release changes the runner API
(`GET /api/runners/v1/version` lists the App's features; a Dispatcher that finds one missing answers `503` and claims
nothing).

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
- **The whole chain**: signed wake-up, claim, VM, Worker, result on a real GitHub pull request. The end-to-end
  journeys are #332, **pending**; this guide's step 8 is the manual version.
- The **database role split** of section 2.
- **Dynamic Review memory**: the worst case in a 2 GB VM is unmeasured (section 6).
- The **golden snapshot** passed its checks in two real runs (the pinned Docker versions, the scan, the probe line).
  Retention was broken on the real platform in those runs and fixed in #365; its behavior on the real platform since
  the fix is not recorded. See "Not verified yet" in [`golden-snapshot.md`](golden-snapshot.md).

**Limits by design:**

- **One region.** `fra1` for the functions, the VMs and the snapshots; no failover.
- **The cost limit of a workspace is a soft cap** (`managedCostLimitMicroUsd`): cost is known only when a run settles,
  so runs in flight are not in the sum and a workspace can end above its limit by what the concurrent runs cost. The run
  limits are exact. A run with an unknown cost counts for nothing (`unknownCostCount` in the operator API's summary).
  A limit for runs on a workspace's own key is #361. Limits are set through the operator API; the operator's own LLM
  key (managed key mode) is **#276, pending**: until it merges, every workspace brings its own key.
- **The capability probe.** One answer per Dispatcher *instance*, held in memory for `DISPATCHER_PROBE_TTL_SECONDS`
  (1 hour). The first Dynamic wake-up after the hour, and the first one on every **cold instance**, finds nothing
  proven, starts a probe (one canary VM, tens of seconds) and is answered `503` with `Retry-After: 20`; Dynamic jobs
  are delayed by that, and a `failed` probe holds Dynamic back for another minute. Many cold instances mean many canary
  VMs. Diff jobs never wait for a probe.
- **The pool cap is not a hard billing cap**: it limits launches in progress; an App-side limit per workspace is the
  other lever. VMs that outlive a function are bounded by their own timeout only (section 5.5, pending #364).
- **Dynamic Review on hosted** is gated on the hosted egress work (#82): the supervisor's own egress inside the VM
  is unrestricted by design, the Vercel firewall is not part of the security boundary, and the platform operator
  can read job secrets by construction (`dispatcher/README.md`). The container's hardening is proven per probe, not
  assumed: if the probe does not pass, `opencode` is not advertised.
- **The 30 minute function limit** is a beta limit of the platform. A job whose time plus its launch outlasts the
  function loses its supervision: the VM timeout ends the VM, later and billed (section 5.5).
- **Retired:** the runner's concept. A runner still means what it did on a server.

## 10. Follow-ups

- #364 the VM reaper (PR #368): then section 3.2 gets its `CRON_SECRET` row for real and section 5.5 goes.
- #332 the end-to-end journeys: then step 8 has an automated twin.
- #276 the operator's own LLM key: then section 9 and the admin documentation change.
- #334 and #335 the self-hosted split and flipping its default: then section 8 gets its step table.
- A deploy workflow that runs `pnpm migrate` and the canary in order is not part of the repository; today steps 1, 2,
  5 and 6 are manual.
