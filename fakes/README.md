# fakes

Fake servers and fixtures that stand in for every external system in automated tests, so no test
ever needs the internet, a real GitHub or a real model. The same fakes are shared by the app tests
(Vitest), the runner tests (pytest) and the end-to-end journeys (Playwright). They speak the real
protocol, so the production client code runs unchanged against them.

Planned content (added by the tickets that need it, see `TESTING.md` section "Fakes"):

| Directory | Purpose |
|---|---|
| `github/` | Fake GitHub REST API, App installation tokens, OAuth login endpoints and a signed webhook sender |
| `llm/` | OpenAI-compatible `chat/completions` server with scripted answers, errors and slow responses |
| `pr-agent/` | `fake_pr_agent.py`, a stand-in executable for PR-Agent used by runner tests and e2e |
| `fixtures/github-webhooks/` | Webhook payloads reduced to the fields the app reads (public data only) |

Rules:

- Dummy values only. No real tokens, keys or private repository data, ever.
- A fake is configured through an environment variable (for example `GITHUB_API_BASE`), never
  through a switch in production code.
- Fakes live here, not in `app/` or `runner/`, because more than one test suite uses them.

This directory is intentionally empty of code for now.
