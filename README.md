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

### Sign in

Every page except the login page needs a session, and GitHub is the only way to get one. The server
refuses to start until the four sign in settings in `app/.env.example` are set: a random
`BETTER_AUTH_SECRET`, the address of the app in `BETTER_AUTH_URL`, and the client id and secret of
a GitHub OAuth app of your own (GitHub > Settings > Developer settings > OAuth Apps). Register
`<BETTER_AUTH_URL>/api/auth/callback/github` as its "Authorization callback URL".

Signing in is limited to people you name: set `ALLOWED_GITHUB_LOGINS` (comma separated GitHub
logins) and/or `ALLOWED_GITHUB_ORG` (members of one GitHub organization). If both are set, either
is enough. If neither is set, nobody can sign in; the server starts and logs one warning. A login
removed from the list loses access on the next request (after a restart with the new value);
organization membership is checked at sign in and again every 24 hours.
How it works: `app/src/auth/README.md`.

### LLM access

One shared LLM account serves the whole instance: set `LLM_PROVIDER=openrouter` and `LLM_API_KEY`
(optionally `LLM_MODEL`, `LLM_MAX_TOKENS`) as environment variables, see `app/.env.example`. Without
them the app still starts and shows a configuration error; every job then fails with
`llm_not_configured`. The default model is `anthropic/claude-haiku-5.5`. The key is never logged, stored or shown. How it works: `app/src/llm/README.md`.

### GitHub App

Reading pull requests and posting reviews needs a GitHub App of the team (webhook, four repository
permissions, two events). [`docs/github-app.md`](docs/github-app.md) creates it step by step, says
which value goes into which variable (`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_WEBHOOK_SECRET`,
`GITHUB_APP_PRIVATE_KEY`), how to keep the private key safe and how to install the app on the
repositories. The production server refuses to start without these four settings; `pnpm dev` does not.

## Supported browsers

The web UI is built for current Chrome and Edge (123 or newer), Firefox (120 or newer) and Safari
17.5 or newer. The color tokens use `light-dark()` and `color-mix()` without a fallback, so an older
browser shows the page without its colors; there is no polyfill on purpose (a team tool, always
up to date browsers). The navigation menu on narrow screens and the user menu need JavaScript; the
sign in, the sign out and the three places themselves are plain links and forms.

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

Two images are built from the repository, each with its own Dockerfile and `.dockerignore`:

| Image | Build | Notes |
|---|---|---|
| `ghcr.io/expidetgames/code-reviewer-app` | `docker build -t code-reviewer-app app` | Next.js standalone server on port 3000, runs as uid 10001. The database lives in the volume `/data` (`DATABASE_PATH=/data/app.db`); it is created and migrated on start. |
| `ghcr.io/expidetgames/code-reviewer-runner` | `docker build -t code-reviewer-runner runner` | Python (version of `runner/.python-version`) with the runner installed by uv from `uv.lock`, runs as uid 10001. Holds PR-Agent (pinned, from `uv.lock`) and its tiktoken encodings, so a job needs no download besides GitHub and the LLM. |

```sh
docker run --rm -p 3000:3000 -v code-reviewer-data:/data \
  -e BETTER_AUTH_SECRET=... -e BETTER_AUTH_URL=http://localhost:3000 \
  -e GITHUB_OAUTH_CLIENT_ID=... -e GITHUB_OAUTH_CLIENT_SECRET=... \
  -e ALLOWED_GITHUB_LOGINS=octocat,hubot code-reviewer-app
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

Open `http://localhost:3000`: it shows the login page. Which values you need and where to get them:

| Setting | Where it comes from |
|---|---|
| `BETTER_AUTH_SECRET` | Random, at least 32 characters: `openssl rand -base64 32` |
| `RUNNER_TOKEN` | Random, at least 32 characters: `openssl rand -hex 32` (the app and the runner share it) |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | A GitHub OAuth app of your own; callback URL `<BETTER_AUTH_URL>/api/auth/callback/github` (see "Sign in") |
| `ALLOWED_GITHUB_LOGINS` and/or `ALLOWED_GITHUB_ORG` | Who may sign in; with neither set nobody can |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY` | The GitHub App that reads pull requests and posts reviews: create it once with [docs/github-app.md](docs/github-app.md) (permissions, events, webhook URL, key handling, installation) |
| `LLM_API_KEY` (and `LLM_PROVIDER`) | The LLM access shared by the team. Optional for starting the stack; without it review jobs fail |

A required setting that is empty stops `docker compose up` with a message naming the variable, before
any container is created. The production app also refuses to start without them (one line in the log
naming the variables, never their values): the sign in settings, `RUNNER_TOKEN` (at least 32
characters) and the GitHub App credentials. The development server (`pnpm dev`) does not require the
last two, so the sign in can be tried without a GitHub App.

Compose only catches *empty* values. A value that is set but invalid passes compose and is rejected by
the app, which exits with one `[auth]` or `[deploy]` line (for example a `RUNNER_TOKEN` shorter than 32
characters, or a `BETTER_AUTH_URL` that is plain http on anything but localhost: https is mandatory
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
comes from, storage and backups ([`app/src/backup/README.md`](app/src/backup/README.md)), runner sizing,
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

|             | App (`cd app`)                                            | Runner (`cd runner`)                                     |
| ----------- | --------------------------------------------------------- | -------------------------------------------------------- |
| Lint        | `pnpm lint` and `pnpm format:check` (`pnpm format` fixes) | `uv run ruff check .` and `uv run ruff format --check .` |
| Typecheck   | `pnpm typecheck`                                          | `uv run pyright`                                         |
| Unit tests  | `pnpm test`                                               | `uv run pytest -m unit`                                  |
| Integration | `pnpm test:int`                                           | `uv run pytest -m "integration or contract"`             |

End-to-end tests run against a production build on port 3417 (`E2E_PORT`), next to a fake GitHub on
a random port (`fakes/github`):

```sh
make test-e2e                              # needs a Playwright browser:
                                           #   cd app && pnpm exec playwright install chromium
make test-e2e PLAYWRIGHT_CHANNEL=chrome   # or use an installed Google Chrome
```

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
- Epic branches start with the epic's ticket key and branch off `development`, e.g. `CR-2-foundation`.
- Ticket branches start with the ticket key and branch off their epic branch, e.g. `CR-14-repo-skeleton`.

Pull requests flow upwards:

1. Ticket branch -> PR into its epic branch.
2. Epic branch -> PR into `development`.
3. `development` -> PR into `main` for releases.

Direct pushes to `main` and `development` are not allowed; all changes go through pull requests.
