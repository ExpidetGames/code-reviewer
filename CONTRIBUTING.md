# Contributing to code-review.com

**External contributions are not accepted.** code-review.com is a proprietary hosted service of
Itegro GmbH. The source is public for transparency only (see [`LICENSE`](LICENSE)); it is not an open
source project, it cannot be self-hosted, and we do not review or merge pull requests from outside
the team. Please do not open pull requests, and do not expect a reply to an unsolicited one. A
contribution is only considered when Itegro GmbH has agreed to it in writing beforehand.

If you found a bug in the service, tell us through the support channel of the service. Security
problems never go into public issues: follow [SECURITY.md](SECURITY.md).

The rest of this file is the workflow of the team that develops the service.

## Set up the development environment

You need Node.js 24 or newer with pnpm 10 (`corepack enable` is enough), [uv](https://docs.astral.sh/uv/)
0.5 or newer, and `make`. Docker is only needed for the image and stack smoke tests below.

```sh
git clone https://github.com/Itegro-GmbH/code-reviewer.git
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

When the issue has a "Test cases" table, put the issue number and the case id in a comment above
the test that proves the case (`// #123-T03`), never in the test title. That keeps a test traceable
to its issue.

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
2. **Work in a branch of the repository** (one worktree per issue) and branch from `development`. Name the branch `<issue number>-<short-slug>`, for example
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
  `uv --directory runner run ruff format . ../fakes` fix formatting.
- Identifiers, comments, documentation and every user visible string are in English.
- The app is styled with Tailwind CSS v4 and shadcn/ui (components copied into
  `app/src/components/ui/`). Every colour lives only in `app/src/app/theme.css`; a check under
  `app/src/ci/colors` fails on a colour literal in any other source file, with no exception. The
  stylesheet also carries the Tailwind preflight reset and the project's base rules.
- Keep secrets out of code, logs, test output and commits. Configuration comes from environment
  variables, documented in the `.env.example` files.
- Update the documentation next to the code you change, and `TESTING.md` if you change how
  something is tested.

## License

The repository is proprietary (the `LICENSE` file): Copyright (c) 2026 Itegro GmbH, all rights
reserved. Work that the team does here belongs to Itegro GmbH under the terms of each person's
agreement with it.

Every source file starts with the line `SPDX-License-Identifier: LicenseRef-Proprietary`, in the
comment syntax of its language (`//` for TypeScript and JavaScript, `#` for Python, shell,
Dockerfiles and the Makefile, `/* */` for CSS; after a shebang or the `# syntax=` line of a
Dockerfile). Data and configuration files (JSON, YAML, TOML, lock files), Markdown, the license
texts, `docs/` and `fakes/fixtures/` have none. A new source file without the header fails a unit
test; `make fix-spdx-headers` adds it to every file that lacks it. The rules (which files count, how
the header looks) are in `app/src/ci/spdx-headers/rules.ts`.

One documented exception: the shadcn/ui components copied into `app/src/components/ui/` keep their
real license. They start with `// SPDX-License-Identifier: MIT` and a provenance line
(`// Adapted from shadcn/ui (MIT), https://ui.shadcn.com`) instead of the proprietary header; the
rule and `make fix-spdx-headers` know that folder. Do not "fix" those headers. The same is true of text
adapted from third party work that has its own license (the Dynamic Review skill, `contracts/dynamic-review/review-skill.md`,
is adapted from Apache-2.0 sources and says so): never relabel it, and record its attribution in
`NOTICE` and `THIRD_PARTY_LICENSES.md`.

If you add a dependency, check its license. `make check-licenses` (part of `make verify`, and the CI
job "Licenses: dependency check") fails when a package of `app/pnpm-lock.yaml` or `runner/uv.lock`
has a license outside the allow list of `license-policy.json`. Permissive licenses pass without any
entry. For any other license, choose another dependency, or, when that is not reasonable, add an
exception with a reason to `license-policy.json` and to the matching table in
`THIRD_PARTY_LICENSES.md` (a test fails when the two disagree). Also record the dependency there when
it needs attribution.
