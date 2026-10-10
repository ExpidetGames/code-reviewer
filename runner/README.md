# Code Reviewer runner

Python worker that runs [PR-Agent](https://github.com/qodo-ai/pr-agent) for one job at a time.
`code-reviewer-run-job` is the entry point of one job; the job loop that claims jobs from the app
comes with a later ticket. See the repository `README.md` for setup and `TESTING.md` for the tests.

## One job

The job is JSON on stdin (the shape is documented in `src/code_reviewer_runner/job.py`):

| Field | Meaning |
|---|---|
| `prUrl`, `command` | `https://<host>/<owner>/<repo>/pull/<n>` on the host of `git.baseUrl`; one of `review`, `improve`, `describe`, `ask` |
| `args` | `ask` only: exactly one string, the question |
| `git` | `provider` (`github`), `baseUrl`, `token` (installation token), `botLogin` (`<app slug>[bot]`) |
| `llm` | `provider` (`openrouter`), `model`, `apiKey`; optional `baseUrl` (loopback only, for test fakes) and `maxTokens` (context window of a model PR-Agent does not know) |
| `env` | optional options of the four tools, `PR_REVIEWER__*`, `PR_DESCRIPTION__*`, `PR_CODE_SUGGESTIONS__*`, `PR_QUESTIONS__*`, as strings. Nothing else is accepted. |

The result is exactly one line of JSON on stdout: `ok`, `durationMs`, `commentUrl` (or `null`),
`errorCode` (or `null`), `logTail` (redacted, at most 4 KB) and `usage` (model, tokens, cost).
The exit code is 0 for `ok` and 1 otherwise. The environment variable `RUNNER_JOB_TIMEOUT_SECONDS`
(read from the process environment, not handed to PR-Agent) makes the runner stop the command and
report `timeout`: first by cancelling it, and if it does not react (a call that blocks the process)
three seconds later by printing the result and ending the process. The caller should still kill the
process after its own deadline.

## Error codes

Defined once, in `ErrorCode` (`src/code_reviewer_runner/result.py`); a test checks that this list
and the enum agree. Callers branch on the code, never on the text.

| Code | Meaning |
|---|---|
| `invalid_job` | The job is not valid JSON or a field is missing, malformed or not allowed |
| `invalid_command` | The command is not one of `review`, `improve`, `describe`, `ask` |
| `pr_agent_version_mismatch` | The installed PR-Agent is not the version the runner was written for |
| `identity_patch_failed` | The method the identity patch replaces is missing or has changed |
| `runner_error` | A failure inside the runner itself |
| `command_failed` | PR-Agent reported a failure it handled itself (failure comment, failed flag) and nothing more specific is known |
| `review_not_published` | `review` returned normally but no review comment was recorded (for example an identity problem) |
| `pr_not_found` | GitHub answered 404 for the pull request |
| `git_auth` | GitHub rejected the token (401) |
| `git_forbidden` | GitHub refused the request (403) |
| `git_rate_limit` | GitHub rate limit (429, or 403 with a rate limit message) |
| `git_unavailable` | GitHub could not be reached, timed out or answered 5xx |
| `git_unprocessable` | GitHub answered 422 |
| `git_provider_init` | PR-Agent could not create its GitHub client and no cause is known |
| `llm_auth` | The LLM provider rejected the key (401, 403). Called `llm_auth_failed` in some planning notes; this is the same thing |
| `llm_quota` | The LLM account has no credit left (402) |
| `llm_rate_limit` | The LLM provider rate limit (429) |
| `llm_timeout` | The LLM provider did not answer in time |
| `llm_unavailable` | The LLM provider could not be reached or answered 5xx |
| `llm_bad_request` | The LLM provider refused the request (400, 422, context too large) |
| `llm_output_invalid` | The model answered, but its answer could not be turned into a review |
| `model_unknown` | PR-Agent does not know the model (set `llm.maxTokens`) or the provider has no such model |
| `timeout` | The command did not finish within `RUNNER_JOB_TIMEOUT_SECONDS` |
| `unknown` | Something failed that no rule recognises |

## Settings policy

- Secrets, URLs and model names reach PR-Agent through the process environment (the environment
  wins over a repository's `.pr_agent.toml`). The runner builds a minimal environment from the job;
  nothing of the parent process is passed on except plain runtime variables.
- Booleans and lists are typed settings, set before the command starts.
- PR-Agent 0.47.0 only protects some host-level keys from a repository's `.pr_agent.toml`. The
  settings guard (`repo_settings_guard.py`) snapshots every key that routes a request or a
  credential, selects the model, bounds the cost or switches publishing and callbacks, and puts them
  back after each settings file PR-Agent merges. A unit test feeds a malicious file through PR-Agent's
  own merge function. Options meant for repositories (instructions, thresholds) still apply.
- `job.env` is limited to the options of the four tools; it cannot carry credentials, endpoints or
  model settings. The only LLM endpoint override is `llm.baseUrl`, accepted for loopback addresses.
- Repository settings files stay enabled (single tenant, trusted repositories); the global settings
  file is off.
- `config.repo_context_files` stays at PR-Agent's default `["AGENTS.md"]` on purpose: the rules a
  project writes down for agents help the review. It costs a few tokens and one extra GitHub call
  per run, and it puts repository text into the prompt, which the repositories of a single tenant
  are trusted to do. Revisit this for a multi-tenant setup.

## Identity patch

An installation token cannot call `GET /user`, so PR-Agent cannot learn which login it posts as and
a second review of the same pull request would fail instead of editing its comment.
`GithubProvider._resolve_user_login` is replaced to return `<slug>[bot]`. The patch is tied to the
exact PR-Agent version (`identity_patch.PATCHED_FOR_VERSION`) and refused for any other.

## Manual run

`scripts/manual_review.py` runs a real review against the sandbox repository; see its docstring.
It needs `--yes`, posts a real comment and costs a few cents.
