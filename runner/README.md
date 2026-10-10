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
`errorCode` (or `null`), `logTail` (redacted, at most 4 KB), `logTruncated` (true if the runner's log sink, which sees PR-Agent's records at INFO and above,
held more than the tail shows; output on stdout and stderr is not counted) and `usage` (model, tokens, cost).
The exit code is 0 for `ok` and 1 otherwise. The environment variable `RUNNER_JOB_TIMEOUT_SECONDS`
(read from the process environment, not handed to PR-Agent) makes the runner stop the command and
report `timeout`: first by cancelling it, and if it does not react (a call that blocks the process)
three seconds later by printing the result and ending the process. The caller should still kill the
process after its own deadline.

## Where the result comes from

`PRAgent.handle_request` only returns `True` or `False`, and `True` also happens when nothing was
posted (or when a tool swallowed its own error). So the result does not come from its return value
(decision of CR-12, see `docs/spike/cr-12-run-result.md`). It is assembled from what the runner
observes while the command runs:

- `commentUrl`: the comment recorder wraps the two write paths of PR-Agent's GitHub provider
  (`publish_comment`, `edit_comment`) and picks the review (or improve summary, or answer) comment
  by its hidden marker only: the marker must be an exact line within the first five lines of the
  comment (or its link-reference form), as PR-Agent itself checks it. The visible heading does not
  count: it is configurable, and the "Standalone PR Review" comment that PR-Agent posts when it
  cannot verify its identity keeps the heading but drops the marker. An edited comment counts, which
  is what a second review does. No GitHub call is made to look the comment up afterwards.
- `ok` and `errorCode`: false if `handle_request` returned `False` or raised, if the tool marked the
  command as failed, or if it posted a "Failed to ..." comment. The code is derived from the
  exception PR-Agent logged (the runner's own log sink reads it off the record), never from text.
- `logTail`: the runner's own redacting sink, newest lines, warnings and errors first, at most 4 KB,
  escape sequences removed, control characters turned into spaces, then redacted.

When there is no comment link: `review` reports `ok: false` with `review_not_published` (a review
that posted nothing, or only a standalone comment, is a failure the caller must see). `improve`, `ask` and `describe` keep
`ok: true` with `commentUrl: null` (nothing to suggest is a valid outcome; `describe` edits the pull
request itself and never has a comment).

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
`--no-identity-patch` starts the runner without the identity patch, as a control for the spike
(CR-11). The report of that spike is `docs/spike/cr-11-second-run.md`; the reports of the
other spike tickets are added to the same folder.
With `--record-dir DIR --label NAME` it also saves the result JSON and the text of the review comment
right after the run (the next run edits the comment in place); nothing is saved if a secret shows up in
either. The model comparison of CR-44 (`docs/spike/cr-44-model-comparison.md`) was made this way.
