# Code Reviewer

Automatic code reviews for GitHub pull requests, powered by [PR-Agent](https://github.com/qodo-ai/pr-agent), with a small web UI.

Code Reviewer wraps PR-Agent: it runs PR-Agent against pull requests and adds a web UI for configuring and inspecting reviews.

**Status:** in development.

## Repository layout

| Path | Content |
|---|---|
| `app/` | Web app and API: Next.js 16, TypeScript, pnpm |
| `runner/` | Worker that runs PR-Agent: Python, uv |
| `compose.yml` | The whole stack on one machine (app and runner), see "Run with Docker Compose" |
| `compose.coolify.yml` | The same stack for Coolify (built from the repository, no published port), see "Deploy on Coolify" |
| `docs/` | Guides for operators: [`docs/deployment-coolify.md`](docs/deployment-coolify.md) (deploying on Coolify), [`docs/github-app.md`](docs/github-app.md) (creating and installing the team's GitHub App) |
| `docs/decisions/` | Architecture decision records, see [`docs/decisions/README.md`](docs/decisions/README.md) |
| `fakes/` | Fake servers and fixtures used by the tests |
| `TESTING.md` | Testing strategy |
| `AGENTS.md` | Rules for agents and contributors |

## Prerequisites

- Node.js 24 or newer (`.nvmrc`) with [pnpm](https://pnpm.io) 10 (`corepack enable` is enough)
- [uv](https://docs.astral.sh/uv/) 0.5 or newer. It downloads the Python version pinned in
  `runner/.python-version` if needed.
- `make`

## Setup

```sh
make install
```

This runs `pnpm --dir app install --frozen-lockfile` and `uv --directory runner sync --locked`.

## Run the app locally

```sh
cd app
pnpm dev          # http://localhost:3000, needs the sign in settings below
```

Agents and parallel worktrees must not use ports 3000 or 3100 (see `AGENTS.md`); start the dev
server on your own port instead: `pnpm dev --port 3417`.

Production build:

```sh
cd app
pnpm build
pnpm start
```

The app keeps its data in a SQLite file. Copy `app/.env.example` to `app/.env.local` and create the
directory it points to (`mkdir data` in the repository root for the example value). The file is
created and migrated when the server starts; a missing directory stops the start with a clear
message. Settings and the database layer are described in `app/.env.example` and
`app/src/db/README.md`.

### First start and sign in

Every page except the login page needs a session. The server refuses to start until two settings in
`app/.env.example` are set: a random `APP_SECRET` (the master key of the instance, at least 32
characters, `openssl rand -base64 32`; its deprecated name `BETTER_AUTH_SECRET` is still accepted) and
the address of the app in `BETTER_AUTH_URL`. No GitHub setting is needed to start.

A new instance is set up in the browser. While it is not set up, every start of the app prints a fresh
6-digit **setup code** in its log (`[setup] Setup code: ...`); everything but `/api/health` waits for the
setup. Open the app, enter the code, and answer three questions: single-tenant or multi-tenant, who may
sign up (everyone, a list of emails, or allowed email domains), and the email and password of the
instance admin (12 to 128 characters, not a common password). You land in `/admin`, signed in; the
setup page is gone afterwards. The code is valid for 60 minutes, works once, and after 10 wrong codes
the setup locks until the app is restarted (which prints a new code); the code lives in the memory of
one process, so do the setup with one app instance. An installation from before the setup existed keeps
its data, and its settings are imported once ([Updating from a version before
accounts](#updating-from-a-version-before-accounts)): only the web UI waits, webhooks and the runner API keep
working. How it works: `app/src/setup/README.md`.

The admin portal at `/admin` (instance admin only; everybody else gets a 404) holds the settings of the
instance: tenancy, sign-up rule, the ways to sign in and the limits, with who changed what and when.
Credentials (the GitHub App, the mail server password) are stored encrypted with a key derived from `APP_SECRET`. **A lost admin password** without
a mail server: `docker compose exec app admin reset-password <email>` prints a single-use link valid for 30
minutes. Details: `app/src/admin/README.md`.

**Signing up.** `/sign-up` creates an account with an email address and a password when the sign-up rule
lets the address in. With a mail server (set up in the admin portal under Mail: SMTP host, port, STARTTLS or TLS, login, sender; the password is stored encrypted and never shown; a test mail button tells why it fails) every email and
password account has to confirm its address with a link before it can sign in or act (the admin keeps
`/admin` meanwhile); without one nothing can be confirmed, and the rule "everyone" works at once. A rule
that names emails or domains stays closed until addresses can be verified. A new account belongs to no
workspace and sees no data: in a single-tenant instance the person asks an admin for an invitation. How it
works: `app/src/signup/README.md`.

Signing in with email and password always exists (the admin). "Sign in with GitHub" exists while the
GitHub App has its user authorization configured: the same App that reviews pull requests signs people in,
and it is created with one click in the admin portal (Integrations) or entered by hand; there is no
separate OAuth app and no environment variable. The sign-up rule is applied to the **verified primary email
address** GitHub reports; a GitHub account is matched by its numeric id; an address alone never joins two
accounts. A person who is signed in can link their GitHub account from their account page, and the
instance admin can link the GitHub account of an operator who was imported from an earlier version, which
merges the two accounts. How it works: `app/src/auth/README.md`, `app/src/github-config/README.md` and
`app/src/github-signin/README.md`.

### LLM access

Every workspace brings its own LLM key (bring your own key): an Admin or an Owner enters it under
**Settings, LLM access** of the workspace (provider OpenRouter, a write-only key, a "Test key" button). The key is
stored encrypted in the database (with `APP_SECRET`; the operator of the instance holds that key and can technically
decrypt it), never shown again, never logged, and reviews of a workspace use the key of that workspace only. A
workspace without a key fails its reviews with `llm_not_configured` and shows "LLM not configured" with a link to
the form. The default model is `anthropic/claude-haiku-5.5` (the model is a review setting).

The legacy variables `LLM_PROVIDER` and `LLM_API_KEY` are not read any more: the update of an existing installation
imports them once into the default workspace's key and ignores them afterwards. `LLM_MODEL` and `LLM_MAX_TOKENS`
(see `app/.env.example`) stay instance settings. How it works: `app/src/llm/README.md`.

### GitHub App

Reading pull requests, posting reviews and signing people in needs one GitHub App of the team. In the admin
portal, under **Integrations**, one click creates it (the manifest flow: GitHub asks you to confirm, and
the credentials come back to the portal by themselves), or you enter its values by hand;
[`docs/github-app.md`](docs/github-app.md) describes both, the permissions and events, how to keep the
private key safe and how to install the app on the repositories. The App id, slug, private key, webhook
secret, client id and client secret are stored encrypted in the database and never shown again; no
environment variable is needed, and a replaced webhook secret counts from the next delivery on every
instance. Without an App GitHub is "not configured" and no review can run. An installation from before
accounts that still has `GITHUB_APP_*` variables has them imported once by the update.

## Updating from a version before accounts

An installation that ran the release before accounts (the GitHub OAuth app and the allow list, `GITHUB_APP_*` and
`LLM_*` in the environment, `BETTER_AUTH_SECRET`, users who signed in with GitHub) updates without losing anything
and needs the operator **once**, for a short setup. The decision is in
[`docs/decisions/0001-editions-setup-and-accounts.md`](docs/decisions/0001-editions-setup-and-accounts.md),
section 2.11; the step by step guide for Coolify is "Updating an installation from before accounts" in
[`docs/deployment-coolify.md`](docs/deployment-coolify.md); how it works is in
[`app/src/legacy-import/README.md`](app/src/legacy-import/README.md).

1. **Back up, and keep the master key.** Add `APP_SECRET` with exactly the value of `BETTER_AUTH_SECRET` (the old
   name keeps working while `APP_SECRET` is empty; two different values sign everybody out and make the stored
   GitHub tokens unreadable) and keep a copy of it **apart from the database backups**. The update takes a backup of
   the SQLite file itself before it touches it (a file `code-reviewer-before-update-<time>.db` in the backup
   directory, which the daily rotation never deletes) and does not start if that fails (the `backups` volume must be
   mounted and writable). Only one is taken: a restart after a failed import takes none.
2. **Start the new version with the environment you have.** On the first start the app backs up the database,
   migrates it and imports, in one transaction: one default workspace holds all the data; the GitHub App and the
   LLM key move into the encrypted store (the LLM key becomes the default workspace's key); the people who pass the
   allow list **at that moment** become members (a listed login whose GitHub id is bound to the account, or, with
   `ALLOWED_GITHUB_ORG`, a live check of the organization with the person's own stored token), the first of them
   to have signed in becomes the Owner. If the import fails it changes nothing and the start ends with one line;
   fix the cause and start again (no second backup is taken). The log names every variable that is ignored from then on, never a value.
   Reviews are never interrupted: webhooks and the runner API serve the imported settings meanwhile.
3. **Do the short setup.** Read `[setup] Setup code: ...` in the log of the app, open the app, enter the code and
   answer three questions (single or multi-tenant, who may sign up, your admin account; for an update the
   wizard starts on "a list of email addresses", not "everyone"). **The allow list is not
   turned into a sign-up rule and the organization is not migrated**: the admin portal lists who was not made a
   member, the allowed logins that never signed in (invite them by email) and the organization (recreate that
   access as an email list or as allowed domains).
4. **Enable sign in with GitHub** in the admin portal (Integrations: the client id and secret of the GitHub App, the
   callback address is shown; confirm whether the App can only be installed on its own account). Until then sign in
   is by email and password. People who used GitHub before are recognised by their numeric GitHub id.
5. **Remove the old variables** (`GITHUB_APP_*`, `GITHUB_OAUTH_*`, `ALLOWED_GITHUB_*`, `LLM_PROVIDER`,
   `LLM_API_KEY`, `BETTER_AUTH_SECRET`) and redeploy.

`make test-images` and CI run `docker/smoke/upgrade.sh` against the image with the database of the previous
release; the browser journey `app/e2e/upgrade/update-from-previous-release.e2e.ts` walks through the same steps with
the real runner and PR-Agent against the fakes.

## Supported browsers

The web UI is built for Tailwind CSS v4's browsers: Chrome and Edge 111 or newer, Firefox 128 or
newer and Safari 16.4 or newer. The color tokens are plain custom properties per mode in
`theme.css` (no `light-dark()`), and the stylesheets use `color-mix()` and `:has()` without a
fallback, so an older browser shows the page without its colors; there is no polyfill on purpose (a
team tool, always up to date browsers). The navigation menu on narrow screens and the user menu
need JavaScript; the sign in, the sign out and the three places themselves are plain links and
forms.

## Run the runner locally

```sh
cd runner
uv run code-reviewer-runner --version
```

### Run one PR-Agent job

`code-reviewer-run-job` runs one PR-Agent command (`review`, `improve`, `describe` or `ask`) for one
pull request. The job is JSON on stdin (`runner/src/code_reviewer_runner/job.py` documents the
shape: pull request URL, command, installation token and bot login, LLM model and key). The result
is exactly one line of JSON on stdout (`ok`, `durationMs`, `commentUrl`, `errorCode`, `logTail`,
`logTruncated`, `usage`), and the exit code is 0 for `ok` and 1 otherwise. PR-Agent is pinned to one version
(`runner/pyproject.toml`); the runner patches the identity lookup of that exact version, so a
PR-Agent upgrade needs a conscious change of both (see `runner/src/code_reviewer_runner/identity_patch.py`).

```sh
echo '{}' | uv run code-reviewer-run-job     # an invalid job: {"ok":false,"errorCode":"invalid_job",...}
```

A real run against the sandbox repository (posts a real comment, costs a few cents; needs the App
credentials and an OpenRouter key in the environment, see the docstring of the script):

```sh
cd runner
uv run python scripts/manual_review.py
```

## Container images

Two images are built from the repository, each with its own Dockerfile and `Dockerfile.dockerignore`
(a root `.dockerignore` lists the same exclusions for the classic builder, which only reads that
file; both builders produce working images).
The build context is the repository root (the images also carry `LICENSE`, `NOTICE` and
`THIRD_PARTY_LICENSES.md` from there, in `/licenses`), so the Dockerfile is named with `--file`:

| Image | Build | Notes |
|---|---|---|
| `ghcr.io/expidetgames/code-reviewer-app` | `docker build -f app/Dockerfile -t code-reviewer-app .` | Next.js standalone server on port 3000, runs as uid 10001. The database lives in the volume `/data` (`DATABASE_PATH=/data/app.db`); it is created and migrated on start. |
| `ghcr.io/expidetgames/code-reviewer-runner` | `docker build -f runner/Dockerfile -t code-reviewer-runner .` | Python (version of `runner/.python-version`) with the runner installed by uv from `uv.lock`, runs as uid 10001. Holds PR-Agent (pinned, from `uv.lock`) and its tiktoken encodings, so a job needs no download besides GitHub and the LLM. |

```sh
docker run --rm -p 3000:3000 -v code-reviewer-data:/data \
  -e APP_SECRET=... -e BETTER_AUTH_URL=http://localhost:3000 \
  -e RUNNER_TOKEN=... code-reviewer-app
docker run --rm code-reviewer-runner --version
```

A named volume is owned by the container user on first use. A bind mount (`-v ./data:/data`) must be
writable for uid 10001. `make test-images` builds both images and runs their smoke tests
(`docker/smoke/`).

CI builds and smoke tests both images on pull requests. A push to `development` or `main`
(`.github/workflows/publish-images.yml`) pushes them to GHCR with the tags `sha-<short commit>` and
`development` or `latest`. The packages stay private: pulling needs `docker login ghcr.io` with a token
that may read packages. The Coolify deployment does not pull them: Coolify builds the images from the
repository (reasons in [`docs/deployment-coolify.md`](docs/deployment-coolify.md)).

## Run with Docker Compose

`compose.yml` runs the whole system on one machine: the `app` (port 3000, SQLite database in the named
volume `data` at `/data`) and the `runner` (no published port, talks to `http://app:3000`). The runner
starts only after the app reports healthy; both restart unless stopped on purpose.

```sh
cp .env.example .env      # then fill in the values, see the comments in the file
docker compose up -d --wait
docker compose ps         # app: healthy, runner: running
```

Open `http://localhost:3000`: a new instance asks for the **setup code**, which the app printed in its log
(`docker compose logs app`); see "First start and sign in". Which values you need and where to get them:

| Setting | Where it comes from |
|---|---|
| `APP_SECRET` | Required. Random, at least 32 characters: `openssl rand -base64 32`. Keep a copy apart from the database backups: a database restored without it loses every stored credential. An existing `BETTER_AUTH_SECRET` is accepted in its place |
| `RUNNER_TOKEN` | Required. Random, at least 32 characters: `openssl rand -hex 32` (the app and the runner share it) |
| `BETTER_AUTH_URL` | The address people use, https beyond localhost (a local try-out needs nothing) |
| The GitHub App | Not an environment variable: create it in the admin portal under Integrations ([docs/github-app.md](docs/github-app.md): one click, or by hand). `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_WEBHOOK_SECRET` and `GITHUB_APP_PRIVATE_KEY` of an installation from before accounts are imported once by the update and ignored afterwards ([Updating from a version before accounts](#updating-from-a-version-before-accounts)); `GITHUB_OAUTH_*` are no longer used |
| `LLM_API_KEY` (and `LLM_PROVIDER`) | Legacy, optional: an installation from before accounts has its key imported once into the default workspace by the update. The key is normally entered per workspace in the UI (Settings, LLM access) |

`RUNNER_TOKEN` empty stops `docker compose up` with a message naming the variable, before any container
is created. The production app refuses to start without `APP_SECRET` (or `BETTER_AUTH_SECRET`) and
without `RUNNER_TOKEN` (at least 32 characters): one line in the log naming the variables, never their
values. No `GITHUB_*` variable is required. On a new instance the old `GITHUB_APP_*`, `ALLOWED_GITHUB_*`
and `LLM_*` variables are ignored (one line in the log says so), and GitHub stays "not configured" until the App
is entered in the admin portal.

Compose only catches *empty* values. A value that is set but invalid passes compose and is rejected by
the app, which exits with one `[auth]` or `[deploy]` line (for example a missing `APP_SECRET`, a
`RUNNER_TOKEN` shorter than 32 characters, or a `BETTER_AUTH_URL` that is plain http on anything but localhost: https is mandatory
beyond localhost). Because of `restart: unless-stopped` that looks like a restart loop and the runner
never starts: run `docker compose logs app` and read the last lines.

**Images.** By default compose pulls `ghcr.io/expidetgames/code-reviewer-app:development` and
`...-runner:development` (change them with `APP_IMAGE` and `RUNNER_IMAGE`, for example to a
`sha-<short commit>` tag). The packages are private, so run `docker login ghcr.io` first with a token
that may read packages. To build from this checkout instead:

```sh
docker compose -f compose.yml -f compose.build.yml up -d --build --wait
```

**Data.** The database survives `docker compose down` and image updates (`docker compose pull && docker
compose up -d`). Only `docker compose down -v` deletes it. The database runs in WAL mode, so
never copy only `app.db` from a running stack: committed data can still sit in `app.db-wal`. The app
backs the database up itself every day into the volume `backups` (7 daily and 4 weekly backups); how it
works, how to restore and how to get the backups off the machine is in
[`app/src/backup/README.md`](app/src/backup/README.md).

**Network.** The app is published on `127.0.0.1` only. Set `APP_BIND_ADDRESS=0.0.0.0` (and
`APP_PORT`, and `BETTER_AUTH_URL` to the address people use) to reach it from elsewhere. That address
must be https, so put a reverse proxy with TLS in front. An IPv6 address needs brackets, for example
`APP_BIND_ADDRESS=[::1]`.

**Restarts.** `restart: unless-stopped` brings a crashed container back. A container you stop yourself
(`docker stop`, `docker kill`, `docker compose stop`) stays stopped until the next `up`: that is what
the policy means.

**Runner.** The runner container runs the job loop of the image (`runner/README.md`, "The job loop"): it
asks the app for work, runs up to `RUNNER_CONCURRENCY` reviews at once (default 3, for the 2 GiB the
container may use) and logs `runner ... started` at start; `docker compose logs runner` shows it, and a
warning with `trying again` whenever the app cannot be reached or refuses its token. `RUNNER_CONCURRENCY`,
`RUNNER_JOB_TIMEOUT_SECONDS`, `RUNNER_POLL_INTERVAL_SECONDS` and `RUNNER_ID` are optional settings in
`.env`. `docker compose stop` (and an update) gives running reviews up to 60 seconds to finish and
waits for the runner to report the rest (`stop_grace_period: 90s`), so do not stop it with `kill`.
The runner needs to reach only `api.github.com`, `openrouter.ai` and the app; how to restrict it to
those is in [docs/deployment-coolify.md](docs/deployment-coolify.md), section 9.

`make test-compose` builds both images and runs `docker/smoke/compose.sh` against them with dummy
settings: validation of the settings, no runner before a healthy app, the stack comes up, the data
survives `down` and `up`, an app process that exits by itself is restarted, a backup restores, and a
`docker compose stop` while a (fake) review runs ends with the runner reporting that review. CI runs the same script for pull requests.

## Deploy on Coolify

[`docs/deployment-coolify.md`](docs/deployment-coolify.md) is the step by step guide for the team's
server: the Coolify resource type, the domain and TLS, every environment variable and where its value
comes from, the first-run setup with the setup code, storage and backups ([`app/src/backup/README.md`](app/src/backup/README.md)), runner sizing,
updates and rollback, and a first-run checklist. Coolify builds the images from this repository with the
Compose file `compose.coolify.yml`. `docker/smoke/instance.sh <base-url>` checks a running instance (health,
login page, webhook and runner API refuse what they must).

## Lint, typecheck, test

One command per task from the repository root, covering both parts:

```sh
make lint              # app: eslint and prettier --check; runner: ruff check and ruff format --check
make typecheck         # app: next typegen and tsc --noEmit (strict); runner: pyright (strict)
make test-unit         # app: vitest unit project; runner: pytest -m unit
make test-integration  # integration tests that need no Docker stack
make verify            # all of the above, run before every pull request
```

Or per part:

|             | App (`cd app`)                                            | Runner (`cd runner`)                                                       |
| ----------- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| Lint        | `pnpm lint` and `pnpm format:check` (`pnpm format` fixes) | `uv run ruff check . ../fakes` and `uv run ruff format --check . ../fakes` |
| Typecheck   | `pnpm typecheck`                                          | `uv run pyright`                                                           |
| Unit tests  | `pnpm test`                                               | `uv run pytest -m unit`                                                    |
| Integration | `pnpm test:int`                                           | `uv run pytest -m "integration or contract"`                               |

End-to-end tests run against a production build on port 3417 (`E2E_PORT`), next to a fake GitHub on
a random port (`fakes/github`):

```sh
make test-e2e                              # needs a Playwright browser:
                                           #   cd app && pnpm exec playwright install chromium
make test-e2e PLAYWRIGHT_CHANNEL=chrome   # or use an installed Google Chrome
```

The journey with the real runner and PR-Agent (`app/e2e/jobs`) also needs the runner installed
(`make install`) and the tiktoken encoding cached once per machine
(`uv --directory runner run python scripts/prime_tiktoken_cache.py`, needs the internet); it fails
at the start and says so when one is missing.

All automated tests are hermetic: a network guard blocks every host except loopback. See
[TESTING.md](TESTING.md) for the test levels, naming rules and fakes.

### Troubleshooting

- `pyenv: version '3.13' is not installed` when running `uv`: a pyenv shim named `uv` is found
  first and trips over `runner/.python-version`. Put the real uv (for example `~/.local/bin`) before
  `~/.pyenv/shims` in your `PATH`, or install the Python version with pyenv.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow (branch names, commit messages,
pull requests, which checks to run) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report security
problems privately as described in [SECURITY.md](SECURITY.md).

## Branching

- `main` and `development` are permanent branches. `development` is the default branch.
- Every change starts from a GitHub issue `#<n>`. Its branch is named `<n>-<slug>` and branches off
  `development`, e.g. `123-fix-webhook-retry`.
- A pull request goes into `development`, its description contains `Closes #<n>`, and it is squash
  merged once the review is done and CI is green.
- `development` -> PR into `main` for releases.

Direct pushes to `main` and `development` are not allowed; all changes go through pull requests.
[CONTRIBUTING.md](CONTRIBUTING.md) has the full workflow.

## License

code-review.com is licensed under the [Apache License, Version 2.0](LICENSE). [`NOTICE`](NOTICE)
and [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) carry the attribution for third party
software, including the MIT licensed PR-Agent.
