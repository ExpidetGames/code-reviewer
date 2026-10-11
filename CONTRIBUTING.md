# Contributing to code-review.com

Thank you for helping. code-review.com runs automatic code reviews on GitHub pull requests with
[PR-Agent](https://github.com/qodo-ai/pr-agent) and adds a web UI to configure and inspect them.
This guide explains how to get a change from an idea to a merged pull request.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems do
not go into public issues: follow [SECURITY.md](SECURITY.md) instead.

## Ways to contribute

- **Report a bug or suggest a feature** with one of the [issue forms](https://github.com/ExpidetGames/code-reviewer/issues/new/choose).
- **Pick up an issue.** Issues labeled
  [`good first issue`](https://github.com/ExpidetGames/code-reviewer/labels/good%20first%20issue)
  are small and well described; issues labeled
  [`help wanted`](https://github.com/ExpidetGames/code-reviewer/labels/help%20wanted) are ones the
  maintainers would like help with. Comment on the issue before you start, so that two people do
  not do the same work.
- **Improve the documentation**, including this file.

For anything larger than a small fix, open or comment on an issue first and agree on the approach
before you write the code. It saves you from building something that cannot be merged.

### What a good issue looks like

- One problem or one feature per issue, with a title that says what is wrong or wanted.
- For a bug: the version or commit, how you run it (Docker Compose, Coolify, local development),
  the steps to reproduce it, what you expected and what happened instead. The bug form asks for
  exactly this.
- For a feature: the problem you are trying to solve, before the solution you have in mind.
- Logs only after you removed everything secret from them. Never paste API keys, tokens, private
  keys, webhook secrets or `.env` files into an issue, a pull request or a comment.

## Set up the development environment

You need Node.js 24 or newer with pnpm 10 (`corepack enable` is enough), [uv](https://docs.astral.sh/uv/)
0.5 or newer, and `make`. Docker is only needed for the image and stack smoke tests below.

```sh
git clone https://github.com/<your-account>/code-reviewer.git   # your fork
cd code-reviewer
make install
```

`make install` installs the app (`app/`, Next.js, TypeScript, pnpm) and the runner (`runner/`,
Python, uv) from their lockfiles. The [README](README.md) explains how to run the app and the
runner locally, which settings they need, and how to build the container images. Use your own
port for the dev server (`pnpm dev --port 3417`) so that you do not clash with other processes.

## Tests

The project is developed test first. `make verify` runs lint, typecheck, unit tests and the
integration tests that run on the host, for both parts. It must be green before you open a pull
request:

```sh
make verify
```

[TESTING.md](TESTING.md) is the source of truth for how the project is tested. In short:

- Prove each behavior at the lowest level that can show it, and at one level only.
- Write the failing test first, then the code. A bug fix starts with a test that is red before
  the fix.
- Levels, from cheap to expensive: unit tests, integration tests (real SQLite file, real
  processes and sockets on loopback), contract tests (the runner API), engine tests (the real
  PR-Agent against fakes), image and stack smoke tests, and end-to-end tests with Playwright.
  TESTING.md lists what belongs where and which tests a type of change needs.
- No automated test calls a real service. There is no real GitHub, no real model and no internet in
  tests: the fakes in `fakes/` replace them. No secret belongs in a test, a log or a fixture.
- Never skip, disable or weaken a test to make a run green, and do not raise retries to hide a
  flaky test. Report flaky tests in an issue.

While you iterate, run only the tests you touch, for example
`pnpm --dir app exec vitest run <path>` or `uv --directory runner run pytest <path>`.

Some checks are not part of `make verify`. Run the ones that fit your change; CI runs them for
pull requests that touch the matching parts:

| Command | When | Needs |
|---|---|---|
| `make test-engine` | you change the runner, the PR-Agent version or its settings | internet once (a tokenizer file), about 4 minutes |
| `make test-e2e` | you change a user flow in the web UI | a browser (`PLAYWRIGHT_CHANNEL=chrome` uses an installed Chrome) |
| `make test-images` | you change a Dockerfile, or the app or runner in a way that affects the image | Docker |
| `make test-compose` | you change `compose.yml` or how the app and runner start together | Docker |

## Branches, commits and pull requests

1. **Find or open an issue** for the change. Every pull request is linked to one.
2. **Fork the repository** (maintainers can work in branches of the repository itself) and branch
   from `development`. Name the branch `<issue number>-<short-slug>`, for example
   `123-fix-webhook-retry`.
3. **Commit** in small steps, each one green. Use a plain imperative message that starts with the
   issue number: `#123: reject webhook deliveries with an old timestamp`.
4. **Run `make verify`** and the extra checks that fit your change (see above).
5. **Open a pull request into `development`.** `main` only receives releases, and both branches
   are protected: nothing is pushed to them directly. The title is the summary followed by the
   issue number, for example `Reject stale webhook deliveries (#123)`. The description contains
   `Closes #123`, what changed, how it was tested, and follow-ups you saw but did not do. The pull
   request template guides you.
6. **Respond to review.** Push further commits to the same branch instead of force pushing over a
   review in progress. Pull requests are squash merged once the review is done and CI is green.

Keep a pull request to one issue. If you find something else that needs fixing, open another
issue for it.

## Code style

- TypeScript is strict, and `any` needs a comment that says why. Python is typed (pyright strict)
  and formatted with ruff. `make lint` checks both parts; `pnpm --dir app format` and
  `uv --directory runner run ruff format .` fix formatting.
- Identifiers, comments, documentation and every user visible string are in English.
- Keep secrets out of code, logs, test output and commits. Configuration comes from environment
  variables, documented in the `.env.example` files.
- Update the documentation next to the code you change, and `TESTING.md` if you change how
  something is tested.

## License

code-review.com is licensed under the Apache License, Version 2.0 (the `LICENSE` file). By submitting a
contribution you agree that it is licensed under the same terms (section 5 of the license). There
is no CLA and no copyright assignment: you keep the copyright to your work, and you do not sign
anything. Make sure you have the right to submit what you contribute, in particular that you did
not copy code with an incompatible license.

If you add a dependency, check its license and record it in
`THIRD_PARTY_LICENSES.md` when it needs attribution or is not permissive.
