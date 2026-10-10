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
| `docs/` | Guides for operators, for example [`docs/github-app.md`](docs/github-app.md): creating and installing the team's GitHub App |
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

## Run the runner locally

```sh
cd runner
uv run code-reviewer-runner --version
```

## Container images

Two images are built from the repository, each with its own Dockerfile and `.dockerignore`:

| Image | Build | Notes |
|---|---|---|
| `ghcr.io/expidetgames/code-reviewer-app` | `docker build -t code-reviewer-app app` | Next.js standalone server on port 3000, runs as uid 10001. The database lives in the volume `/data` (`DATABASE_PATH=/data/app.db`); it is created and migrated on start. |
| `ghcr.io/expidetgames/code-reviewer-runner` | `docker build -t code-reviewer-runner runner` | Python (version of `runner/.python-version`) with the runner installed by uv from `uv.lock`, runs as uid 10001. PR-Agent is added with its own ticket. |

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
that may read packages. How the deployment server gets access is decided with the deployment ticket.

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
| `BETTER_AUTH_SECRET`, `RUNNER_TOKEN` | Random, at least 32 characters: `openssl rand -base64 32` (one each) |
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
never copy only `app.db` from a running stack: committed data can still sit in `app.db-wal`. Back it
up with SQLite's online backup (`VACUUM INTO` or the `.backup` command of the `sqlite3` shell), or
stop the stack with `docker compose stop` and copy `app.db`, `app.db-wal` and `app.db-shm` together.
CR-40 automates the backup.

**Network.** The app is published on `127.0.0.1` only. Set `APP_BIND_ADDRESS=0.0.0.0` (and
`APP_PORT`, and `BETTER_AUTH_URL` to the address people use) to reach it from elsewhere. That address
must be https, so put a reverse proxy with TLS in front. An IPv6 address needs brackets, for example
`APP_BIND_ADDRESS=[::1]`.

**Restarts.** `restart: unless-stopped` brings a crashed container back. A container you stop yourself
(`docker stop`, `docker kill`, `docker compose stop`) stays stopped until the next `up`: that is what
the policy means.

**Runner.** The job loop does not exist yet (CR-29). Until then the runner container runs a clearly
marked placeholder that keeps it up and logs `connected to http://app:3000` (and `cannot reach ...` if
the app is down); `docker compose logs runner` shows it.

`make test-compose` builds both images and runs `docker/smoke/compose.sh` against them with dummy
settings: validation of the settings, no runner before a healthy app, the stack comes up, the data
survives `down` and `up`, an app process that exits by itself is restarted. CI runs the same script for pull requests.

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

| | App (`cd app`) | Runner (`cd runner`) |
|---|---|---|
| Lint | `pnpm lint` and `pnpm format:check` (`pnpm format` fixes) | `uv run ruff check .` and `uv run ruff format --check .` |
| Typecheck | `pnpm typecheck` | `uv run pyright` |
| Unit tests | `pnpm test` | `uv run pytest -m unit` |
| Integration | `pnpm test:int` | `uv run pytest -m "integration or contract"` |

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

## Branching

- `main` and `development` are permanent branches. `development` is the default branch.
- Epic branches start with the epic's ticket key and branch off `development`, e.g. `CR-2-foundation`.
- Ticket branches start with the ticket key and branch off their epic branch, e.g. `CR-14-repo-skeleton`.

Pull requests flow upwards:

1. Ticket branch -> PR into its epic branch.
2. Epic branch -> PR into `development`.
3. `development` -> PR into `main` for releases.

Direct pushes to `main` and `development` are not allowed; all changes go through pull requests.
