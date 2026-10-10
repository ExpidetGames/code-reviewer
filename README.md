# Code Reviewer

Automatic code reviews for GitHub pull requests, powered by [PR-Agent](https://github.com/qodo-ai/pr-agent), with a small web UI.

Code Reviewer wraps PR-Agent: it runs PR-Agent against pull requests and adds a web UI for configuring and inspecting reviews.

**Status:** in development.

## Repository layout

| Path | Content |
|---|---|
| `app/` | Web app and API: Next.js 16, TypeScript, pnpm |
| `runner/` | Worker that runs PR-Agent: Python, uv |
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
pnpm dev          # http://localhost:3000, shows an empty start page for now
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
docker run --rm -p 3000:3000 -v code-reviewer-data:/data code-reviewer-app
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

| | App (`cd app`) | Runner (`cd runner`) |
|---|---|---|
| Lint | `pnpm lint` and `pnpm format:check` (`pnpm format` fixes) | `uv run ruff check .` and `uv run ruff format --check .` |
| Typecheck | `pnpm typecheck` | `uv run pyright` |
| Unit tests | `pnpm test` | `uv run pytest -m unit` |
| Integration | `pnpm test:int` | `uv run pytest -m "integration or contract"` |

End-to-end tests run against a production build on port 3417:

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
