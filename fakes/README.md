# fakes

Fake servers and fixtures that stand in for every external system in automated tests, so no test
ever needs the internet, a real GitHub or a real model. The same fakes are shared by the app tests
(Vitest), the runner tests (pytest) and the end-to-end journeys (Playwright). They speak the real
protocol, so the production client code runs unchanged against them.

| Directory                   | Purpose                                                                                                                                                                                                                                           | Status                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `github/`                   | The one fake GitHub: OAuth login and user endpoints, the GitHub App REST API (installations, tokens, repositories, pull requests), the calls PR-Agent makes (diffs, commits, file contents, comments) and a signed webhook sender                 | exists, see `github/README.md`       |
| `llm/`                      | OpenAI-compatible `chat/completions` server with a canned answer per PR-Agent tool and errors of a test's choice (`server.ts`, `canned.ts`). Malformed output and slow responses are planned                                                      | exists                               |
| `pr-agent/`                 | `run_job_against_fake_llm.py`, the real job entry point with the address of the fake LLM added to the job (`PR_AGENT_COMMAND` of the e2e runner). `fake_pr_agent.py`, a stand-in executable for PR-Agent used by runner tests and e2e, is planned | `run_job_against_fake_llm.py` exists |
| `fixtures/github-webhooks/` | Webhook payloads reduced to the fields the app reads (public data only)                                                                                                                                                                           | exists                               |

Rules:

- Dummy values only. No real tokens, keys or private repository data, ever.
- A fake is configured through an environment variable (for example `GITHUB_API_BASE_URL`), never
  through a switch in production code.
- Fakes live here, not in `app/` or `runner/`, because more than one test suite uses them. The one
  exception for now is the pair of fakes of the runner's engine suite (`runner/tests/engine/fake_github.py`,
  `fake_llm.py`): only that suite uses them and the runner's ruff and pyright cover them there; they
  move here when a second suite needs them.
- Fakes are TypeScript or Python files that run as they are (Node 24 strips the types; no build
  step). The app's `format` and `format:check` scripts cover `fakes/`.
