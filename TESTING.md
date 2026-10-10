# Testing

This file is the source of truth for how Code Reviewer is tested. A change without the tests it
requires (section 3) is not done. If code and this file disagree, fix one of them in the same PR.

Status markers: "exists" means it works in the repository today; "planned" means a later ticket adds
it. Do not document planned things as if they existed in READMEs or PR descriptions.

## 1. Principles

- Test at the lowest level that can prove the behavior, and prove each behavior at one level only.
- Deterministic: no `sleep` or fixed waits (wait for the condition), time and randomness are
  injected, every test brings its own data.
- No real external service in any automated test: no real GitHub, no real LLM, no internet. External
  systems are replaced by fakes (section 5). Real model runs are manual and never part of CI.
- No silent skip. Which suite runs a file is decided by its location and name, not by a runtime
  check. A suite that needs infrastructure (Docker stack) fails loudly when it is missing, it never
  skips. Known gap until `verify:structure` lands (planned): an app test file outside the Vitest
  project globs (for example `app/integration-tests/x.test.ts` without the `.integration` infix) is
  not run by any project and nothing reports it, so check the suffix rules in section 4 by hand.
  The runner side has no such gap: a pytest file outside `tests/<level>/` is a collection error.
- Never weaken, skip or delete a test to get green. Never raise retries to hide flakiness (the one
  Playwright retry on CI is the accepted baseline, it is not a place to add more). Report flaky
  tests.
- No skipped or focused tests in code: ESLint rejects `.skip` and `.only` tests in
  Vitest files (`vitest/no-disabled-tests`, `vitest/no-focused-tests`) and in Playwright files
  (`playwright/no-skipped-test`, `playwright/no-focused-test`).
- The only quarantine is for e2e journeys: a journey failing twice without a code change gets
  `@flaky` in its title in the same PR that opens a repair ticket (PRs skip tagged journeys with
  `--grep-invert @flaky`, the nightly run still runs them). Unit and integration tests have no
  quarantine: fix at once, or report to the project lead; do not skip.
- Time budget: a PR CI run over 15 minutes, or a smoke run over 5 minutes, is a defect to be fixed
  like a red test.
- No coverage threshold and no coverage command for now. Add both together if the customer asks.
- No secrets in tests, logs or output. Test values are fixed dummies.

## 2. Levels

| Level | Tool | Runs on | What belongs here | Status |
|---|---|---|---|---|
| App unit | Vitest, project `unit` | host | Pure logic: signature verification, event filtering, job state machine, backoff, comment formatting, input validation, React components (a component test starts with `// @vitest-environment jsdom` and uses Testing Library). Collaborators are fakes. No database, no network. | exists |
| App integration | Vitest, project `integration` | host or Docker stack | Real SQLite file plus real Kysely repositories; route handlers driven through the real handler (webhook, runner API, auth) including refusals; GitHub client code against the GitHub fake. | exists (database layer, sign in and access guard against the fake GitHub login, GitHub App client and sync against the GitHub fake, the GitHub App webhook route; runner API handlers planned) |
| Contract | Vitest in `app/integration-tests/compatibility/`, pytest in `runner/tests/contract/` | host | Pins the runner HTTP API and the GitHub webhook payload subset. One machine-readable source in `contracts/` is validated by both sides. | planned |
| Runner unit | pytest, marker `unit` | host | Job loop with a fake clock, heartbeat, lease loss, backoff, shutdown, PR-Agent command and env construction, output parsing, log truncation, secret redaction. Subprocess boundary replaced by a fake. | exists |
| Runner integration | pytest, marker `integration` | host or Docker stack | Real processes and real loopback sockets: the real loop against the app or a fake runner API, with the fake PR-Agent executable as a real subprocess (exit codes, timeouts, kill). | exists (entry point only) |
| Engine smoke | pytest, marker `engine` | Docker stack, nightly and release PRs | The real, pinned PR-Agent against the GitHub fake and the LLM fake. Asserts the shape of what was posted, never review quality. Deselected by default. | marker exists, no tests yet |
| Image smoke | Bash scripts `docker/smoke/app.sh` and `docker/smoke/runner.sh` | Docker daemon (host or CI) | The built container images: the app starts as a non-root user with a fresh volume, turns a visitor without a session away from the start page, answers `/api/health`, creates and migrates the database; the runner answers `--version`; neither image holds env files, git data, keys or secrets. Fails without Docker, never skips. | exists |
| E2E | Playwright, chromium | production build (`next build` and `next start`) next to the fake GitHub, later the Docker stack | User-visible flows. At most about 8 `@smoke` journeys. | exists (start page guard, sign in and sign out, refused account, the app frame: three places, sign out, narrow window) |
| Manual | none | a developer machine | Real PR-Agent against a real model on a sandbox repository before a release. The result goes into the PR description. Never in CI. | n/a |

Unit means no database, no real process and no outside network. The one exception is the network
guard's own tests (app and runner): they open sockets on loopback to prove that loopback stays
reachable while everything else is blocked.

SQLite is a file, so integration tests are cheap and may run on the host. The rule stays: anything
that touches Kysely and a real SQLite file is `*.integration.test.ts`; pure logic never opens a
database.

## 3. Required tests by change type

| Change | Required | Level |
|---|---|---|
| Bug fix | A test that is red before the fix and green after | Lowest level at which the bug shows |
| Logic: state machine, filtering, backoff, formatting | Normal case, edge cases, failure cases | Unit (app or runner) |
| Repository, SQL or transaction (claim, lease) | Against real SQLite, including concurrent claim by two runners | App integration |
| HTTP route, server action, webhook handler | Through the real handler, including refusals: bad signature, missing or wrong token, not signed in, not on the allow list, invalid input | App integration |
| Auth, GitHub App credentials, tokens, anything handling secrets | Same as a route; refusal cases are mandatory; plus a test that secrets do not appear in logs or responses | App integration or runner unit |
| Runner API or webhook payload shape | Contract test on both sides | Contract |
| Runner process handling (spawn, timeout, kill, parallelism) | Real subprocess with the fake PR-Agent | Runner integration |
| New core user flow | One e2e journey; `@smoke` only for a real core path | E2E |
| PR-Agent upgrade, config or prompt change | Engine smoke green; note the PR-Agent version in the PR | Engine smoke |
| Purely visual change | No automated test; the ticket says so explicitly | none |
| Refactor without behavior change | No new test; all existing tests stay green | none |

## 4. Where tests live and how they are named

```
app/                               Next.js project (pnpm)
  src/<owner>/foo.ts               code
  src/<owner>/foo.test.ts          unit test beside the code
  src/<owner>/foo.integration.test.ts   single-owner integration test beside the code
  src/test-support/                shared test setup (network guard, SQLite template and child process helpers, the sign in harness: database, real Better Auth and the fake GitHub); not product code
  src/ci/                          structure tests of the CI and publish workflows and of the Dockerfiles
  integration-tests/               cross-owner integration tests (exists: webhooks/)
    http/ webhooks/ workflows/ compatibility/ support/   closed list; support/ holds no tests
  e2e/<area>/<journey>.e2e.ts      Playwright; areas: app/, auth/, reviews/, jobs/, settings/
  e2e/helpers/                     shared by journeys: ports and dummy credentials, helpers for the fake GitHub
runner/                            Python project (uv)
  src/code_reviewer_runner/        code
  tests/unit/test_<module>.py
  tests/integration/test_<behavior_area>.py
  tests/contract/test_<contract>.py      (planned)
  tests/engine/test_<engine_area>.py     (planned)
fakes/                             shared fake servers and fixtures (see fakes/README.md)
docker/smoke/                      image smoke tests (bash) and their shared helpers
contracts/                         runner API and webhook schemas (planned)
```

- App: unit `*.test.ts(x)`, integration `*.integration.test.ts(x)`, e2e `*.e2e.ts`. E2E files never
  end in `.test.ts`, because Vitest would pick them up.
- Runner: the level of a test is its directory; `tests/conftest.py` applies the marker and rejects a
  test outside the level directories. Files are `test_*.py`.
- New top-level test folders or new `integration-tests/` categories need an agreed change to this
  file first.
- App test titles are plain English behavior sentences ("rejects a delivery whose signature does not
  match the body"): no implementation words and no ticket, ADR or section identifiers. Runner test
  function names are behavior sentences too (`test_a_claimed_job_is_released_when_the_heartbeat_is_rejected`).
  E2E titles are full sentences with tags (`@smoke`, `@flaky`).
- Link a test to its Jira test case with a comment above the test (`// CR-27-T03` or `# CR-27-T03`),
  never in the title.
- Every test file starts with a short comment or docstring: which behavior it pins down and why.
- One behavior per test. Given, when, then is the shape of the body (arrange, act, assert separated by
  blank lines), not keywords in the code.
- Mocks are reset per test (Vitest `clearMocks` and `restoreMocks`; pytest fixtures are
  function-scoped by default). Use `vi.mock` or monkeypatching only for your own collaborators in unit
  tests.

## 5. Fakes and the network guard

Principle: fake at the process boundary with a real server speaking the real protocol, so the
production client code runs unchanged. Test stack values are fixed dummies; no env files, no secrets.

| Dependency | Unit | Integration, e2e |
|---|---|---|
| GitHub REST API and App installation tokens | In-memory implementation of our `GitHubClient` interface | `fakes/github`, one HTTP server for the whole of GitHub (sign in and API); base URL from `GITHUB_API_BASE_URL`; verifies the App JWT; seeded repos, PRs and diffs; assertions read what was posted |
| Git platform behind `IntegrationProvider` (jobs, runner API, UI) | `fakeIntegrationProvider()` in `app/src/test-support/fake-integration-provider.ts`; every provider also runs the shared conformance suite (`integration-provider-conformance.ts`) | Same fake, registered through `createIntegrationRegistry`; see `app/src/integrations/README.md` |
| GitHub webhooks (inbound) | Signature verification as a pure function (HMAC-SHA256) | The fake signs and delivers payloads exactly like GitHub (`X-Hub-Signature-256`, `X-GitHub-Delivery`, `X-GitHub-Event`); fixtures are real payloads reduced to the fields we read |
| GitHub login (OAuth) | n/a | The same `fakes/github` server serves the OAuth authorize, token and user endpoints (exists, see `fakes/github/README.md`); the app is pointed at it with `GITHUB_OAUTH_BASE_URL` and `GITHUB_API_BASE_URL` (both only with `ALLOW_TEST_GITHUB_ENDPOINTS=true`). Exactly one e2e file signs in through the form (`e2e/auth/login.e2e.ts`); all other journeys will use an API shortcut proven equivalent by its own test (not written yet, no other journey needs a session today) |
| LLM providers | Not reachable: runner unit tests never start PR-Agent | `fakes/llm`: OpenAI-compatible `chat/completions` with scripted answers, malformed output, 429, 500 and slow responses; dummy API key |
| PR-Agent | Subprocess boundary behind a small protocol; unit tests use a fake implementation | `PR_AGENT_COMMAND` points at `fakes/pr-agent/fake_pr_agent.py` (succeed, exit 1, hang, print secrets, huge output, crash). Only engine smoke runs the real PR-Agent |
| Runner and app | Fake HTTP client | Real HTTP against the app or an in-process fake runner API checked against `contracts/` |
| Time | Injected clock | Short leases and intervals via env, not sleeping |

Network guard (exists, applies to every automated test):

- App: `app/src/test-support/network-guard.setup.ts` is a Vitest setup file for the `unit` and
  `integration` projects. Any TCP connection (fetch, `http`, `https`, raw `net`) to a host other than
  loopback fails with the error code `NETWORK_GUARD_BLOCKED`. Extra hosts, such as compose service
  names, are allowed with the comma separated `TEST_ALLOWED_HOSTS` variable.
- Runner: pytest runs with `--disable-socket --allow-unix-socket --allow-hosts=127.0.0.1,::1,localhost`
  (pytest-socket), configured in `runner/pyproject.toml`. Connections to other hosts raise
  `SocketConnectBlockedError`. DNS lookups are not blocked, but the connection that would follow is.
- The guard covers the test process only. A subprocess started by a test (for example the fake
  PR-Agent) is not guarded and must itself only talk to loopback fakes.

## 6. Tooling

App (`app/`, Node version from `.nvmrc`, pnpm):

- Vitest with projects `unit` and `integration` in `vitest.config.mts`. Both use the node
  environment, reset mocks per test and load the network guard. `unit`: timeout 10 s. `integration`:
  forks pool, timeout 30 s, hook timeout 60 s. At most 4 workers; override with `TEST_MAX_WORKERS`.
- Playwright (`playwright.config.ts`): `testDir: e2e`, `*.e2e.ts` only, chromium, `forbidOnly` and
  one retry on CI (the accepted baseline, see section 1), trace and screenshot on failure. It builds the app and runs `next start` on
  `E2E_PORT` (default 3417, never 3000 or 3100) so it never touches another running server, with
  `DATABASE_PATH` pointing to a fresh file under `test-results/e2e-data/`. Without a
  downloaded Chromium, run with an installed Chrome: `PLAYWRIGHT_CHANNEL=chrome`. It also starts the fake GitHub (`fakes/github/main.ts`) on a random free-range port (`E2E_GITHUB_PORT` fixes it) and gives the app dummy sign in settings plus `ALLOWED_GITHUB_LOGINS` (the accounts of the journeys, `e2eEnv.allowedLogins`) and `ALLOW_TEST_GITHUB_ENDPOINTS=true`, which the app requires before it accepts another GitHub address; ports and credentials are in `e2e/helpers/e2e-env.ts`.
- ESLint flat config (Next.js core-web-vitals and TypeScript rules, `no-explicit-any` as an error,
  Vitest and Playwright plugin rules against focused and skipped tests), Prettier with its defaults
  (`pnpm format` fixes, `pnpm format:check` verifies) and `tsc --noEmit` with `strict`.

Runner (`runner/`, Python version pinned in `.python-version`, uv, `uv.lock` committed):

- pytest with `--strict-markers`; markers `unit` (default level), `integration`, `contract`, `engine`;
  `engine` is deselected by default, run it with `-m engine`. `pytest-timeout` per level, set in
  `tests/conftest.py` from the test's directory: unit 10 s, integration and contract 60 s, engine
  180 s. `pytest-socket` as described above.
- `ruff check` and `ruff format --check`, `pyright` in strict mode.

Images (`docker/smoke/`, bash): `app.sh <image>` starts the app image with a fresh named volume on
`/data` and dummy sign in settings (without them the server refuses to start), polls `/` until it answers (at most `SMOKE_WAIT_SECONDS`, default 90) and waits for the
container's own health check; it then checks that `/` redirects to `/login` and `/api/health` answers `ok` (the access guard and the database work in the built server), the image user and the uid of PID 1, that the standalone
server runs, that `/data/app.db` exists, belongs to the unprivileged user and holds a recorded
migration, and that the log reports no database error. `runner.sh <image>` checks `--version` against
`runner/pyproject.toml`, the user, a writable `/tmp` and home directory. Both run the secrets scan of
`lib.sh` (no `.env*`, `.git`, key or database files, no private key material, no secret-looking
variable in the image configuration or build history). The private key scan is proven first on files made for it (`docker/smoke/test-key-scan.sh`, also run at the start of every scan): a PEM file, a JSON embedded key, a split, joined or URL encoded key are caught, the harmless `indexOf("-----BEGIN ...")` comparison of a bundled library is not. The scans run as root in a throwaway container and the script stops if a scan itself fails (docker, `find` or `grep` error), so a broken scan can never pass as a clean one; the key content scan covers project-owned paths only, not third-party packages. Containers and volumes are removed on exit,
also after a failure. What is not covered: the real push to GHCR and pulling from the deployment
server (manual, see the PR of the image ticket), and PR-Agent in the runner image (planned with the
PR-Agent ticket: installed version equals the pinned one, a job through the fake PR-Agent).

Planned: `verify:structure` (placement and naming rules, test files must be discovered by a runner,
no process identifiers in titles), `verify:server-only-canary`, the Docker test stack
(`docker/compose.test.yml`), `contracts/`.

## 7. Commands

| Task | Command (repository root) | What it runs |
|---|---|---|
| Install | `make install` | `pnpm --dir app install --frozen-lockfile`, `uv --directory runner sync --locked` |
| Everything before a PR | `make verify` | lint, typecheck, unit and host integration tests of both parts |
| Lint | `make lint` | `pnpm lint`, `pnpm format:check`; `ruff check`, `ruff format --check` |
| Typecheck | `make typecheck` | `pnpm typecheck`; `pyright` |
| Unit tests | `make test-unit` | `pnpm test`; `pytest -m unit` |
| Integration tests (host) | `make test-integration` | `pnpm test:int`; `pytest -m "integration or contract"` |
| E2E | `make test-e2e` | `pnpm test:e2e` (`ARGS="--grep @smoke"` filters) |
| Image smoke tests | `make test-images` | builds both images with `docker build`, then runs `docker/smoke/app.sh` and `docker/smoke/runner.sh` (needs a Docker daemon; not part of `make verify`) |

Inside `app/`: `pnpm dev | build | start | lint | typecheck | test | test:watch | test:int | test:e2e`.
Inside `runner/`: `uv sync --locked`, `uv run ruff check .`, `uv run ruff format --check .`,
`uv run pyright`, `uv run pytest` (default: everything except `engine`), `uv run pytest -m unit`,
`uv run pytest -m "integration or contract"`.

### Integration tests and SQLite

- `src/test-support/db-template.global-setup.ts` (the `integration` project's global setup) creates a
  temporary directory, runs all migrations into one template file and removes it at the end of the run.
- `createAuthHarness()` (`src/test-support/auth-harness.ts`) adds the rest of a sign in setup on top of `createTestDatabase()`: the app's real Better Auth instance (`createAuth`), the fake GitHub on a loopback port (`startTestGithub()` in `src/test-support/github-fake.ts`, the one fake of the app's tests; `createAuthHarness({ github })` and `startGithubAppHarness({ fake })` can share one instance), and helpers that walk the OAuth flow with a cookie jar and call `auth.handler` with real `Request` objects. Session expiry and the 24 hour organization re-check are tested by moving `Date` with `vi.useFakeTimers({ toFake: ["Date"] })`. By default the harness allows the logins of its fake users (`allowedLogins`); `allowedOrg` switches to organization mode, and `restart({...})` starts the same database and fake GitHub again with another allow list, like a server restarted with changed settings.
- `createTestDatabase()` (`src/test-support/test-database.ts`) copies the template into a new
  temporary directory per test, opens it through the production `openDatabase`, and removes the
  directory and the connection after the test (`createTestDirectory()` and `track()` do the same
  for tests that open their own files). No two tests, files or workers share a database file.
- A second connection or a second app instance is a real child process (`db-process.ts` runs
  `db-child.ts`): better-sqlite3 blocks its own thread while it waits for a lock, so a lock held in
  the test process could never be released while the write waits. Node runs `db-child.ts` directly
  (type stripping), so files it imports from `src/db/` use relative imports with a `.ts` extension
  and no TypeScript-only runtime syntax (enums, parameter properties); `erasableSyntaxOnly` in
  `tsconfig.json` enforces the latter.
- Tests of file system errors that depend on permissions (a read-only directory) fail when the tests
  run as root, because root may write anywhere. Run the suite as a normal user.

Planned targets: `test-engine`, `test-stack-up`, `test-stack-down`, `test:docker`, `test:e2e:docker`
(they arrive with the Docker test stack).

## 8. CI

`.github/workflows/ci.yml` (workflow "CI") runs on pull requests into `development`, `main` and `CR-*`
epic branches, and on pushes to `development` and `main`. A new push to a pull request cancels its
superseded run. A run for a push is never cancelled or replaced: the concurrency group of a push
contains the commit hash, so every pushed commit gets its own run. No repository secrets in test jobs, the token is
limited to `contents: read` (the `changes` job also reads pull requests for the path filter), every job has a
timeout, GitHub's own actions are pinned to a major version, every other action and the actionlint Docker
image to a commit hash or image digest, and the uv version is pinned. The structure of the
file is pinned by `app/src/ci/ci-workflow.test.ts`.

| Job | Runs | What |
|---|---|---|
| `changes` | pull requests | Path filter: `app` (anything except `runner/**`, top-level Markdown and `fakes/**` Markdown; Markdown inside `app/` stays because Prettier checks it), `runner` (anything except `app/**` and Markdown), `workflows` (`.github/**`). |
| `app-fast` | app changed | `pnpm format:check`, `lint`, `typecheck`, `test` (unit), `test:int` (host), `build` with placeholder env. |
| `runner-fast` | runner changed | `ruff check`, `ruff format --check`, `pyright`, `pytest -m unit`, `pytest -m "integration or contract"`. |
| `e2e` ("E2E: browser journeys") | app changed | `playwright install --with-deps chromium`, then the journeys against the production build: `@smoke` only on pull requests into `development` and `CR-*`, all (without `@flaky`) on pull requests into `main` and on pushes. |
| `image-app`, `image-runner` | pull requests: app (runner) changed, or any pull request into `main` | Builds the image with `docker/build-push-action` (`load`, no push, GHA layer cache), then runs its smoke test. No registry login, read-only token. Pushes do not run these jobs because the publish workflow builds the same images. |
| `actionlint` | workflows changed | actionlint with `.github/actionlint.yaml`. |
| `ci-passed` ("All checks passed?") | always | Fails on any failed or cancelled job, accepts skipped jobs. |

Pushes and pull requests into `main` run every job. `ci-passed` is the only check that branch
protection requires (on `development`, `main` and the `CR-*` pattern), so a job skipped by the path
filter never blocks a merge. Branch protection is a GitHub setting and is not stored in the repository.

`.github/workflows/publish-images.yml` (workflow "Publish images") runs on pushes to `development` and
`main` only, never for pull requests, and only in the project repository. One job builds both images,
smoke tests both, and only then logs in to GHCR with the run's `GITHUB_TOKEN` (the only secret it
references) and pushes `ghcr.io/expidetgames/code-reviewer-app` and `-runner` with the tags
`sha-<7 character commit hash>` and `development` (branch `development`) or `latest` (branch `main`).
It pushes the commit tags of both images first and the floating tags last, so no floating tag points at a half published release. It is the only workflow with `packages: write`, granted to that job alone. A failing build or smoke
test stops the job before the login, so no tag moves. The structure of both files is pinned by
`app/src/ci/images-workflow.test.ts`; `app/src/ci/dockerfiles.test.ts` pins the runtime versions,
digests, user and `.dockerignore` rules of the Dockerfiles.

Planned, added with the suites they run: the Docker stack jobs (`integration`, `engine`), the
`nightly.yml` workflow and `enforce-pr-source-branch.yml`. `main` accepts pull requests only from
`development` or `hotfix/*`.

## 9. Test cases in Jira

Every story has a "Testfälle" section: one row per behavior with id, type (happy, error, edge,
security), level, given, when, then. Cases are written when the story is refined. The PR description
maps every case to a test file and name, or to "manual" or "not applicable" with the reason. Every
story covers: the happy path, every error it can produce, edge cases (empty, maximum, duplicates and
replays, ordering and concurrency, expiry, idempotency, large diffs, fork and draft PRs), security
cases whenever auth, webhooks, the runner API, tokens or user input are touched (secrets must not
appear in logs, responses or PR comments; PR content is data and never changes runner commands or
prompt instructions), and a regression case for every bug.
