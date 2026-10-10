# Deploying Code Reviewer on Coolify

This guide takes a team from an empty Coolify server to the first real review on one of its own
repositories. Plan for about two hours, most of it waiting for DNS, the build and GitHub. It is written
against Coolify's current documentation (links in each step); the first deployment with the customer is
what verifies it on a real instance, see [What is verified](#what-is-verified).

What you end up with: one Coolify application of type *Docker Compose*, built from this repository,
with two containers: the **app** (web UI, API, webhook receiver, SQLite database, daily backups) behind
Coolify's proxy under your domain with HTTPS, and the **runner** (runs PR-Agent) that has no domain and
no port and only talks to the app.

## Contents

1. [What you need](#1-what-you-need)
2. [The decisions in short](#2-the-decisions-in-short)
3. [The three GitHub things, and the order](#3-the-three-github-things-and-the-order)
4. [Create the Coolify application](#4-create-the-coolify-application)
5. [Domain and TLS](#5-domain-and-tls)
6. [Environment variables](#6-environment-variables)
7. [Deploy and check the instance](#7-deploy-and-check-the-instance)
8. [Storage and backups](#8-storage-and-backups)
9. [Runner sizing and `RUNNER_CONCURRENCY`](#9-runner-sizing-and-runner_concurrency)
10. [One app instance only](#10-one-app-instance-only)
11. [Updates and rollback](#11-updates-and-rollback)
12. [First-run checklist](#12-first-run-checklist)
13. [When something does not work](#13-when-something-does-not-work)
- [What is verified](#what-is-verified)

## 1. What you need

- A **Coolify** instance (self-hosted, version 4) with a server that can run applications. Size: **8 GB
  RAM and 4 vCPU recommended**, see [section 9](#9-runner-sizing-and-runner_concurrency). The images are
  built on that server, which needs extra memory and CPU for a few minutes per deployment.
- A **domain** (or subdomain) such as `reviews.example.com` with a DNS `A` record pointing to the
  server's public IP address. Ports **80** and **443** must be open to the internet on that server
  (Coolify's [firewall guide](https://coolify.io/docs/core/infrastructure/servers/firewall)): the proxy
  needs them to get the certificate and to receive GitHub's webhooks. Nothing else has to be public.
- Owner (or app manager) rights on the GitHub account or organization that owns the repositories to be
  reviewed, and read access to this repository (`ExpidetGames/code-reviewer`) for **Coolify's own**
  GitHub App, see [section 4](#4-create-the-coolify-application).
- A shared **password manager** for the secrets below.
- An **OpenRouter** account with an API key and a spending limit (openrouter.ai/keys). Reviews cost
  money; the default model is chosen to stay far below 0.10 USD per review.

## 2. The decisions in short

| Question | Decision | Why |
|---|---|---|
| Coolify resource type | **Git repository, build pack "Docker Compose"**, file `/compose.coolify.yml` | The Compose file lives in the repository, so a deployment is always "this commit". Compose gives the two containers, the two volumes and the health check in one definition. ([Coolify: Docker Compose](https://coolify.io/docs/applications/builds/docker-compose)) |
| How the images get to the server | **Coolify builds both images from the repository** with its own GitHub App access. The published images on GHCR are not used. | No registry credential on the server, see below. |
| Branch | `main` | `main` holds released versions; `development` is the integration branch. |
| Domain | One domain on the service `app`, `https://<domain>:3000` | The proxy terminates TLS; the `:3000` is the port inside the container. |
| Storage | Two named volumes: `data` (the SQLite database) and `backups` | Both survive redeploys. They live in the Compose file. |
| Instances | **Exactly one** app instance | [Section 10](#10-one-app-instance-only). |
| Updates | Push or merge to `main` (automatic or manual deploy), or press Redeploy | [Section 11](#11-updates-and-rollback). |

### Why build from the repository and not pull from GHCR

CI publishes both images to GHCR on every push to `development` and `main` (workflow
`.github/workflows/publish-images.yml`): `ghcr.io/expidetgames/code-reviewer-app` and
`ghcr.io/expidetgames/code-reviewer-runner`, each with the tags `sha-<first 7 characters of the
commit>`, plus `development` (moves with the branch `development`) or `latest` (moves with the branch
`main`). The packages are **private**, so a server can pull them only with a registry login. That is
possible in Coolify (Registries, then *Log in*, preset GHCR), but it was not chosen:

- It needs a GitHub personal access token with `read:packages`, stored on the server in Docker's
  `config.json`, where it is encoded, not encrypted
  ([Coolify: Docker registries](https://coolify.io/docs/applications/builds/docker-registries)). That is
  one more long lived credential tied to a person.
- A token that expires or is revoked breaks every pull from `ghcr.io` on that server, including
  Coolify's own helper image
  ([Coolify: expired token](https://coolify.io/docs/troubleshoot/docker/expired-github-personal-access-token)).
- Coolify needs read access to this repository anyway (its GitHub App), so building from the repository
  adds no new credential and no new place where access can lapse.
- The Dockerfiles are the ones CI builds and smoke tests on every pull request, so the images are not
  different, only built on the server. A failed build does not replace the running application
  ([Coolify: deployments](https://coolify.io/docs/applications/deployments/overview)).

The price: a deployment takes a few minutes of CPU and memory on the server (the first one longest; Docker's
layer cache makes later ones shorter), and nothing starts from the exact image CI pushed. If the build
load is a problem, Coolify can build on a separate
[build server](https://coolify.io/docs/troubleshoot/server/crash-during-build). If the team later
prefers GHCR, it needs a variant of `compose.coolify.yml` with `image:` lines instead of `build:` and the
registry login above; the tags to pin are the ones named in this section.

## 3. The three GitHub things, and the order

Three different things on GitHub are involved, which are easy to mix up:

| What | Who uses it | Created by | Where its values go |
|---|---|---|---|
| **Coolify's GitHub App** | Coolify, to read this repository and to be told about pushes | Coolify's source wizard ([Coolify: GitHub App](https://coolify.io/docs/applications/sources/github/app)) | Stays inside Coolify. Not an environment variable of Code Reviewer. |
| **Code Reviewer's GitHub App** | Code Reviewer, to receive webhooks and to read and review pull requests | You, once, with [`github-app.md`](github-app.md) | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY` |
| **GitHub OAuth app** | The login of the people using the web UI | You, once, GitHub > Settings > Developer settings > OAuth Apps | `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` |

The apps need the domain and the deployment needs their values, so do it in this order:

1. Server, DNS record and the domain ([section 1](#1-what-you-need)).
2. Coolify's GitHub App with access to this repository ([section 4](#4-create-the-coolify-application)).
3. Create the Coolify application and assign the domain to it, **do not deploy yet** (sections 4 and 5).
4. Create the OAuth app: *Homepage URL* `https://<domain>`, *Authorization callback URL*
   `https://<domain>/api/auth/callback/github` (the same address as `BETTER_AUTH_URL`, plus that path).
   Generate its client secret.
5. Create Code Reviewer's GitHub App (steps 1 and 2 of [`github-app.md`](github-app.md)): webhook URL
   `https://<domain>/api/webhooks/github-app`, permissions, events, private key. GitHub sends a first
   `ping` delivery right away, before anything runs on the domain: it shows as failed. That is expected;
   redeliver it after the first deploy (*Advanced > Recent Deliveries*), or ignore it.
6. Enter all values in Coolify ([section 6](#6-environment-variables)) and deploy
   ([section 7](#7-deploy-and-check-the-instance)).
7. Install the GitHub App on the repositories (step 5 of [`github-app.md`](github-app.md)).

## 4. Create the Coolify application

Names in bold are the labels in Coolify's documentation; a different Coolify version may word them
slightly differently.

1. **Coolify's GitHub App.** If Coolify has no GitHub source yet: *Sources*, *New source*, *GitHub App*,
   automated installation, then install it on this repository only
   ([Coolify: Set up a GitHub App](https://coolify.io/docs/applications/sources/github/app)).
2. **New resource.** Open the project and environment, *+ New*, *Private Repository (with GitHub App)*,
   choose the server (the machine that will run the containers), choose the GitHub App source, choose
   the repository `ExpidetGames/code-reviewer` and the branch **`main`**, *Load Repository*.
3. **Build pack.** Under *General > Build pipeline* choose **Compose** as the build strategy and set:
   - **Base Directory**: `/`
   - **Docker Compose Location**: `/compose.coolify.yml`

   Save and open **Docker Compose Content**: it must show the services `app` and `runner`, and Coolify
   lists the variables of [section 6](#6-environment-variables) under *Environment Variables*. The file
   is read from the repository; to change it, change the repository and reload the Compose file
   ([Coolify: Docker Compose](https://coolify.io/docs/applications/builds/docker-compose)).
4. **Keep secrets out of the images.** Under *Advanced > Build*, set **Build arguments** to **Managed
   manually in Dockerfile**. By default Coolify turns every variable that is "available during build"
   into a Docker build argument, and build arguments can remain visible in image metadata
   ([Coolify: environment variables](https://coolify.io/docs/applications/configuration/environment-variables)).
   The Dockerfiles of this repository take no secret at build time. As a second safeguard, set the
   secrets of [section 6](#6-environment-variables) to *Runtime only*.
5. **Auto deploy.** *Advanced > Deployment > Auto deploy*: **Deploy on push (webhooks)** deploys every
   push to `main`; **Manual deployments only** deploys only when someone presses *Deploy* or *Redeploy*
   ([Coolify: GitHub auto deploy](https://coolify.io/docs/applications/sources/github/auto-deploy)). The
   release pull request into `main` is the team's decision point, so either is defensible; choose
   manual while the instance is new.

## 5. Domain and TLS

1. The DNS `A` record of `<domain>` points to the server and ports 80 and 443 are open
   ([section 1](#1-what-you-need)).
2. In the application, open **Domains**, **Add domain**, choose the service **`app`** and enter

   ```
   https://<domain>:3000
   ```

   The `https://` makes the proxy request and renew a Let's Encrypt certificate. The `:3000` is the
   port **inside** the container; visitors still use 443, and no port is published on the server
   ([Coolify: Domains](https://coolify.io/docs/core/networking/domains)).
3. Do **not** add a domain to the service `runner`. It must not be reachable from outside.
4. Turn on **Redirect HTTP to HTTPS** if the Domains page offers it.

`compose.coolify.yml` publishes no host port on purpose: a published port would reach the app without
the proxy and without TLS. `BETTER_AUTH_URL` (below) must be exactly this address, with `https://` and
without the port and without a path. The app refuses to start with plain `http://` on anything but
localhost, because browsers drop its secure cookies over http.

## 6. Environment variables

Open **Environment Variables** of the application. Coolify lists every variable that
`compose.coolify.yml` references; the ones marked required block the deployment while empty
([Coolify: Docker Compose variables](https://coolify.io/docs/applications/builds/docker-compose#environment-variables)).
The file [`.env.example`](../.env.example) explains each setting in detail and is the master list: this
table is checked against it and against the Compose file by a test.

Generate random values on any machine with `openssl rand -base64 32`. Never reuse a value between
environments. Put every secret into the team's password manager first. Coolify expands `$` references in
values unless the variable's *Interpolation* is set to **Literal (keep $ characters as-is)**
([Coolify: multiline and literal values](https://coolify.io/docs/applications/configuration/environment-variables#multiline-and-literal-values)).
The values from `openssl rand -base64 32` contain no `$`; for any secret that does (a password manager
value), set Literal.

| Variable | Required | Where the value comes from | Notes |
|---|---|---|---|
| `BETTER_AUTH_URL` | yes | The public address: `https://<domain>` | No path, no port, no trailing slash. Register `<this>/api/auth/callback/github` as the OAuth app's callback URL. |
| `BETTER_AUTH_SECRET` | yes | `openssl rand -base64 32` | At least 32 characters. Signs the session cookie and encrypts stored GitHub tokens. Changing it signs everybody out. |
| `GITHUB_OAUTH_CLIENT_ID` | yes | The OAuth app's settings page | The OAuth app is not the GitHub App. |
| `GITHUB_OAUTH_CLIENT_SECRET` | yes | Generated on the OAuth app's settings page | Secret. |
| `ALLOWED_GITHUB_LOGINS` | one of two | Comma separated GitHub logins of the team | **Set this or `ALLOWED_GITHUB_ORG` (or both).** Coolify does not block the deployment when both are empty, the app is healthy and the smoke test passes, but nobody can sign in (the app logs one warning). Details, including binding a login to its numeric id (`octocat:583231`): [`app/src/auth/README.md`](../app/src/auth/README.md). |
| `ALLOWED_GITHUB_ORG` | one of two | The name of a GitHub organization (`github.com/<name>`) | **Set this or `ALLOWED_GITHUB_LOGINS` (or both).** Its members may sign in. If both are set, either is enough. |
| `GITHUB_APP_ID` | yes | The App ID on the GitHub App's settings page | [`github-app.md`](github-app.md), step 2. |
| `GITHUB_APP_SLUG` | yes | The last part of `github.com/apps/<slug>` | |
| `GITHUB_APP_WEBHOOK_SECRET` | yes | The secret entered in the GitHub App's webhook settings | Secret. Byte for byte: no trailing space or line break. |
| `GITHUB_APP_PRIVATE_KEY` | yes | The `.pem` file generated on the GitHub App's settings page | Secret. In Coolify choose the value type **Multiline** and paste the key with its line breaks, or paste it on one line with the breaks written as `\n`; both give the same key ([`github-app.md`](github-app.md), section 3). The key is parsed at start; an unusable one stops the start and the log names the variable. |
| `RUNNER_TOKEN` | yes | `openssl rand -base64 32` | At least 32 characters. Secret shared by the app and the runner; both read this one variable. |
| `LLM_API_KEY` | optional | The OpenRouter API key | Secret. Without it the app starts and shows a configuration error, and every review fails with `llm_not_configured`: set it before the first review. |
| `LLM_PROVIDER` | optional | `openrouter` | The only provider for now; this is the default. |
| `LLM_MODEL` | optional | An OpenRouter model name | Default `anthropic/claude-haiku-5.5`. The review settings in the UI can choose another model per project. |
| `LLM_MAX_TOKENS` | optional | Context window of a model PR-Agent does not know | Leave empty for known models. |
| `REVIEW_DEBOUNCE_SECONDS` | optional | A number from 0 to 600 | How long a push to a pull request waits before its automatic review starts. Empty: 90. |
| `DATABASE_BUSY_TIMEOUT_MS` | optional | A number of milliseconds | How long a database write waits for a lock. Empty: 5000. |
| `BACKUP_TIME` | optional | `HH:MM` in UTC, or `off` | When the app backs up the database every day. Empty: `02:30`. Use `off` only together with a Coolify scheduled task, [section 8](#8-storage-and-backups). |

Variables that exist in `.env.example` but that you **do not set on Coolify**:

| Variable | Required | Why not |
|---|---|---|
| `APP_IMAGE`, `RUNNER_IMAGE` | not used | Only `compose.yml` pulls images by these names. Coolify builds them. |
| `APP_PORT`, `APP_BIND_ADDRESS` | not used | Only `compose.yml` publishes a port. |
| `GITHUB_APP_PRIVATE_KEY_PATH` | not used | The Compose file mounts no key file; use `GITHUB_APP_PRIVATE_KEY`. |
| `BACKUP_DIR` | not used | The image fixes it to `/backups`, the mount point of the backup volume. |
| `ALLOW_TEST_GITHUB_ENDPOINTS`, `GITHUB_OAUTH_BASE_URL`, `GITHUB_API_BASE_URL` | not used | For the test stack with a fake GitHub only. Never set them in a real deployment. |

Settings that arrive with later work and that this Compose file does not pass on yet:

| Variable | Required | What it will do |
|---|---|---|
| `RUNNER_CONCURRENCY` | planned | How many reviews the runner runs at once, [section 9](#9-runner-sizing-and-runner_concurrency). Introduced with the runner's job loop (CR-29), which adds it to the Compose files and to `.env.example`. |

After changing a variable, save and **Restart** (only runtime values changed) or **Redeploy**
([Coolify: apply changes](https://coolify.io/docs/applications/configuration/environment-variables#apply-changes)).

## 7. Deploy and check the instance

1. Press **Deploy** and follow **Deployment Logs**: both images are built, then the stack starts. The
   runner starts only after the app reports healthy.
2. In Coolify, `app` must show **healthy** and `runner` **running**. The app's health check is
   `GET /api/health` inside the container; it reads the database. If the app never becomes healthy,
   open its logs and read the last lines first: a missing or invalid setting stops the start with one
   line that names the variable (for example `[deploy] DEPLOY_CONFIG_INVALID` or an `[auth]` line),
   never its value, and `restart: unless-stopped` turns that into a restart loop.
3. Open `https://<domain>`: the login page loads over HTTPS with a valid certificate.
4. Run the smoke test from any machine that has `curl` and a checkout of this repository (it needs no secret):

   ```sh
   docker/smoke/instance.sh https://<domain>
   ```

   It checks that `/api/health` and `/login` answer 2xx, that a webhook delivery with a wrong signature
   gets 401, and that the runner API refuses a request without a token with 401. Any deviation makes
   the exit code non-zero and names the check.

   **Until the runner API is part of the release** (it is not yet on every branch, see
   [What is verified](#what-is-verified)) the last check fails with 404. Only then, run
   `docker/smoke/instance.sh --skip-runner-endpoint https://<domain>`; the script prints that it skipped
   the check and ends with "smoke test passed (runner API check skipped)". Do not use the option once the
   runner API is in: it would hide an open runner API.
5. Compare the variables in Coolify with the table in [section 6](#6-environment-variables), and check that
   **at least one of `ALLOWED_GITHUB_LOGINS` and `ALLOWED_GITHUB_ORG` is set**: neither Coolify nor the health
   check notices when both are empty. Where the app
   shows configuration hints (the setup status of the project pages), they are empty once everything is set.
6. From outside the server, only 80 and 443 answer (for example `nmap -p 1-10000 <server-ip>` from another
   machine; your hosting provider's firewall helps), and the runner has no domain.
7. Check the webhook: [`github-app.md`](github-app.md), section 4.

## 8. Storage and backups

**Where the data is.** `compose.coolify.yml` declares two named volumes. Coolify shows them under
*Persistent Storage* (read-only there: for a Compose application the file is the source of truth) and
prefixes their names, so find the real names with `docker volume ls` on the server.

| Volume | Mounted at | Holds |
|---|---|---|
| `data` | `/data` | The SQLite database `app.db` (all projects, settings, users, sessions, run history) |
| `backups` | `/backups` | The daily backups of the database, apart from the data on purpose |

A redeploy, a restart or an image update keeps both. Only deleting the volume deletes the data; before
you delete the application, its storage or the server, copy the backups off the server.

**Daily backup.** The app backs the database up itself every day at `BACKUP_TIME` (default 02:30 UTC),
keeps 7 daily and 4 weekly backups, verifies each file, and logs a failure as an error. Nothing has to be set up.
How a backup is made, the retention rule, the status route, the error codes and the restore command are
in [`app/src/backup/README.md`](../app/src/backup/README.md); read it once before you need it.

**A Coolify scheduled task instead of (or in addition to) the built-in timer.** If you prefer Coolify to
run and record it: *Scheduled Tasks*, *+ Add*, command `node /srv/app/backup/cli.ts backup`, container
`app` (if the field wants the name Coolify generated for the container, use the one `docker ps` shows on the
server; to be confirmed at the first deployment), a frequency such as `30 2 * * *`, then *Execute now* once and read the execution under *Recent
executions* ([Coolify: scheduled tasks](https://coolify.io/docs/core/automation/scheduled-tasks/create-a-task)).
Set `BACKUP_TIME=off` so the two do not both run. Coolify evaluates the schedule in the server's time
zone; `BACKUP_TIME` is always UTC. The same command, run once before every update, gives you a
restore point ([section 11](#11-updates-and-rollback)).

**Getting the backups off the server.** The `backups` volume protects against a bad update or a
deleted row, not against losing the server or its disk. Copy it elsewhere:

1. **From the host (works with any Coolify version).** The files are under
   `/var/lib/docker/volumes/<prefixed name>_backups/_data` on the server (find the name with
   `docker volume ls`). A cron job on the host with `rsync`, `rclone` or `restic` copies that directory
   to another server or to object storage. The files contain sessions and stored tokens: copy them only
   to places that are as protected as the server, and encrypt them if they go further (`restic` does).
2. **Coolify's storage backups to S3.** Coolify's documentation describes scheduled archives of
   application volumes with an S3 destination ([Coolify: backups of storage
   mounts](https://coolify.io/docs/core/persistent-storage/storage-mounts/backups)). Use it **only for
   the `backups` volume**: its files are finished, consistent backups. Never use it for the `data`
   volume: an archive of a live database file can be inconsistent, which the same page warns about. Whether
   your Coolify version offers it for a volume that a Compose file declares is not verified; if it does not,
   use option 1.

Do not edit `compose.coolify.yml` on the tracked branch to bind a host directory: the tests pin the two named
volumes, and every later update of the file would conflict with your change. Option 1 reaches the same
directory without touching the file.

Keep at least one copy that is not on the Coolify server, and **test a restore** with a copy that came back
from there ([`app/src/backup/README.md`](../app/src/backup/README.md), "Restore trials").

**Restoring** replaces the database, so the app must be stopped. In short (full version, with the error
codes, in the backup README):

1. While the app container still runs, note its image name:
   `docker inspect --format '{{.Config.Image}}' <app container>` (find the container with `docker ps`).
2. Stop the application in Coolify.
3. On the server, run the restore in a one-off container of that image with the same two volumes:

   ```sh
   docker run --rm --user 10001:10001 \
     -v <data volume>:/data -v <backups volume>:/backups \
     <app image> node /srv/app/backup/cli.ts restore /backups/code-reviewer-20261010T023000Z.db
   ```

4. Start the application and check `/api/health`, the login and the project list.

The command checks the backup first and moves the current database aside (`app.db.before-restore-<time>`)
instead of deleting it. **A leftover `-wal` or `-shm` file next to a restored database must never stay in
place.** SQLite treats `app.db-wal` as part of `app.db`: it replays a log it finds when it opens the database
(and deletes the log after a clean close), so a log of the old database would be replayed into the
restored one. The
restore command therefore moves the old `-wal` and `-shm` away together with the old database. If you ever restore by hand, do the same: stop the app, move `app.db`,
`app.db-wal` and `app.db-shm` aside, and only then put the backup file in place as `app.db`. A backup file itself never has a `-wal`.

## 9. Runner sizing and `RUNNER_CONCURRENCY`

Each review is one PR-Agent process. CR-13 measured about **320 MB per process** at its peak, independent
of the size of the pull request (PR-Agent cuts the diff to its token limit), and 321, 615, 909 and 1203 MB for
one to four processes in parallel. Four processes did not fit into a 1 GiB container (one was killed for
lack of memory), 1.5 GiB was enough. The number of reviews the runner may run at once follows from the
memory it has:

```
RUNNER_CONCURRENCY = floor( (runner memory in MiB - 256) / (321 x 1.5) )
```

256 MiB is reserved for the runner's own loop; 321 MiB is the measured peak of one process, 1.5 is a safety
factor. The runner container in `compose.coolify.yml` is limited to **2 GiB** (`mem_limit: 2g`), which gives
**3** parallel reviews, about 1.5 per GiB. Use this table if you change the limit:

| Runner memory (MiB) | `RUNNER_CONCURRENCY` |
|---|---|
| 1024 | 1 |
| 2048 | 3 |
| 3072 | 5 |
| 4096 | 7 |

The limit and the number belong together: more parallel reviews than the memory allows get processes
killed, and a reviewer sees a failed run. Other limits can apply before memory does: the model provider's
rate limit and GitHub's secondary rate limits.

Server size (CR-13, `docs/spike/cr-13-measurements.md`): operating system 0.3 GB, Docker 0.3 GB, Coolify
about 1 GB, app 0.5 GB, runner 1 GB with three busy slots, 25 percent headroom: **3.9 GB**, so 4 GB is the
calculated minimum. **Recommended: 8 GB RAM and 4 vCPU**, because Coolify's share and the operating system
are estimates, a deployment builds the images on the same machine, and a redeploy briefly runs more
containers. On a 4 GB server use `RUNNER_CONCURRENCY=2` and a runner limit of 1.5 GiB. Disk: the images
need about 1 GB, Docker's build cache more.

## 10. One app instance only

Run exactly **one** app container, and never two Coolify applications on the same volumes:

- The LLM keys that the app hands to the runner for a job are remembered in the memory of the app process,
  so that the key can be masked in what the runner reports. A second process, or a restart, only knows the
  key that is currently configured.
- The database is one SQLite file with one writing process on a local disk. Do not put the `data` volume on
  a network file system.
- The daily backup timer runs inside the app process; two processes would both run it.

Do not scale the application or add replicas. Coolify does not use rolling updates for Docker Compose
applications ([Coolify: rolling updates](https://coolify.io/docs/applications/deployments/rolling-updates)):
a redeploy replaces the containers instead of running the old and the new one side by side, which also keeps
two versions from sharing one database file. The price is a short interruption during a deployment. A webhook
that arrives in that moment is answered with an error; redeliver it under *Recent Deliveries* of the GitHub
App ([`github-app.md`](github-app.md), webhook secret rotation).

## 11. Updates and rollback

**Update.**

1. Make a restore point: run the backup command by hand
   (`node /srv/app/backup/cli.ts backup`, as a scheduled task with *Execute now*, or in the application's
   *Terminal* for the container `app`; if Coolify asks for the generated container name, take the one
   `docker ps` shows).
2. Get the new version into the branch Coolify tracks (a release pull request into `main`). With *Deploy on
   push* Coolify deploys it at once; otherwise press **Redeploy** in Coolify.
3. Follow *Deployment Logs*; the log shows the commit that is deployed. Wait for `app` to be **healthy**.
4. Run `docker/smoke/instance.sh https://<domain>` and open a pull request or comment `/review` on one.

The app migrates its database at start. The data stays: the volumes are the same as before.

**Rollback.** A new version that fails to **build** never replaces the running one. A version that builds but
does not become healthy does:

1. Preferred: put the previous commit back on the tracked branch (revert the release in git, as a pull
   request) and **Redeploy**. Git stays the single record of what runs.
2. Coolify's **Rollback** page redeploys an older image that is still on the server
   ([Coolify: rollbacks](https://coolify.io/docs/applications/deployments/rollbacks)); whether it lists
   images for a Docker Compose application on your version is not verified here. If it does, it is the
   faster way back.

**A rollback does not undo database changes.** A version that applied a database migration leaves a
database that the older version cannot open: it stops at start with a `MIGRATION_FAILED` error
("corrupted migrations: previously executed migration ... is missing"). If that happens, restore the
backup you made before the update ([section 8](#8-storage-and-backups)), then start the older version. Data
written since that backup is lost.

## 12. First-run checklist

Do this once with the whole team in the room; it is the acceptance test of the deployment.

- [ ] `docker/smoke/instance.sh https://<domain>` passes (with `--skip-runner-endpoint` only until the runner
      API is part of the release, [section 7](#7-deploy-and-check-the-instance), step 4).
- [ ] **Sign in.** A team member opens `https://<domain>` and signs in with GitHub. A GitHub account that is
      not on the list is turned away ("Your GitHub account is not allowed to use this Code Reviewer
      instance.") and sees no project or run data.
- [ ] **Install the GitHub App** on a team repository ([`github-app.md`](github-app.md), step 5). The
      `installation` delivery shows 202 under *Recent Deliveries*, and the repository appears in the app.
- [ ] **Activate the repository as a project.** Repositories are inactive until someone activates them. Open
      the Projects page of the app, find the repository and activate it. (The Projects page comes with the UI
      epic; on a build without it the project lead does this with you through the API call described in
      [`app/src/projects/README.md`](../app/src/projects/README.md), which needs a signed-in session.)
- [ ] **Open a test pull request** (not a draft) in that repository. The delivery shows 2xx, the run appears
      in the app and goes from waiting to running to succeeded, and the review comment of the app appears
      on the pull request. The run's detail page shows no error code.
- [ ] **A comment from someone without write access is ignored.** The team member comments `/review`: a run
      starts. A GitHub account without write access comments `/review`: nothing happens.
- [ ] **No secret in the logs.** Search the logs of `app` and `runner` in Coolify and the run details for
      the private key, the webhook secret, `RUNNER_TOKEN`, the LLM key and a token: none appears.
- [ ] **The data survives.** Redeploy: the project, its settings and the run history are still there.
- [ ] **A restart brings it back.** Restart the server (or the Docker service): `app` and `runner` start by
      themselves, `app` becomes healthy, and one more pull request is reviewed. (`restart: unless-stopped`
      does this as long as the Docker service starts at boot, the default on Debian and Ubuntu. A container
      stopped on purpose in Coolify stays stopped.)
- [ ] **Backups.** `/backups` holds a first backup after the first 02:30 UTC (or run the command by hand),
      a copy is on a machine other than the server, and a restore from that copy was tried.

## 13. When something does not work

| Symptom | Likely cause and fix |
|---|---|
| Coolify refuses to deploy and highlights a variable | A required variable ([section 6](#6-environment-variables)) is empty. Enter it. |
| `app` restarts in a loop, the log has one `[deploy]` or `[auth]` line | A setting is missing or invalid; the line names the variable. Typical: `RUNNER_TOKEN` shorter than 32 characters, `BETTER_AUTH_URL` with `http://`, an unusable `GITHUB_APP_PRIVATE_KEY`. |
| The domain shows "No Available Server" or a 404 from the proxy | `app` is not healthy yet, or the domain lacks `:3000` or is attached to the wrong service ([Coolify: troubleshooting](https://coolify.io/docs/applications/builds/docker-compose#troubleshoot-an-unavailable-domain)). |
| No certificate, or a browser warning | DNS does not point to the server yet, or 80 and 443 are closed ([Coolify: Let's Encrypt](https://coolify.io/docs/troubleshoot/dns-and-domains/lets-encrypt-not-working)). |
| GitHub says the callback URL does not match | The OAuth app's callback URL is not exactly `<BETTER_AUTH_URL>/api/auth/callback/github`. |
| A webhook delivery shows 401 | `GITHUB_APP_WEBHOOK_SECRET` differs from the GitHub App's webhook secret ([`github-app.md`](github-app.md), section 4). |
| A webhook delivery shows a timeout, 502 or 503 | The app is unreachable: domain, proxy, health. |
| A run fails with `llm_not_configured` | `LLM_API_KEY` is empty or invalid. |
| The build is killed or the server is unresponsive during a deployment | Not enough memory for the build: more RAM, or a [build server](https://coolify.io/docs/troubleshoot/server/crash-during-build). |

## What is verified

- Automatically, on every pull request: `compose.coolify.yml` is a valid Compose file that builds both
  images from the repository, publishes no port, requires every secret and stays in step with `compose.yml`;
  this guide mentions every variable of `.env.example`; its sizing table matches the formula; the smoke
  script `docker/smoke/instance.sh` is tested against fake instances and runs against the Docker Compose
  stack in CI.
- **Not yet, and left to the first deployment with the customer:** everything that needs a real Coolify
  instance, a domain, a certificate, GitHub's real deliveries and a real model: that Coolify accepts and
  parses the Compose file as described, the domain and certificate, the persistence across a redeploy, the
  update and rollback paths, the behaviour after a server restart, the real review and the checks that no
  secret appears in a log. The steps and wording of Coolify's screens come from Coolify's documentation, not
  from a run.
- Until the runner's job loop and runner API (CR-28, CR-29) are part of the release, the runner container runs
  a placeholder that only logs whether it can reach the app, reviews cannot run, and the runner check of the smoke
  script fails with 404. Until then run the script with `--skip-runner-endpoint`, which is also what the
  compose smoke test in CI does; the option goes away from CI once the runner API is on the branch.
