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
| `llm` | `provider` (`openrouter`), `model`, `apiKey`; optional `baseUrl` (loopback only, for test fakes), `maxTokens` and `fallbackModels` (see below) |
| `env` | optional options of the four tools, `PR_REVIEWER__*`, `PR_DESCRIPTION__*`, `PR_CODE_SUGGESTIONS__*`, `PR_QUESTIONS__*`, as strings; one option per key (`PR_REVIEWER__NUM_MAX_FINDINGS`, never a second `__`). Nothing else is accepted. See "Settings policy" for how the values are read. |

`llm.maxTokens` (integer, 1000 to 10,000,000) is the context window the runner gives PR-Agent. It
sets `config.custom_model_max_tokens` (used for a model PR-Agent does not know) and
`config.max_model_tokens` (the upper bound PR-Agent applies to every model, default 32,000), both
to the same value; without `maxTokens` PR-Agent's own values stay. The value also applies to the
fallback models PR-Agent does not know, so use the smallest window of the models in the chain.

`llm.fallbackModels` (optional list of at most five model names, same characters as `model`, no
repeats, none equal to `model`) is the chain PR-Agent tries, in order, when the model fails. Every
entry gets the `openrouter/` prefix like `model`. Without the field there is no fallback: PR-Agent's
own default fallback model belongs to another vendor and is never used. An entry that is not a valid
model name, a list that is too long or one with a repeat is an `invalid_job`. A review that needed
a fallback model reports `usage.fallbackUsed`.

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

How a job becomes PR-Agent configuration (`pr_agent_config.py`, `pr_agent_runtime.py`,
`repo_settings_guard.py`):

- **No secret in the process environment.** The installation token (`github.user_token`) and the
  LLM key (`openrouter.key`) are typed settings, set inside the request scope. PR-Agent reads both
  from its settings (verified for its GitHub provider and its LiteLLM handler), so they are not
  environment variables, and a `{env[...]}` reference finds nothing. The environment of the PR-Agent
  process is built from scratch: runtime variables (`PATH`, `HOME`, proxy and certificate settings,
  the tiktoken cache), endpoints (`GITHUB__BASE_URL`, `OPENROUTER__API_BASE`), model names and a
  few switches. Nothing of the parent environment passes on. The values of `job.env` are not in it
  either.
- **Nothing a job or a repository sends is evaluated.** Dynaconf evaluates a text that starts with
  `@format`, `@jinja`, `@get`, `@read_file` and similar markers when the setting is read; such a
  text can read an environment variable or any other setting, a secret included, into the prompt
  and from there into a public comment. Dynaconf only does that while its `AUTO_CAST_FOR_DYNACONF`
  setting is on. It is switched off in three places: in the environment (Dynaconf reads it before
  the first variable, which PR-Agent's own setting of it comes too late for), as the first typed
  setting of each job, and by the settings guard before and after every settings file it lets
  PR-Agent merge. As a safety net the guard turns any value still waiting for evaluation back into
  its text after each merge. A `this.<section>.<key>` reference would still resolve a typed secret
  if evaluation were on, so the switch is what keeps `@jinja {{ this.github.user_token }}` literal.
  It also covers texts PR-Agent stores in its settings itself, such as the body of a linked ticket.
  Tests prove this with PR-Agent's real loaders and `_apply_repo_settings_file`, and by rendering
  PR-Agent's review prompt. The Dynaconf version they were written against is pinned in
  `tests/unit/test_dependency_pin.py`.
- **`job.env` values keep their type.** They are not read as TOML. The type of an option is the
  type of PR-Agent's own default for it (all options of the four tools are switches, integers or
  text): a switch takes `true` or `false` (any case), an integer option takes an integer, and
  everything else, instructions above all, stays exactly the text that was sent (`123`, `[1]`,
  `2026-01-01` and `true` in an instructions field are text). A value that does not fit the type of
  its option is an `invalid_job` that names the option, never the value. An option PR-Agent does
  not know is kept as text.
- **Precedence**: PR-Agent's defaults, then the repository's `.pr_agent.toml`, then the options of
  the job. The guard puts the options of the job back after each repository file, so the project
  settings of the app win over the repository file; a repository can only set what the app does not
  manage. The settings that route a request or a credential, select the model, bound the cost or
  switch publishing and callbacks (`PROTECTED_SETTINGS`) cannot be set by a repository at all. A
  unit test feeds a malicious file through PR-Agent's own merge function.
- **Where `.pr_agent.toml` comes from.** PR-Agent 0.47.0 reads it from the **default branch** of the
  repository (contents API without a ref), not from the head of the pull request and not from the
  base branch of a pull request into another branch. The author of a pull request therefore cannot
  change how the review is configured by changing the file in that pull request; a change takes
  effect once it is merged into the default branch. The runner keeps it that way: the setting that
  would name another branch (`config.config_branch`, also the environment variable
  `PR_AGENT_CONFIG_BRANCH`, which the minimal environment drops) and per-directory settings files
  (`config.enable_per_directory_settings`) are pinned, so a repository file cannot redirect the
  lookup. The organization-wide settings repository (`<owner>/pr-agent-settings`) is not read
  (`config.use_global_settings_file` is off). The agent rules file `AGENTS.md`
  (`config.repo_context_files`) is read from the base branch of the pull request. Repository
  settings files stay enabled (single tenant, trusted repositories).
- `config.repo_context_files` stays at PR-Agent's default `["AGENTS.md"]` on purpose: the rules a
  project writes down for agents help the review. It costs a few tokens and one extra GitHub call
  per run, and it puts repository text into the prompt, which the repositories of a single tenant
  are trusted to do. Revisit this for a multi-tenant setup.
- `job.env` cannot carry credentials, endpoints or model settings. The only LLM endpoint override
  is `llm.baseUrl`, accepted for loopback addresses.

## Identity patch

An installation token cannot call `GET /user`, so PR-Agent cannot learn which login it posts as and
a second review of the same pull request would fail instead of editing its comment.
`GithubProvider._resolve_user_login` is replaced to return `<slug>[bot]`. The patch is tied to the
exact PR-Agent version (`identity_patch.PATCHED_FOR_VERSION`) and refused for any other.

## Manual run

`scripts/manual_review.py` runs a real review against the sandbox repository; see its docstring.
It needs `--yes`, posts a real comment and costs a few cents.
