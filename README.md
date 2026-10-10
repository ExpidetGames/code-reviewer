# Code Reviewer

Automatic code reviews for GitHub pull requests, powered by [PR-Agent](https://github.com/qodo-ai/pr-agent), with a small web UI.

Code Reviewer wraps PR-Agent: it runs PR-Agent against pull requests and adds a web UI for configuring and inspecting reviews.

**Status:** in development.

## Repository layout

| Path         | Content                                       |
| ------------ | --------------------------------------------- |
| `app/`       | Web app and API: Next.js 16, TypeScript, pnpm |
| `runner/`    | Worker that runs PR-Agent: Python, uv         |
| `fakes/`     | Fake servers and fixtures used by the tests   |
| `TESTING.md` | Testing strategy                              |
| `AGENTS.md`  | Rules for agents and contributors             |

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

## Container images

Two images are built from the repository, each with its own Dockerfile and `.dockerignore`:

| Image                                       | Build                                         | Notes                                                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ghcr.io/expidetgames/code-reviewer-app`    | `docker build -t code-reviewer-app app`       | Next.js standalone server on port 3000, runs as uid 10001. The database lives in the volume `/data` (`DATABASE_PATH=/data/app.db`); it is created and migrated on start. |
| `ghcr.io/expidetgames/code-reviewer-runner` | `docker build -t code-reviewer-runner runner` | Python (version of `runner/.python-version`) with the runner installed by uv from `uv.lock`, runs as uid 10001. PR-Agent is added with its own ticket.                   |

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
`development` or `latest`. The packages must be public (set once in the GitHub package settings,
see the pull request of the image ticket); pulling needs no login then.

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

## Branching

- `main` and `development` are permanent branches. `development` is the default branch.
- Epic branches start with the epic's ticket key and branch off `development`, e.g. `CR-2-foundation`.
- Ticket branches start with the ticket key and branch off their epic branch, e.g. `CR-14-repo-skeleton`.

Pull requests flow upwards:

1. Ticket branch -> PR into its epic branch.
2. Epic branch -> PR into `development`.
3. `development` -> PR into `main` for releases.

Direct pushes to `main` and `development` are not allowed; all changes go through pull requests.
