# Deploying Code Reviewer on Coolify

This guide takes a team from an empty Coolify server to the first real review on one of its own
repositories. Plan for about two hours, most of it waiting for DNS, the build and GitHub. It is written
against Coolify's current documentation (links in each step); the first deployment with the customer is
what verifies it on a real instance, see [What is verified](#what-is-verified).

This guide is for a self-hosted installation, which keeps working unchanged. The hosted deployment on Vercel
(a serverless App, a Dispatcher and a Worker per job in a Sandbox VM) has its own guide, [`deployment-vercel.md`](deployment-vercel.md);
its section "Self-hosted and Coolify" says what does not change here.

What you end up with: one Coolify application of type *Docker Compose*, built from this repository,
with three containers: the **app** (web UI, API, webhook receiver, SQLite database, daily backups) behind
Coolify's proxy under your domain with HTTPS, the **runner** (runs PR-Agent) that has no domain and
no port and only talks to the app, and the **runner-dynamic** (the Dynamic Review runner: built and
started with the rest, but idle until an instance admin turns Dynamic Review on, see
[Dynamic Review runner](#dynamic-review-runner)).

## Contents

1. [What you need](#1-what-you-need)
2. [The decisions in short](#2-the-decisions-in-short)
3. [The GitHub things, and the order](#3-the-github-things-and-the-order)
4. [Create the Coolify application](#4-create-the-coolify-application)
5. [Domain and TLS](#5-domain-and-tls)
6. [Environment variables](#6-environment-variables)
7. [Deploy and check the instance](#7-deploy-and-check-the-instance)
8. [Storage and backups](#8-storage-and-backups)
9. [Runner sizing and `RUNNER_CONCURRENCY`](#9-runner-sizing-and-runner_concurrency)
10. [One app instance only](#10-one-app-instance-only)
11. [Updates and rollback](#11-updates-and-rollback), including [updating an installation from before accounts](#updating-an-installation-from-before-accounts) and [removing comment commands](#removing-comment-commands)
12. [First-run checklist](#12-first-run-checklist)
13. [When something does not work](#13-when-something-does-not-work)
- [What is verified](#what-is-verified)

## 1. What you need

- A **Coolify** instance (self-hosted, version 4) with a server that can run applications. Size: **8 GB
  RAM and 4 vCPU recommended**, see [section 9](#9-runner-sizing-and-runner_concurrency). The images are
  built on that server, which needs extra memory and CPU for a few minutes per deployment. An **x86_64**
  server is needed for Dynamic Review; on arm64 everything still builds and deploys, and Dynamic Review
  stays unavailable ([Dynamic Review runner](#dynamic-review-runner)).
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
| Dynamic Review runner | A third service, `runner-dynamic`, **in the same file and resource** | Coolify takes one Compose file per resource; a second resource would need a manual path and variables. It stays off until the instance gate `dynamic_review` is turned on, so nothing changes for existing projects. [Dynamic Review runner](#dynamic-review-runner). |
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

## 3. The GitHub things, and the order

Two different things on GitHub are involved, which are easy to mix up. Code Reviewer's GitHub App is not
needed to start the instance and to finish the first-run setup ([section 7](#7-deploy-and-check-the-instance)):
it is what lets Code Reviewer review pull requests **and** sign people in with GitHub (the admin always signs
in with email and password). It is created in the browser, in the admin portal under **Integrations**, after
the first-run setup: no environment variable is needed. The separate OAuth app of earlier versions is gone.

| What | Who uses it | Created by | Where its values go |
|---|---|---|---|
| **Coolify's GitHub App** | Coolify, to read this repository and to be told about pushes | Coolify's source wizard ([Coolify: GitHub App](https://coolify.io/docs/applications/sources/github/app)) | Stays inside Coolify. Not an environment variable of Code Reviewer. |
| **Code Reviewer's GitHub App** | Code Reviewer, to receive webhooks, to read and review pull requests and to sign people in | You, once, in the admin portal under Integrations ([`github-app.md`](github-app.md): one click, or by hand) | Stored encrypted in the database. Not an environment variable (an installation from before accounts that still has `GITHUB_APP_*` variables keeps working until the update imports them) |

The App needs the domain, so do it in this order:

1. Server, DNS record and the domain ([section 1](#1-what-you-need)).
2. Coolify's GitHub App with access to this repository ([section 4](#4-create-the-coolify-application)).
3. Create the Coolify application and assign the domain to it (sections 4 and 5).
4. Enter the environment variables in Coolify ([section 6](#6-environment-variables)) and deploy
   ([section 7](#7-deploy-and-check-the-instance)). Only `APP_SECRET`, `BETTER_AUTH_URL` and `RUNNER_TOKEN`
   are needed.
5. Finish the first-run setup in the browser, then create Code Reviewer's GitHub App in the admin portal
   (Integrations > Create GitHub App, [`github-app.md`](github-app.md)): GitHub sends the webhook deliveries
   to `https://<domain>/api/webhooks/github-app`, which now answers.
6. Install the GitHub App on the repositories ([`github-app.md`](github-app.md), "Install the App").

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

> The GitHub App and "Sign in with GitHub" are configured in the admin portal now, not here
> ([`github-app.md`](github-app.md)). The `GITHUB_APP_*`, `ALLOWED_GITHUB_*` and `LLM_*` rows below describe an
> installation from before accounts: the update to accounts **imports them once** on its first start and ignores
> them afterwards ([updating an installation from before accounts](#updating-an-installation-from-before-accounts)).
> `GITHUB_OAUTH_*` are no longer used and `ALLOWED_GITHUB_*` no longer decide who may sign in (the sign-up rule
> and the workspaces do). On a new instance all of them are ignored.

Open **Environment Variables** of the application. Coolify lists every variable that
`compose.coolify.yml` references; the ones marked required block the deployment while empty
([Coolify: Docker Compose variables](https://coolify.io/docs/applications/builds/docker-compose#environment-variables)).
The file [`.env.example`](../.env.example) explains each setting in detail and is the master list: this
table is checked against it and against the Compose file by a test.

Generate random values on any machine with the `openssl rand` command given for them in the table. Never reuse a value between
environments. Put every secret into the team's password manager first. Coolify expands `$` references in
values unless the variable's *Interpolation* is set to **Literal (keep $ characters as-is)**
([Coolify: multiline and literal values](https://coolify.io/docs/applications/configuration/environment-variables#multiline-and-literal-values)).
The values from `openssl rand` contain no `$`; for any secret that does (a password manager
value), set Literal.

| Variable | Required | Where the value comes from | Notes |
|---|---|---|---|
| `BETTER_AUTH_URL` | yes | The public address: `https://<domain>` | No path, no port, no trailing slash. If you use GitHub sign in, register `<this>/api/auth/callback/github` as the OAuth app's callback URL. |
| `APP_SECRET` | by the app | `openssl rand -base64 32` | **Required**, at least 32 characters. The master key of the instance: it signs the session cookie and encrypts the credentials stored in the database. Coolify does not block the deployment when it is empty, the app refuses to start and the log names the variable. **Back it up separately from the database** (a password manager): a database restored without its `APP_SECRET` loses every stored credential, and it cannot be recovered. Changing it signs everybody out. |
| `BETTER_AUTH_SECRET` | deprecated | The value an existing deployment already has | The old name of `APP_SECRET`. The app uses it as `APP_SECRET` while `APP_SECRET` is empty (and logs once that it is deprecated), so an existing deployment keeps its sessions and stored tokens. When you update, add `APP_SECRET` with **exactly this value** first; remove this one only after that (removing it before leaves the instance without a master key, and the app does not start); two different values sign everybody out and make the stored GitHub tokens of the earlier sign in unreadable. |
| `GITHUB_OAUTH_CLIENT_ID` | optional | Nowhere: no longer used | The separate OAuth app of earlier versions is replaced by the user authorization of the GitHub App (client id and secret are entered in the admin portal) and is never imported. Remove it. |
| `GITHUB_OAUTH_CLIENT_SECRET` | optional | Nowhere: no longer used | Secret of the old OAuth app. Remove it. |
| `ALLOWED_GITHUB_LOGINS` | optional | Comma separated GitHub logins of the earlier allow list | No longer decides who may sign in: the sign-up rule and the workspaces do (admin portal). The update to accounts reads it once to decide who becomes a member, then ignores it. A login can be bound to its numeric id (`octocat:583231`): [`app/src/auth/README.md`](../app/src/auth/README.md). |
| `ALLOWED_GITHUB_ORG` | optional | The name of a GitHub organization (`github.com/<name>`) of the earlier allow list | Read once by the update to accounts, like `ALLOWED_GITHUB_LOGINS`; it never becomes a sign-up rule. |
| `GITHUB_APP_ID` | optional | The App ID on the GitHub App's settings page | Only for an installation from before accounts: imported once into the encrypted store on the first start after the update, then ignored ([`github-app.md`](github-app.md), "Older installations"). Set all four GitHub App values or none; a value that is missing or unusable is not imported, and the log and the admin portal name the variable. |
| `GITHUB_APP_SLUG` | optional | The last part of `github.com/apps/<slug>` | |
| `GITHUB_APP_WEBHOOK_SECRET` | optional | The secret entered in the GitHub App's webhook settings | Secret. Byte for byte: no trailing space or line break. |
| `GITHUB_APP_PRIVATE_KEY` | optional | The `.pem` file generated on the GitHub App's settings page | Secret. In Coolify choose the value type **Multiline** and paste the key with its line breaks, or paste it on one line with the breaks written as `\n`; both give the same key ([`github-app.md`](github-app.md), "Older installations"). The key is parsed at the import; an unusable one is not imported, the log names the variable, and GitHub stays not configured until the App is entered in the admin portal. |
| `RUNNER_TOKEN` | yes | `openssl rand -hex 32` | At least 32 characters. Secret shared by the app and the runner; both read this one variable. |
| `OPERATOR_API_TOKEN` | optional | `openssl rand -hex 32` | Secret. Switches on the operator API (`/api/operator/v1`), with which an external service reads the workspaces and sets their limits, key mode and suspension ([`app/src/operator-api/README.md`](../app/src/operator-api/README.md), format in [`contracts/operator-api.v1.json`](../contracts/operator-api.v1.json)). Leave it empty and the API does not exist (its paths answer 404). At least 32 characters, no white space, different from `RUNNER_TOKEN`, `APP_SECRET` and `BETTER_AUTH_SECRET`: the same value as any of them stops the start, a weak one keeps the API off and the log says so (never the value). |
| `LLM_API_KEY` | optional | The OpenRouter API key | Legacy, secret. Every workspace enters its own key in the UI (Settings, LLM access). The update imports this one **once** into the default workspace (encrypted) and does not read it afterwards. Without a key, reviews of a workspace fail with `llm_not_configured`: enter one before the first review. |
| `LLM_PROVIDER` | optional | `openrouter` | The only provider for now; this is the default. |
| `LLM_MODEL` | optional | An OpenRouter model name | Default `anthropic/claude-haiku-5.5`. The review settings in the UI can choose another model per project. The update also copies a model that differs from the default into the review defaults of the default workspace, so removing this variable later does not change the model. |
| `LLM_MAX_TOKENS` | optional | Context window of a model PR-Agent does not know | Leave empty for known models. |
| `DATABASE_BUSY_TIMEOUT_MS` | optional | A number of milliseconds | How long a database write waits for a lock. Empty: 5000. |
| `BACKUP_TIME` | optional | `HH:MM` in UTC, or `off` | When the app backs up the database every day. Empty: `02:30`. Use `off` only together with a Coolify scheduled task, [section 8](#8-storage-and-backups). |
| `RUNNER_CONCURRENCY` | optional | A whole number from 1 to 32 | How many reviews the runner runs at once, [section 9](#9-runner-sizing-and-runner_concurrency). Empty: 3 (right for the runner's 2 GiB). Raise it only together with `RUNNER_MEMORY_LIMIT`. |
| `RUNNER_MEMORY_LIMIT` | optional | A Docker memory size such as `3g` or `1536m` | The memory the runner container may use. Empty: 2g. Change it together with `RUNNER_CONCURRENCY`, the pairs are in [section 9](#9-runner-sizing-and-runner_concurrency). |
| `RUNNER_JOB_TIMEOUT_SECONDS` | optional | A number of seconds | Hard timeout of one review; the runner ends a longer one and reports `timeout`. Empty: 1200 (20 minutes). |
| `RUNNER_POLL_INTERVAL_SECONDS` | optional | A number of seconds | How long the runner waits between two requests for work when nothing is waiting. Empty: 5. |
| `RUNNER_ID` | optional | A name | Shown in the app's logs as the name of this runner (letters, digits and `._:@-`). Empty: `runner-<container host name>`. |
| `RUNNER_DYNAMIC_CONCURRENCY` | optional | A whole number from 1 to 32 | Dynamic jobs at once on `runner-dynamic`. Empty: 1. Do not raise it before the measurements of `docs/dynamic-review.md` exist ([Dynamic Review runner](#dynamic-review-runner)). |
| `RUNNER_DYNAMIC_MEMORY_LIMIT`, `RUNNER_DYNAMIC_MEMORY_RESERVATION` | optional | A Docker memory size such as `2g` or `1536m` | The memory limit (also the swap limit: there is no swap) and the soft reservation of `runner-dynamic`. Empty: `2g` and `1536m`. |
| `RUNNER_DYNAMIC_MAX_COST_USD` | optional | A plain decimal number such as `2.5` | The most one Dynamic Review run may cost, in USD. Empty: 1.00. The runner refuses a value that is not above 0 or is above 20 (`dynamic_config_invalid`). A run is stopped before a call that could take it over the limit. |
| `RUNNER_DYNAMIC_CAPABILITIES` | optional | JSON, for example `{"tool_choice_required":true,"structured_output":true,"max_output_tokens":32768,"input_usd_per_mtok":0.5,"output_usd_per_mtok":2}` | A **ceiling** on what the Dynamic runner lets a model do. The app reads each model's capabilities, window and prices from OpenRouter's public model metadata when it claims a job and sends them with it, so **leave this empty**: any tool-capable OpenRouter model runs, and the shipped default stays valid. Set it only to narrow the models' values (both must support the features, the smaller output limit and window win, the higher unit price wins); a job can never widen it. Without the app's description (an older app, or OpenRouter could not be asked) the description built into the runner applies to the default model `deepseek/deepseek-v4.1-flash` only, and another model then needs the unit costs here (`input_usd_per_mtok`, `output_usd_per_mtok`) or ends with `dynamic_config_invalid`. A value that is set but unusable fails the job. |

Variables that exist in `.env.example` but that you **do not set on Coolify**:

| Variable | Required | Why not |
|---|---|---|
| `APP_IMAGE`, `RUNNER_IMAGE`, `RUNNER_DYNAMIC_IMAGE` | not used | Only `compose.yml` and `compose.dynamic.yml` pull or tag images by these names. Coolify builds them. |
| `APP_PORT`, `APP_BIND_ADDRESS` | not used | Only `compose.yml` publishes a port. |
| `GITHUB_APP_PRIVATE_KEY_PATH` | not used | The Compose file mounts no key file; use `GITHUB_APP_PRIVATE_KEY`. |
| `DATABASE_URL`, `DATABASE_POOL_MAX` | not used | Only the large (Postgres) topology sets them; on Coolify the database is the SQLite file in the data volume ([deployment-large.md](deployment-large.md)). |
| `APP_RUNTIME`, `VERCEL`, `DATABASE_URL_MIGRATE`, `CRON_SECRET` | not used | For a hosted deployment on a serverless platform only: the runtime mode (`server` is the default and what Coolify runs), the platform's own marker, the direct database URL of `pnpm migrate`, and the secret of the platform's cron (the daily sync and the once-a-minute sweep). Leave them unset; the app then behaves exactly as described in this guide. |
| `RUNNER_DISPATCH`, `RUNNER_WEBHOOK_URL`, `RUNNER_WEBHOOK_SECRET`, `RUNNER_WEBHOOK_KEY_ID`, `RUNNER_WEBHOOK_SECRET_PREVIOUS`, `RUNNER_WEBHOOK_KEY_ID_PREVIOUS`, `RUNNER_WEBHOOK_BYPASS_TOKEN`, `RUNNER_DISPATCH_GIVE_UP_SECONDS`, `RUNNER_DISPATCH_MAX_RUNNING` | not used | For a hosted deployment with a Dispatcher only: with `RUNNER_DISPATCH=webhook` the app sends a signed wake-up call to the Dispatcher after it queued a job ([`app/src/dispatch/README.md`](../app/src/dispatch/README.md)). Here the runner polls, which is the default (`poll`). Leave them unset. |
| `BACKUP_DIR` | not used | The image fixes it to `/backups`, the mount point of the backup volume. |
| `ALLOW_TEST_GITHUB_ENDPOINTS`, `GITHUB_OAUTH_BASE_URL`, `GITHUB_API_BASE_URL` | not used | For the test stack with a fake GitHub only. Never set them in a real deployment. |
| `ALLOW_TEST_LLM_ENDPOINTS`, `LLM_API_BASE_URL` | not used | For the test stack with a fake LLM only (the "test key" button). Never set them in a real deployment. |
| `ALLOW_TEST_DISPATCH_TIMING`, `TEST_DISPATCH_INLINE_RETRY_DELAYS_MS` | not used | For the test lane that starts its own Dispatcher only (longer pauses between the repeats of a wake-up). Never set them in a real deployment. |
| `RUNNER_API_URL` | fixed | The Compose file sets it to `http://app:3000`, the app over the Docker network. It is not a setting. |
| `RUNNER_SHUTDOWN_GRACE_SECONDS` | not used | How long running reviews may finish after a stop. The Compose file leaves the runner's 60 seconds and gives the runner `stop_grace_period: 90s` for it ([section 9](#stopping-the-runner)); the two belong together. |
| `PR_AGENT_COMMAND` | not used | Replaces PR-Agent by another command, for test stacks with a fake. The runner would hand that command every job with its GitHub token and LLM key. The Compose files never pass it on; never set it. |

After changing a variable, save and **Restart** (only runtime values changed) or **Redeploy**
([Coolify: apply changes](https://coolify.io/docs/applications/configuration/environment-variables#apply-changes)).

## 7. Deploy and check the instance

1. Press **Deploy** and follow **Deployment Logs**: both images are built, then the stack starts. The
   runner starts only after the app reports healthy.
2. In Coolify, `app` must show **healthy** and `runner` **running**. The log of the `runner` has a line like
   `runner runner-3f2a started: 3 slots` and, after that, no `trying again in ...` warning: those mean that
   the app cannot be reached or refuses the runner's token. (On a new instance the warning says `HTTP 503`
   until the first-run setup below is finished: the runner API waits for it, and the runner keeps trying.) The app's health check is
   `GET /api/health` inside the container; it reads the database. If the app never becomes healthy,
   open its logs and read the last lines first: a missing or invalid setting stops the start with one
   line that names the variable (for example `[deploy] DEPLOY_CONFIG_INVALID` or an `[auth]` line),
   never its value, and `restart: unless-stopped` turns that into a restart loop.
3. Open `https://<domain>`: the page loads over HTTPS with a valid certificate and asks for a **setup
   code**. A new instance is not set up yet. Do the first-run setup now, as described below.
4. After the setup, run the smoke test from any machine that has `curl` and a checkout of this repository
   (it needs no secret):

   ```sh
   docker/smoke/instance.sh https://<domain>
   ```

   It checks that `/api/health` and `/login` answer 2xx, that a webhook delivery with a wrong signature
   gets 401, and that the runner API refuses a request without a token with 401. Any deviation makes
   the exit code non-zero and names the check. There is no option to leave a check out. Before the
   setup is finished it fails once, with a message that the instance is not set up yet (every request
   but the health check answers `503 setup_required` until then).
5. Compare the variables in Coolify with the table in [section 6](#6-environment-variables). If you use GitHub
   sign in, check that the GitHub App is configured in the admin portal (Integrations shows it as
   **Configured** and the login page offers "Sign in with GitHub"). Where the app
   shows configuration hints (the setup status of the project pages), they are empty once everything is set.
6. From outside the server, only 80 and 443 answer (for example `nmap -p 1-10000 <server-ip>` from another
   machine; your hosting provider's firewall helps), and the runner has no domain.
7. Check the webhook: [`github-app.md`](github-app.md), "Check the webhook".

### The first-run setup

Every start of the app prints a fresh 6-digit **setup code** in its log while the instance is not set up:

1. In Coolify open the **Logs** of the service `app` and look for the line `[setup] Setup code: 482913 ...`
   (the number is yours). On a plain Docker host: `docker compose logs app`. The code appears nowhere else
   and is never sent to a browser.
2. Open `https://<domain>`, enter the code, and answer three questions: single-tenant or multi-tenant,
   who may sign up (everyone, a list of emails, or allowed email domains), and the email address and
   password of the **instance admin**. The password needs 12 to 128 characters and must not be a common
   password; there are no other rules. The same rule applies to every account of the instance.
3. You land in the admin area (`/admin`), signed in. The setup page is gone for good (it answers 404).

What to know:

- **A lost admin password** (with a mail server, "Forgot your password?" on the sign-in page mails a link;
  without one): run `admin reset-password <email>` inside the `app`
  container (Coolify: the **Terminal** of the service `app`; plain Docker: `docker compose exec app admin
  reset-password <email>`). It prints a link that sets a new password once, within 30 minutes, and signs the
  account out everywhere. Whoever can open a shell in the container can do this; that is the proof of
  operator rights.
- **Mail** is set up in the admin portal (**Mail**), never through environment variables: SMTP host, port, how
  the connection is secured (STARTTLS on port 587, TLS on 465, or none, which the page warns about), the login
  and the sender address. The password is stored encrypted with a key derived from `APP_SECRET`, shown nowhere
  and never returned; leave the field empty to keep it. **Send test mail** sends one message to your own
  address and, when it fails, says why in words (host not found, nothing listening, certificate, login
  refused, sender refused, timeout). Certificates are checked; "Accept a self-signed certificate" turns the
  check off for a mail server on a network you control. The app connects to the host you enter **from its own
  network**, so the mail server must be reachable from the `app` container and you should only enter one you
  trust. Ports below 1024 other than 25, 465 and 587 are refused. With a mail server people confirm their
  address by link, and can reset a forgotten password; removing it later is allowed and the sign-up rules that
  need verification close again. If the stored password cannot be read (another `APP_SECRET`), the page says
  so: enter it again.
- The code is valid for **60 minutes**, works once, and the setup session that follows it lasts **30
  minutes**. If either runs out, **restart the app**: it prints a new code. A restart before the wizard is
  finished shows the wizard again from the start.
- About 5 attempts per minute are accepted (counted for the whole process, not per address). After **10
  wrong codes** the setup is **locked until the app is restarted**. This is a deliberate trade-off: whoever
  can reach the site can lock the setup (a restart fixes it), but cannot get in: the chance to guess the
  code is at most 10 in 1,000,000 per restart.
- The code and its counters live **in the memory of one process**. The setup must therefore be done with
  **one app instance running** ([section 10](#10-one-app-instance-only)).
- An email or domain sign-up rule cannot be evaluated while no email can be verified (no mail server and
  GitHub is not the only sign-in method): nobody but the admin can sign up under it until a mail server is
  configured. The wizard says so next to the choice. Under the rule "everyone" people can sign up at
  `/sign-up` at once; with a mail server they have to confirm their address with a link first. A new
  account belongs to no workspace and sees no data until an admin invites it.
- When a GitHub App is configured (in the admin portal, or imported by the update), the synchronization with GitHub
  that runs at start lists the installations of the App. It never makes a connection from the list: an
  installation is noted as unclaimed (the admin portal shows them under **Approvals**) until a person of a
  workspace connects it, or, in a single-tenant instance whose App is private, until it is found on the App's own
  account. Installations that were linked before the update keep their workspace. Without an App nothing is
  attempted: GitHub is simply not configured.
- An existing deployment that updates to this version also gets the code and the wizard, after its data and
  settings were imported (the data it has is kept). Until the wizard is finished only the web UI waits: the
  webhooks and the runner API keep working, so reviews do not stop. The steps are in
  [updating an installation from before accounts](#updating-an-installation-from-before-accounts).

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
instead of deleting it. **A leftover `-journal`, `-wal` or `-shm` file next to a restored database must never stay in
place.** SQLite treats `app.db-wal` as part of `app.db`: it replays a log it finds when it opens the database
(and deletes the log after a clean close), and it rolls a leftover `app.db-journal` (the rollback journal of an interrupted write) back into whatever file has the name. A log or journal of the old database would be applied to the
restored one. The
restore command therefore moves the old `-journal`, `-wal` and `-shm` away together with the old database. If you ever restore by hand, do the same: stop the app, move `app.db`,
`app.db-journal`, `app.db-wal` and `app.db-shm` aside, and only then put the backup file in place as `app.db`. A backup file itself never has a `-wal`.

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
factor. The runner container in `compose.coolify.yml` is limited to **2 GiB** (`2g`, the default of the
variable `RUNNER_MEMORY_LIMIT`), which gives **3** parallel reviews, about 1.5 per GiB. To run more, set the
two variables as a pair in Coolify's *Environment Variables* and redeploy; no change to the tracked Compose
file is needed. Pairs that follow the formula:

| Runner memory (MiB) | `RUNNER_MEMORY_LIMIT` | `RUNNER_CONCURRENCY` |
|---|---|---|
| 1024 | `1g` | 1 |
| 2048 | `2g` | 3 |
| 3072 | `3g` | 5 |
| 4096 | `4g` | 7 |

The limit and the number belong together: more parallel reviews than the memory allows get processes
killed, and a reviewer sees a failed run. Other limits can apply before memory does: the model provider's
rate limit and GitHub's secondary rate limits.

Server size (CR-13, `docs/spike/cr-13-measurements.md`): operating system 0.3 GB, Docker 0.3 GB, Coolify
about 1 GB, app 0.5 GB, runner 1 GB with three busy slots, 25 percent headroom: **3.9 GB**, so 4 GB is the
calculated minimum. **Recommended: 8 GB RAM and 4 vCPU**, because Coolify's share and the operating system
are estimates, a deployment builds the images on the same machine, and a redeploy briefly runs more
containers. On a 4 GB server use `RUNNER_CONCURRENCY=2` and `RUNNER_MEMORY_LIMIT=1536m`. Disk: the images
need about 1 GB, Docker's build cache more.

**The Dynamic runner adds to this.** `runner-dynamic` is limited to **2 GiB** (`RUNNER_DYNAMIC_MEMORY_LIMIT`,
no swap, 1.5 GiB reserved) and is built on the same server. It also takes **Diff jobs** like the runner
above (it keeps `pr-agent` among its engines, as every runner does), with one slot
(`RUNNER_DYNAMIC_CONCURRENCY=1`): from the first deployment the Diff capacity is 3 + 1 slots, and
the 2 GiB are in use whenever a Diff job runs there, not only while a Dynamic job runs (before the gate
is on it claims no Dynamic job, but it takes Diff jobs from the first deployment); a Diff
job (up to 20 minutes) can also occupy the one Dynamic slot once the gate is on, so a Dynamic run
may wait for it. That is why the recommended server for an installation that will use Dynamic Review
is **8 GB RAM or more**; the 4 GB minimum above is for the Diff runner alone,
and a 4 GB server should leave the gate off or set `RUNNER_DYNAMIC_MEMORY_LIMIT=1536m` and
`RUNNER_DYNAMIC_MEMORY_RESERVATION=1g` only after the measurements of `docs/dynamic-review.md`
("Capacity") exist. The second image adds about 60 MB for the pinned engine and some build time to every
deployment.

### Stopping the runner

A stop (`docker compose stop`, and in the same way a redeploy that replaces the container) sends the runner
`SIGTERM`. The loop then claims nothing more, gives the reviews that are running up to 60 seconds to finish,
and reports the ones that are still running as failed with the code `runner_shutdown`; the app puts such a
job back into the queue, so the review is run again by the next runner. The Compose files give the container
`stop_grace_period: 90s`, 90 seconds (the 60, five more between the polite and the hard kill of a stuck
review, up to ten to send the report, and some margin), because Docker's default of 10 seconds would kill the
runner before it has reported anything. The runner's image starts it behind `tini`, which passes the signal
on, so no `init: true` is needed. `docker/smoke/compose.sh` proves that Docker waits for the runner's report instead of killing it after 10 seconds (with a fake review and a shortened grace period of 20 seconds; the 60 + 5 + 10 arithmetic is pinned by unit tests). Do not stop the
runner with `docker kill`. Whether Coolify waits for `stop_grace_period` when it redeploys is not verified
(see [What is verified](#what-is-verified)); the worst case is a job that is taken back when its lease runs out
two minutes later.

### Restrict what the runner can reach

The runner is the one component that handles text an outsider wrote (the title, description, diff and
comments of a pull request) and passes it to a model, with a GitHub token and the LLM key in the process.
The app filters what it can (for example image links a comment once carried with an `/ask` question, which PR-Agent would fetch from the
runner), but the network is the second line: **the runner needs to reach only three things**,

- `api.github.com`, HTTPS port 443 (GitHub's API; GitHub Enterprise Server would be its own host),
- `openrouter.ai`, HTTPS port 443 (the models),
- the `app` container on the Docker network, `app:3000` (the runner API),

plus DNS. The Compose files do not enforce this, because Docker has no switch for it and the allowed
addresses of GitHub and OpenRouter change. Two ways to enforce it on the server, to be chosen and set up
by whoever runs it (neither is part of the shipped files nor tested):

1. **Firewall on the host.** Docker evaluates rules in the `DOCKER-USER` chain before its own: for the
   source address range of the runner's container network, accept established traffic, DNS and the app's
   network, accept HTTPS to the addresses of the two hosts above, and drop the rest. Because the addresses
   change, refresh the list on a schedule, or use a firewall that can filter by name.
2. **A filtering proxy.** Put a forward proxy that only allows the two host names next to the runner,
   set `HTTPS_PROXY` (and `NO_PROXY=app`, so that the calls to the app stay direct) for the runner (the loop passes proxy settings on to its review processes), and put the
   runner on a Docker network without a route to the internet, so that the proxy is its only way out.
   This needs a change of the Compose file, which Coolify's tracked file should keep (the tests pin its
   shape): do it in a fork or ask for a change in the repository.

After either, run a review (`/review` on a test pull request) and check the runner log for
`no answer from the app` or model and GitHub errors (`git_unavailable`, `llm_unavailable`).

The **app** also makes one outbound request to `openrouter.ai` (HTTPS port 443, no key) whenever a Dynamic
model is saved in a project's settings, to read whether the model supports tool calling. If the app cannot
reach that host, the save still works after a wait of at most 5 seconds and shows a warning that the model
could not be checked (`src/llm/README.md`, "Model capabilities").

### Dynamic Review runner

`compose.coolify.yml` has a third service, `runner-dynamic`, the runner of Dynamic Review
(`docs/dynamic-review.md`). It is part of **the same Coolify resource**: after the next release the
resource that deploys this file builds the `dynamic` target of `runner/Dockerfile` on the server (it
downloads the pinned engine, about 60 MB, and rejects it if it is not the pinned file) and starts the
runner with the app and the Diff runner. There is no second resource, no new path and no new variable
to enter: it uses the existing `RUNNER_TOKEN` and reaches the app at `http://app:3000` over the Docker
network like the Diff runner. The description of the default model `deepseek/deepseek-v4.1-flash` is
built into the runner image as a fallback, and the app sends the description of every job's model from
OpenRouter's model metadata, so `RUNNER_DYNAMIC_CAPABILITIES` stays empty ([section 6](#6-environment-variables));
a fix of the built-in description therefore ships with the next release and is not frozen in a stored
Coolify variable.

**Requires x86_64 for Dynamic Review.** The pinned engine exists for linux/x86_64 only. On an **arm64**
Coolify server the build does not fail: the engine download is skipped, the image has no engine, and
`runner-dynamic` logs `engine_binary_missing` and serves Diff jobs only. The app and the Diff runner
deploy as usual and Dynamic Review stays unavailable (the gate can be turned on, but a Dynamic run then
ends with `no_capable_runner`).

**What stays the same, and what does not.** Dynamic Review is off until an instance admin turns the
gate on (Admin, Setup, Instance, Dynamic Review; default off, see `docs/dynamic-review.md`,
"Activation, step by step"). Until then `runner-dynamic` claims no Dynamic job and **no project's review
kind or result changes**. It does, from the first deployment, also take **Diff jobs**: they are shared
by both runners, so some Diff reviews now run in the `runner-dynamic` container (2 GiB, read-only root
filesystem), and once the gate is on a Diff job can occupy its single slot while a Dynamic run waits.
**This section has not been tested on a real Coolify
instance**: the Compose file and the image are tested in CI (the service is pinned equal to the one of
`compose.dynamic.yml`, the image build and its smoke test start the runner in a container created like the
file creates it), but how Coolify handles `user: "0:0"`, the capability list, `no-new-privileges`,
`read_only` and the tmpfs, and whether the Docker host's kernel has `nf_tables`, is for the first
deployment to find out. If Coolify refuses the file, the whole deployment fails, not only this service:
see [section 13](#13-when-something-does-not-work).

1. **Deploy** as usual (a release into `main`, or **Redeploy**). Server sizing for the extra 2 GiB is in
   [section 9](#9-runner-sizing-and-runner_concurrency).
2. **Check the self-check.** Read the log of `runner-dynamic`: it must contain `Dynamic Review: opencode is
   advertised, the startup self-check passed`. If it says `opencode is not advertised`, the reason is on
   the same line; the table in `docs/dynamic-review.md` ("The startup self-check") lists them. Typical on
   a managed host: `network_rules_not_installed` (the host kernel has no `nf_tables`, or Coolify stripped
   `NET_ADMIN`) or `not_root_supervisor` (the platform ignored `user: "0:0"`). The runner then **serves
   Diff jobs only**, logs why, and the app and the Diff runner are not affected. This includes a
   Coolify that drops `NET_ADMIN` but keeps `SETPCAP` (`network_rules_not_installed`: Diff only). One case
   stops the container instead: if Coolify drops `SETPCAP`, the runner cannot end its startup capabilities and
   refuses to start (`cannot start: dynamic_isolation_self_check_failed` in the log). Only that container
   is affected; it restarts in a loop until the setting is fixed or the service is removed from your copy
   of the file.
3. **Check that the hardening took effect.** The passing self-check of step 2 already proves the root
   supervisor, the engine user, the network rules and that `NET_ADMIN` and `SETPCAP` are gone. What it does not
   show is what Coolify did to the rest of the file. In the Coolify terminal of `runner-dynamic` (or
   `docker exec` on the server) `touch /usr/x` must fail with "Read-only file system" (`read_only`), and
   `mount | grep -E ' /(tmp|run|home/runner) '` must show those three paths as `tmpfs` with `noexec,nosuid,nodev`.
   On the server, `docker inspect <container> --format '{{json .HostConfig}}'` must show `ReadonlyRootfs`
   true, `CapDrop` `ALL`, `CapAdd` with exactly the eight capabilities of the file, `no-new-privileges` in
   `SecurityOpt`, the three `Tmpfs` entries, no `Binds`, no `Devices`, not `Privileged`, the memory limit
   of 2 GiB with the same swap limit, and `PidsLimit` 512. If one of them differs, Coolify changed a setting
   of the file: do not turn the gate on.
4. **Turn Dynamic Review on** only when 2 and 3 hold: follow "Activation, step by step" of
   `docs/dynamic-review.md` from the step that turns the gate on. To roll back, switch the gate off first
   (running jobs finish), then stop the service in Coolify.

**It cannot be left out of the file by a setting.** Every deployment of this file builds and starts
`runner-dynamic`; the gate, not a variable, is what keeps it idle. A self-hoster who does not want the
container at all (for example on a small server) deletes the `runner-dynamic` service from their copy of
`compose.coolify.yml` (a fork, or a Compose file of their own), or simply leaves the gate off and stops the
service in Coolify's UI; the app and the Diff runner never depend on it.

The file runs the Dynamic runner's loop as root with a short list of capabilities and sets
`RUNNER_DIFF_JOB_USER` (`10001:10001`), so that PR-Agent jobs still drop to the unprivileged user; that
is fixed by the file, not a setting to change (see "The engine boundary" in `docs/dynamic-review.md`).
The container runs with a read-only root filesystem and three small tmpfs (#249), so a restarted
container gets its startup capabilities again but runs the image as built. Keep these settings.

The firewall advice above ("Restrict what the runner can reach") covers this runner too: it needs
GitHub, the model endpoint and the app, and its engine user is confined to the runner's own proxy by
rules inside the container, which is not a substitute for it.

## 10. One app instance only

Run exactly **one** app container, and never two Coolify applications on the same volumes:

- The LLM keys that the app hands to the runner for a job are remembered in the memory of the app process,
  so that the key can be masked in what the runner reports. A second process, or a restart, only knows the
  key that is currently configured.
- The database is one SQLite file with one writing process on a local disk. Do not put the `data` volume on
  a network file system.
- The daily backup timer runs inside the app process; two processes would both run it.
- The **setup code** and its failure counter are in the memory of the process that printed them. A second
  process has its own code and its own counters, and refuses the code of the first. Do the first-run
  setup with one app instance running ([section 7](#the-first-run-setup)), and only then, if ever, scale out.

Do not scale the application or add replicas. Coolify does not use rolling updates for Docker Compose
applications ([Coolify: rolling updates](https://coolify.io/docs/applications/deployments/rolling-updates)):
a redeploy replaces the containers instead of running the old and the new one side by side, which also keeps
two versions from sharing one database file. The price is a short interruption during a deployment. A webhook
that arrives in that moment is answered with an error; redeliver it under *Recent Deliveries* of the GitHub
App ([`github-app.md`](github-app.md), webhook secret rotation).

## 11. Updates and rollback

> **Release with check runs and review verdicts (#405).** Accept the new *Checks* permission of the GitHub App on each installation, and know that every existing project starts to submit a review verdict (`APPROVE` / `REQUEST_CHANGES`) after the update; set a project's *Review verdict* to `off` to keep it as it was. Details: [Updating to the release with check runs and review verdicts](../README.md#updating-to-the-release-with-check-runs-and-review-verdicts).

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

### Updating an installation from before accounts

This is the update of an instance that was set up before accounts existed: the GitHub OAuth app and the allow list
(`GITHUB_OAUTH_*`, `ALLOWED_GITHUB_*`), the GitHub App (`GITHUB_APP_*`) and the LLM key (`LLM_*`) in the
environment, `BETTER_AUTH_SECRET` as the master key, users who signed in with GitHub. Nothing is lost: its data
stays, and its settings move into the new model once. You do a **short setup** once and nothing else.

**Before the update**

1. **Add `APP_SECRET` with exactly the value of `BETTER_AUTH_SECRET`** (keep `BETTER_AUTH_SECRET` until the setup is
   done). `APP_SECRET` is the master key that encrypts every stored credential. With only `BETTER_AUTH_SECRET` the
   app works too (it logs that the name is deprecated). A different value signs everybody out, and the stored
   GitHub tokens of the earlier sign in can no longer be read, so the organization check of the import cannot run
   and the people it would have admitted are only listed in the notice.
   **Back `APP_SECRET` up separately from the database** (a password manager): a database restored without it loses
   every stored credential.
2. Leave every other variable as it is. The update needs them once.
3. The `backups` volume must be mounted and writable (`compose.coolify.yml` declares it). The update takes a backup
   before it touches the database and does not start without one.

**What happens on the first start.** Open the **Logs** of the service `app` in Coolify. The lines, in this order:

1. `[update] BACKUP_BEFORE_UPDATE` and `[backup] created /backups/code-reviewer-before-update-<time>.db`: the
   database exactly as the previous version left it. To go back, restore it ([section 8](#8-storage-and-backups))
   and deploy the previous commit. The daily rotation never deletes this file (its name is not one of the daily
   backups'); delete it yourself once the update is settled. It is taken once: a restart after a failed import, or
   in a restart loop, takes no second one.
   If the backup cannot be written the start ends with `UPDATE_BACKUP_FAILED` and the database is untouched.
2. `[database] applied migrations: ...`.
3. `[import] IMPORT_DONE ...`: how many people became members, whether the GitHub App and the LLM key were
   imported. A variable that could not be imported (a broken private key, a key with a space) gets a
   `VARIABLE_NOT_IMPORTED` line that names the **variable**, never its value; everything else is imported anyway.
   If the import fails (`IMPORT_FAILED`) it changed nothing; fix the cause and start again, the whole import then
   runs from the beginning. No second backup is taken: the one of step 1 is the only way back to the previous
   version, and a copy of the migrated database could not be started by it.
4. `[import] LEGACY_VARIABLES_IGNORED: ...`: the old variables are ignored from now on (names only).
5. **`[setup] Setup code: 482913 ...`**: the code for the short setup (the number is yours). It is valid for 60
   minutes; restart the app for a new one. A restart before you finished the wizard prints a new code and imports
   nothing twice.

**Reviews keep running** while you have not found the code: webhooks and the runner API serve with the imported
GitHub App and LLM key; only the web UI waits for the setup.

**What you do once** (`https://<domain>`):

1. Enter the code and answer the three questions: **single-tenant** (what the instance was; choose multi-tenant only if
   you want people to create workspaces), **who may sign up**, and the email and password of the **instance admin**.
   Mind the second question: `ALLOWED_GITHUB_LOGINS` and `ALLOWED_GITHUB_ORG` are **not** turned into a sign-up rule,
   so for an update the wizard starts on "a list of email addresses" (it works once a mail server exists or GitHub is
   the only way to sign in). Under "everyone" anybody can create an account (in a single-tenant instance it sees nothing until it is invited);
   choose an email list or allowed domains to limit that. You become an Owner of the default workspace next to the
   Owner the import chose (in multi-tenant mode only if the import left the workspace without one).
2. Open **Admin**. The overview shows a notice you can hide when you have read it: the people who were **not** made
   members and why (their old sessions were ended), the allowed logins that never signed in (**invite them by email**), the allowed GitHub
   organization (**it is not migrated into a rule**: recreate that access as an email list or as allowed domains),
   and anything that could not be imported.
3. **Integrations**: the imported GitHub App is there. Confirm whether it can only be installed on its own account
   (until you do, nothing is attached by itself; installations that were linked before the update keep their link),
   press **Check permissions** and add the two permissions it lacks if it does (Email addresses: read-only, Members:
   read-only), and enter the **client id and client secret of the GitHub App** (its user authorization; the callback
   address to register is shown). The OAuth app of the earlier sign in is not imported and not needed: the import emptied the user tokens it had
   issued (they are no longer stored), and you can **delete that OAuth app on GitHub** (Settings, Developer settings,
   OAuth Apps), which also revokes the tokens it issued.
4. **Setup, ways to sign in**: switch on sign in with GitHub. People who used GitHub before sign in with it, are
   recognised by their numeric GitHub id and are members of the default workspace if they were admitted. Their
   temporary address is replaced by their verified GitHub address at their next sign in. Until you switch it on,
   sign in is by email and password (you).
5. If you were one of those people and are now also the admin: link your GitHub identity from the admin account
   (Integrations, your GitHub account); the two accounts merge, and you can then make GitHub the only way to sign in.

**What changes for people.** Sign in is by email and password until you switch GitHub on, then by GitHub as before.
People who would have been blocked by the earlier allow list are not members. Organization members who never signed
in cannot sign up on their own until you recreate the access.

**After the setup: which variables can be removed.** Remove `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`,
`ALLOWED_GITHUB_LOGINS`, `ALLOWED_GITHUB_ORG`, `LLM_PROVIDER`, `LLM_API_KEY` and, once `APP_SECRET` has its value,
`BETTER_AUTH_SECRET`. Keep `BETTER_AUTH_URL`, `APP_SECRET`, `RUNNER_TOKEN` and the operational settings
(`BACKUP_TIME`, `RUNNER_*`, `LLM_MODEL`, `LLM_MAX_TOKENS`). Save, redeploy, and check that
the log no longer says `LEGACY_VARIABLES_IGNORED`, that nothing asks for a setup code, and that a test pull request
is reviewed. An old variable that stays does no harm (it is ignored), but the secrets in it are then stored in two
places.

**A rollback does not undo database changes.** A version that applied a database migration leaves a
database that the older version cannot open: it stops at start with a `MIGRATION_FAILED` error
("corrupted migrations: previously executed migration ... is missing"). If that happens, restore the
backup you made before the update ([section 8](#8-storage-and-backups)), then start the older version. Data
written since that backup is lost.

### Removing comment commands

A release can remove `/ask`, `/improve` and `/describe`; only `/review` and the automatic review remain.
Update **app first, runner second**, and do not run an old app producer next to the new app:

1. **Stop the old app producers** (or pause webhook deliveries and manual starts): an old app still queues
   removed commands that the new queue will not run.
2. **Deploy the new app and let it become healthy.** Its migration cancels every *waiting* job of a removed
   command (`cancelled`, error code `command_removed`); the id, command, arguments, attempts and any result
   stay, and finished runs remain readable.
3. **Replace the runners.** A runner that already holds a claimed job may finish it under its lease
   (heartbeats and the completion envelope are unchanged). A removed command that reaches a new runner fails
   with `invalid_command` and is reported, so the job finishes instead of being stranded.

The runner API stays version 1: a new runner accepts every review payload the previous release sends (the
legacy `/ask` arguments and the removed tools' option families are ignored, never passed to PR-Agent).
Running an old app producer alongside the new app is unsupported.

**Rollback.** A cancelled job stays cancelled: the previous version neither resurrects it nor retries a
removed command. Stored `allowedCommands` that named removed commands were normalized once (for example
`["ask"]` became `[]`, never `["review"]`); a downgrade does not restore them, so review can stay switched
off until an admin turns it back on in the project settings.

## 12. First-run checklist

Do this once with the whole team in the room; it is the acceptance test of the deployment.

- [ ] **The first-run setup is done** ([section 7](#the-first-run-setup)): the admin account exists, and
      `https://<domain>/setup` answers 404 afterwards.
- [ ] `docker/smoke/instance.sh https://<domain>` passes ([section 7](#7-deploy-and-check-the-instance), step 4).
- [ ] **Sign in.** The admin signs out and in again with email and password. If GitHub sign in is set up, a
      team member opens `https://<domain>` and signs in with GitHub. A GitHub account that is
      not on the list is turned away ("Your GitHub account is not allowed to use this Code Reviewer
      instance.") and sees no project or run data.
- [ ] **Install the GitHub App** on a team repository and connect it ([`github-app.md`](github-app.md), "Install the App"): an Owner or
      Admin of the workspace presses **Connect GitHub** on the Connections page. The `installation` delivery shows 202
      under *Recent Deliveries*, and the repository appears in the app.
- [ ] **Activate the repository as a project.** Repositories are inactive until someone activates them. Open
      the **Projects** page of the app, press **Sync from GitHub** (the button is for Owners and Admins of the workspace) if the repository is missing, and switch the
      repository on. (For scripts, the API call described in
      [`app/src/projects/README.md`](../app/src/projects/README.md) does the same and needs a signed-in session.)
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
| The page asks for a setup code | The instance is not set up yet ([section 7](#the-first-run-setup)). Read the code in the `app` log. |
| Sign in says "Too many sign-in attempts" | The email and password sign in allows about 5 attempts per 15 minutes per email address (and 100 per minute for the whole instance). Wait; a correct sign in starts the count again. Someone guessing against the admin address can keep it locked, which only costs them requests. |
| Nobody can sign in as the admin | Run `admin reset-password <email>` in the `app` container ([section 7](#the-first-run-setup)) and open the link it prints. |
| The setup says it is locked, or the code expired | Restart the app in Coolify: it prints a new code ([section 7](#the-first-run-setup)). |
| `app` restarts in a loop, the log has one `[deploy]` or `[auth]` line | A setting is missing or invalid; the line names the variable. Typical: `APP_SECRET` (or `BETTER_AUTH_SECRET`) missing or shorter than 32 characters, `RUNNER_TOKEN` shorter than 32 characters, `BETTER_AUTH_URL` with `http://`. An unusable `GITHUB_APP_PRIVATE_KEY` does not stop the start; the log has a `GITHUB_APP_CONFIG_INVALID` line. |
| The domain shows "No Available Server" or a 404 from the proxy | `app` is not healthy yet, or the domain lacks `:3000` or is attached to the wrong service ([Coolify: troubleshooting](https://coolify.io/docs/applications/builds/docker-compose#troubleshoot-an-unavailable-domain)). |
| No certificate, or a browser warning | DNS does not point to the server yet, or 80 and 443 are closed ([Coolify: Let's Encrypt](https://coolify.io/docs/troubleshoot/dns-and-domains/lets-encrypt-not-working)). |
| GitHub says the callback URL does not match | The GitHub App's callback URL is not exactly `<BETTER_AUTH_URL>/api/auth/callback/github` (the one-click setup registers it; by hand, see [`github-app.md`](github-app.md)). |
| A webhook delivery shows 401 | The webhook secret in the admin portal (or `GITHUB_APP_WEBHOOK_SECRET` of an installation that was not updated) differs from the GitHub App's webhook secret ([`github-app.md`](github-app.md), "Check the webhook"). |
| A webhook delivery shows a timeout, 502 or 503 | The app is unreachable: domain, proxy, health. |
| A run fails with `llm_not_configured` | The workspace of the run has no LLM key, or the saved key cannot be read (an Admin enters it again under Settings, LLM access). An `LLM_API_KEY` in the environment is not a fallback any more: the update imported it once into the default workspace (the update log says `VARIABLE_NOT_IMPORTED` if it could not). |
| The update does not start and the log says `UPDATE_BACKUP_FAILED` or `IMPORT_FAILED` | The update takes a backup first and stops, without touching the database, when it cannot write it: mount the `backups` volume and make it writable, then redeploy ([updating an installation from before accounts](#updating-an-installation-from-before-accounts)). `IMPORT_FAILED` rolled everything back; read the line, fix the cause and start again. |
| Coolify refuses or fails the deployment after the release that added `runner-dynamic`, with an error about `user`, `cap_add`, `read_only`, `tmpfs` or `security_opt` | The Coolify version does not accept a setting of the Dynamic runner. Delete the `runner-dynamic` service from your copy of `compose.coolify.yml` to deploy without it, and report the Coolify version and the error ([Dynamic Review runner](#dynamic-review-runner)). |
| `runner-dynamic` restarts in a loop | Its log says why (`cannot start: ...`); Coolify probably dropped `SETPCAP`. The app and the Diff runner keep working. |
| A build error in the `dynamic` target (the pinned engine cannot be downloaded) | The server cannot reach the download host during the build, or the bytes differ from the pin. The deployment fails; retry, or remove the service from your copy of the file. An arm64 server is **not** a build error: the engine step is skipped there and Dynamic Review is unavailable ([Dynamic Review runner](#dynamic-review-runner)). |
| A Dynamic run fails with `dynamic_model_features_unsupported` | OpenRouter's metadata of the project's model says it has no tool calling or no required tool choice (choose another model), or `RUNNER_DYNAMIC_CAPABILITIES` lacks a feature (it is a ceiling, [section 6](#6-environment-variables)); or the app could not read the metadata and the model is not the default one. |
| The build is killed or the server is unresponsive during a deployment | Not enough memory for the build: more RAM, or a [build server](https://coolify.io/docs/troubleshoot/server/crash-during-build). |

## What is verified

- Automatically, on every pull request: `compose.coolify.yml` is a valid Compose file that builds its
  images (app, runner and the Dynamic runner) from the repository, publishes no port, requires the runner token and the public address and stays in step with `compose.yml`;
  this guide mentions every variable of `.env.example`; its sizing table matches the formula; the smoke
  script `docker/smoke/instance.sh` is tested against fake instances and runs against the Docker Compose
  stack in CI. The update of an installation from before accounts is rehearsed on every pull request that
  builds the images: `docker/smoke/upgrade.sh` starts the image on the database of the previous release with
  the old environment (backup, import, setup code, webhook, restart, removal of the old variables), and
  the journey `app/e2e/upgrade/update-from-previous-release.e2e.ts` adds the real runner and PR-Agent against the
  fakes.
- Automatically, for the Dynamic runner of this file: its `runner-dynamic` service is pinned equal to the one of
  `compose.dynamic.yml` (user, capabilities, `read_only`, tmpfs, limits, no volumes or ports), asks for no new
  variable, and passes `RUNNER_DYNAMIC_CAPABILITIES` through unchanged (`docker/smoke/compose.sh`); the
  runner serves Diff jobs only when its self-check fails (`runner/tests/unit/test_job_loop_advertise.py`);
  the image builds on arm64 without an engine (the engine stage is built emulated in CI).
- **Not yet, and left to the first deployment with the customer:** everything that needs a real Coolify
  instance, a domain, a certificate, GitHub's real deliveries and a real model: that Coolify accepts and
  parses the Compose file as described, the domain and certificate, the persistence across a redeploy, the
  update and rollback paths, the behaviour after a server restart, the real review and the checks that no
  secret appears in a log. The steps and wording of Coolify's screens come from Coolify's documentation, not
  from a run.
- The Docker Compose stack, with the same runner settings as `compose.coolify.yml`, is started in CI by
  `docker/smoke/compose.sh`, including this: the runner's job loop starts and polls the app without a
  failure, and a `docker compose stop` while a review is running (a fake PR-Agent) ends with the runner
  reporting that review as `runner_shutdown` and exiting with status 0, not killed. That the runner
  really reaches GitHub and OpenRouter, and how Coolify itself stops containers, is part of the first
  deployment.
