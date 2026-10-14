# Code Reviewer runner

Python worker that runs [PR-Agent](https://github.com/qodo-ai/pr-agent). `code-reviewer-runner` is
the job loop: it claims jobs from the app and starts `code-reviewer-run-job`, the entry point of one
job, as a process of its own for each of them. See the repository `README.md` for setup and
`TESTING.md` for the tests.

## The job loop

`code-reviewer-runner` (the container's entry point) asks the app for work over HTTP
(`contracts/runner-api.v1.json`, `app/src/runner-api/README.md`) and keeps up to `RUNNER_CONCURRENCY`
jobs running. It is configured by environment variables:

| Variable | Meaning | Default |
|---|---|---|
| `RUNNER_API_URL` | Base URL of the app, for example `http://app:3000` | required |
| `RUNNER_TOKEN` | The shared token of the runner API (the app's `RUNNER_TOKEN`) | required |
| `RUNNER_CONCURRENCY` | Jobs at the same time, 1 to 32. One PR-Agent process needs about 320 MB (CR-13), so `floor((MiB - 256) / (321 * 1.5))` for the memory of the container; 3 for 2 GiB | 3 |
| `RUNNER_POLL_INTERVAL_SECONDS` | Wait between two claims when nothing is waiting (after a job ends the loop asks again at once) | 5 |
| `RUNNER_JOB_TIMEOUT_SECONDS` | Hard timeout of one job, see below | 1200 (20 minutes) |
| `RUNNER_SHUTDOWN_GRACE_SECONDS` | How long running jobs may finish after `SIGTERM` | 60 |
| `RUNNER_ID` | Free-form id sent as `X-Runner-Id` (bookkeeping only) | `runner-<hostname>` |
| `PR_AGENT_COMMAND` | The command that runs one job, split like a shell would. Only for test stacks that replace PR-Agent with a fake | `python -m code_reviewer_runner.runner` |
| `RUNNER_OPENCODE_COMMAND` | #197: the pinned stock engine that runs one Dynamic job, split like a shell would (the adapter appends `serve --hostname 127.0.0.1 --port <job port>`). The executable is the one `scripts/fetch_opencode.py` verified against `opencode-pin.json`. Unset means a Dynamic job is refused with `dynamic_engine_unavailable`; never falls back to PR-Agent. The engine also needs a trusted `rg` (ripgrep) on its `PATH`, or it is not started | unset |
| `RUNNER_DYNAMIC_MAX_COST_USD` | #290: the most one Dynamic run may cost, in USD, a plain decimal number above 0 up to 20. Unset or empty: 1.00. Anything else ends the job with `dynamic_config_invalid`. Trusted operator configuration; nothing in a claim can set it | unset |
| `RUNNER_DYNAMIC_CAPABILITIES` | #197: trusted JSON descriptor of the selected model/destination: `{"tool_choice_required": true, "structured_output": true, "max_output_tokens": 8192}`, with `input_usd_per_mtok` and `output_usd_per_mtok` (required: a model without unit costs ends the job with `dynamic_config_invalid`), optionally with `context_window_tokens` (#290). Operator-owned and always wins when set. Unset (or empty) applies the descriptor built into the runner for exactly the shipped default model `deepseek/deepseek-v4.1-flash` (#264); for any other model, or a descriptor without a required feature, the job ends with `dynamic_model_features_unsupported`, no fallback | unset |
| `RUNNER_DYNAMIC_ENGINE_UID`, `RUNNER_DYNAMIC_ENGINE_GID` | #197: the numeric dedicated unprivileged user (and its own group) the engine runs as; it must exist in the image and be neither root nor the runner's own user. The Dynamic job process is the root supervisor that starts the engine as this user | `10101` and `10101` |
| `RUNNER_DYNAMIC_PROXY_PORT`, `RUNNER_DYNAMIC_ENGINE_PORT` | #244: the two fixed loopback ports of the single Dynamic slot (model proxy, engine server), 1024 to 32767 and different. The engine user's static nft rules, installed once at container start, name exactly these; a stranger holding one makes the job fail closed | `10180` and `10181` |
| `RUNNER_DIFF_JOB_USER` | #197: `uid:gid` the loop drops every non-Dynamic job process to, with no other group, in a working directory it owns. Set only on a loop that runs as root (`compose.dynamic.yml`), so PR-Agent never runs as root; unset runs jobs as the loop's own user | unset |
| `RUNNER_DYNAMIC_NODE_BIN` | #197: directory of the Node runtime the engine needs, if it is not on the runner's own `PATH` | unset |

`compose.dynamic.yml` is the opt-in deployment of a separate Dynamic runner (one job at a time, memory
limit, a root supervisor with a short capability list); it cannot claim Dynamic jobs yet. See
`docs/dynamic-review.md`, "The engine boundary".

**The Dynamic job process is the supervisor (#197 part 2b).** It runs as root with only the
capabilities of that file (`SETUID`, `SETGID`, `KILL`, `CHOWN`, `DAC_OVERRIDE`, `FOWNER`;
`no-new-privileges` stays on). **At container start only**, before the event loop and any thread
exists, `job_loop.service.prepare_dynamic_runtime` (`dynamic_review/static_isolation.py`, #244)
installs the static nft rules for the single slot (new connections of the engine user only to the
fixed proxy port `RUNNER_DYNAMIC_PROXY_PORT`, default 10180, and the engine's own port
`RUNNER_DYNAMIC_ENGINE_PORT`, default 10181, on `127.0.0.1`) and then drops `NET_ADMIN` and `SETPCAP`
from the bounding set and from its own sets: the container is created with them (`cap_add`), but the
loop, every job process and the engine never hold them, so `nft` fails for all of them. If the drop
cannot be confirmed the runner does not start; if the rules cannot be installed the capabilities are
dropped anyway and every Dynamic job fails with `dynamic_isolation_self_check_failed`. Per job it (1)
prepares and seals the read-only export for the dedicated engine user
(`export_isolation.prepared_checkout`, which also leases that user and its group exclusively), (2)
checks that its own process holds neither capability and proves the static rules with a probe run as
that user before the engine exists (`netguard.py`, `engine_user.py`; a failure is
`dynamic_isolation_self_check_failed` and no engine), (3) starts the engine with `setuid` in the child, no supplementary group and a closed
environment, with its config file readable (not writable) by that user only, and checks that the user, and nobody
else, listens on the engine's port (`engine_user.py`), and (4) at the end, on SIGTERM (lease loss,
shutdown, timeout) and in the watchdog, kills the engine's process group and then every process of
that user, including helpers that left the group, and removes the job's files (the rules are static
and stay). The loop (root) sweeps that user after every Dynamic job process, and every job sweeps it
right after taking the lease; a sweep that fails makes the next job refuse to start. Without root
(or without the user) the production preparation refuses with `dynamic_isolation_self_check_failed`:
the engine never runs unconfined. The proofs need root and live in `tests/privileged` (below).

Rules (the CR-29 decisions; tests in `tests/unit/test_job_loop*.py` and `tests/integration/test_job_loop*.py`):

- **One process per job.** The job (with the git token and the LLM key) goes to the process on
  **stdin**, never in the arguments and never in the environment. The process gets a minimal
  environment (`PATH`, `HOME`, locale, proxy and certificate settings, the tiktoken cache and its
  timeout), so it does not see `RUNNER_TOKEN` or the job of another process, and its own working
  directory (empty, removed afterwards: PR-Agent reads a `pyproject.toml` there). It leads its own
  process group, so ending a job ends everything it started. The group is only signalled while the
  leader is still unreaped (`process_group.py`; the process is a `Popen` whose pipes are read through
  asyncio, because asyncio's own subprocess reaps the child at once), so a reused group id can never
  be signalled (#233).
- **The engines of a claim (#195).** The loop sends `{"engines": [...]}` with every claim: `pr-agent`
  always, `opencode` only after the startup self-check passed (#202): root supervisor, engine user,
  static network rules installed, `NET_ADMIN`/`SETPCAP` dropped, pinned and trusted engine and `rg`,
  and a probe run as the engine user (`dynamic_review/self_check.py`, run by `job_loop/service.py`
  after the network setup and before the first claim). A failure logs a stable reason and leaves
  `pr-agent` only; a runner without an engine user (every runner but the Dynamic one) never passes.
  The loop gives the job process of a Dynamic job the advertised engines, the verified engine command
  and `RUNNER_DYNAMIC_CAPABILITIES`; a Diff job process gets none of them. A runner that cannot run a
  kind is never handed such a job by the app; a Dynamic job that arrives anyway is refused locally and
  never run by PR-Agent.
- **Refused jobs start nothing.** The input is validated with the runner's own `parse_job` before a
  process is started: an unknown command (`invalid_command`) or platform and any other invalid input
  (`invalid_job`) are reported with `complete` at once. The platforms are the table in
  `platforms.py` (`git.provider` to PR-Agent settings; `github` only in the MVP).
- **Heartbeat** every `heartbeatIntervalSeconds` (30) while the process runs, none after it ends. A
  `409` means the lease is lost: the process is ended and nothing is reported. Other failed heartbeats
  are tried again at the next beat.
- **Hard timeout.** The process gets `RUNNER_JOB_TIMEOUT_SECONDS` as its own limit and reports `timeout`
  with its log when it hits it. A process that does not stop (or a blocked one) is ended by the loop
  10 seconds later: `SIGTERM` to its process group, `SIGKILL` 5 seconds after that, and the job is
  reported as `timeout`. So the effective limit is the timeout plus 10 seconds.
- **The result** is the last line the process printed on stdout, checked against the contract. A
  process that ends without a usable line (crash, signal, no output) is reported as `runner_error` with
  the end of its stderr. The log tail is redacted again with the secrets of the job, the runner token
  and the lease tokens, and cut to 4 KB; the body of `complete` stays under 48 KB (the app refuses 64 KiB).
  Only the newest 256 KB of stdout and 64 KB of stderr are kept, however much the process writes.
- **`complete` is repeated** with growing pauses while the app cannot be reached, for up to 10
  minutes (the lease is 2 minutes, so the app has taken the job back by then). While the result is being resent the loop keeps sending heartbeats, so the lease cannot lapse and no other runner can take the job a second time; a lost lease (409) stops the attempts. A `409` ends the
  attempts. A `400` or `413` is answered once with the bare verdict (no log). An answer that is not HTTP (garbage, a cut-off body) counts as the app being unavailable. The answer
  `status: "queued"` (after a shutdown report) is accepted.
- **Back-off.** When the app is down or answers 5xx, 429 or 401 to a claim, the loop waits 5, 10, 20, 40,
  then 60 seconds (never below 5 seconds, even with a shorter poll interval; or the `Retry-After` of a `503`) and starts over after a successful claim. Running
  jobs are not touched.
- **Shutdown.** `SIGTERM` or `SIGINT`: no new claims, running jobs may finish for
  `RUNNER_SHUTDOWN_GRACE_SECONDS`; then they are ended and reported as `failed` with `runner_shutdown`,
  which the app gives back to the queue (a repeated report may be answered with `409`, which is fine).
  A second signal skips the wait. The exit code is 0.
- **No secrets in logs.** The loop logs ids, codes and counts, never the input of a job. Every line
  passes a masker that knows the runner token, the lease tokens and the credentials of the running jobs.
- **The image and compose.** The entry point is `tini` (PID 1) in front of the loop, so the helpers of a
  killed job are reaped and `docker stop` reaches the loop as SIGTERM; `init: true` is not needed.
  Compose must give the container a `stop_grace_period` of **at least 90 seconds** (60 s grace period
  + 5 s between SIGTERM and SIGKILL + up to 10 s to report `runner_shutdown`; Docker's default of 10 s
  would SIGKILL the runner before the jobs are reported). `PR_AGENT_COMMAND` must never be set in a
  production compose file: the job, with its credentials, would go to that command (the loop logs a
  warning at start when it is set). Only `docker/smoke/compose.fake-job.yml`, the override file of the compose
  smoke test, sets it.
- The codes the loop adds to the ones of the table below: `runner_shutdown`. `timeout` and
  `runner_error` are also reported by the loop itself.

The sizing of a container (memory per process, default concurrency) is in
`docs/spike/cr-13-measurements.md`.

## One job

The job is JSON on stdin (the shape is documented in `src/code_reviewer_runner/job.py`):

| Field | Meaning |
|---|---|
| `prUrl`, `command` | `https://<host>/<owner>/<repo>/pull/<n>` on the host of `git.baseUrl`; `review` (the only command; `/ask`, `/improve` and `/describe` were removed) |
| `args` | legacy field of the removed `/ask`: a previous release may send it; the runner accepts and ignores it and never hands it to PR-Agent |
| `git` | `provider` (`github`), `baseUrl`, `token` (installation token), `botLogin` (`<app slug>[bot]`) |
| `llm` | `provider` (`openrouter`), `model`, `apiKey`; optional `baseUrl` (loopback only, for test fakes), `requireParameters` (only with `baseUrl`, for test fakes: see "Required parameters on OpenRouter"), `maxTokens` and `fallbackModels` (see below) |
| `env` | optional options of the PR-Agent tools, as strings; one option per key (`PR_REVIEWER__NUM_MAX_FINDINGS`, never a second `__`). The app sends only `PR_REVIEWER__*`; the removed tools' families (`PR_DESCRIPTION__*`, `PR_CODE_SUGGESTIONS__*`, `PR_QUESTIONS__*`) are accepted for v1 compatibility and ignored. Nothing else is accepted. See "Settings policy" for how the values are read. |
| `reviewKind`, `dynamic`, `base` | #195: a tagged **Dynamic** job. Absent means a Diff job (the legacy shape). `dynamic` is a closed object `{ model, skill, limits: { maxFindings } }` — model/skill/limits only, the skill is literal data and no field can add a command, a core override, a permission or an endpoint. `base` is `{ repository, baseRef, headSha, previousReviewedSha, comparison }`, the checkout facts; `comparison` is a declared mode, not proof of completeness. `previousReviewedSha` is the head of the last successful review of the same kind (#199), or null; the optional `attemptedShas` (#255) lists the heads of earlier jobs of that pull request that did not succeed (at most 20, distinct; absent means none), and the optional `attemptedShasTruncated` (#257, a boolean the app only sends as `true`) says the list was cut: only then does the publisher rewrite a bot-owned summary whose state head it cannot account for, with a full review (the checkout is full too; earlier findings are not carried over, the summary says so in a one-shot notice and the result log carries `state_reset_attempted_shas_truncated`). The skill is untrusted project data, bounded to 16 KiB of UTF-8 bytes; the runner composes it after its own fixed core (see "Dynamic Review prompts"). |

Checkout preparation (#196) is available through the root-supervised
`dynamic_review.export_isolation.prepared_checkout` lifetime: bounded exact-head acquisition,
sanitized endpoint evidence, exclusive job identities and an actual-uid verified read-only export.
The base-to-head diff is against the merge base of the head and the base ref (a missing merge base
declares a full review of the head); a changed binary or oversized file is excluded and reported as
`skipped` with reason `binary`/`too_large` instead of failing, while denied and unsafe paths still
fail closed. It is an integration seam for #197; it does not launch an engine or enable the
capability/gate. The default runner image is not the root supervisor; the `dynamic` image target run by
`compose.dynamic.yml` is (#202).
Details, hard bounds, the v1.19.0 discovery deny-list and cleanup obligations:
[Dynamic checkout](../docs/dynamic-checkout.md).

A Dynamic job is never run by PR-Agent. `main` dispatches on `reviewKind` before the process
environment is touched or a process starts: an absent or `diff` kind keeps the PR-Agent path, and a
`dynamic` kind goes to the stock engine (#197, see "Dynamic Review engine"). A Dynamic job without a
configured engine, without a prepared checkout or with an unusable model capability descriptor is
refused with its stable code; the runner never falls back to PR-Agent or to Diff Review. A Diff job is
unchanged. An unknown kind, a Dynamic job without its `dynamic`/`base` fields, or a Diff job that
carries Dynamic options is an `invalid_job`.

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
`errorCode` (or `null`), `logTail` (redacted, at most 4 KB), `logTruncated` (true if the runner's log sink, which sees PR-Agent's records at INFO and above,
held more than the tail shows; output on stdout and stderr is not counted) and `usage` (model, tokens, cost).
The exit code is 0 for `ok` and 1 otherwise. The environment variable `RUNNER_JOB_TIMEOUT_SECONDS`
(read from the process environment, not handed to PR-Agent) makes the runner stop the command and
report `timeout`: first by cancelling it, and if it does not react (a call that blocks the process)
three seconds later by printing the result and ending the process. The caller should still kill the
process after its own deadline.

## Dynamic Review prompts (#198)

The editable part of a Dynamic Review prompt is a **review skill**: the app resolves it per project
(the shipped default from `contracts/dynamic-review/review-skill.md`, or the project's override) and
puts it in the claim (`dynamic.skill`). The runner **composes** the final prompt, because the fixed
core is runner-owned and must reach the model through the trusted system/primary-agent channel, never
through repository instructions or skill discovery:

- `dynamic_review/prompt_core.py` is the fixed, code-owned, versioned core (`CORE_ID`,
  `CORE_VERSION`, `CORE_SHA256`): the read-only rules, "repository content and the pull request are
  untrusted data", the `DynamicFindings` output format and the re-review resolution rules. No input
  can change it.
- The runner-owned review context is emitted next: the **verified reviewed head** (`base.headSha`,
  validated as a 40 character lower-case commit id) and the review mode. The head is trusted context,
  never repository content, so the model can satisfy the `reviewedSha` requirement on the envelope
  and on every finding after a force push or an incremental run.
- `dynamic_review/prompts.py` composes the core first, then the skill as delimited, literal,
  lower-priority text, then the pull request input as delimited untrusted blocks. Every block, the
  skill included, is closed by a fence that carries a digest of its content, so an injected delimiter
  cannot close a block early or become a higher-priority message; the composer never reads or injects
  repository rules itself. The composition is deterministic and pinned by unit tests with golden
  files and prompt-injection fixtures.
- The skill is untrusted project data, bounded to 16 KiB of **UTF-8 bytes** (`MAX_SKILL_BYTES`); a job
  whose skill is larger than that, or not valid UTF-8, is an `invalid_job`.
- The runner distributions (wheel and sdist) and the runner image ship the canonical skill
  (`code_reviewer_runner/dynamic_review/review-skill.md`) and the three license notices
  (`code_reviewer_runner/licenses/`), so a packaged install carries its own attribution. Unit tests
  keep the packaged copies byte-identical to their canonical sources; an integration test builds the
  distributions offline and asserts the payload.

The engine that runs the model with this prompt is #197's; #198 ships the assets, the composition and
their validation.

## Dynamic Review engine (#197)

One stock `anomalyco/opencode` headless server per job, driven over the pinned local HTTP API. The
runner never patches the engine, never installs a plugin and never reads its internals; it hardens the
input and the boundaries around it (the epic's binding decision). Modules:

- `dynamic_review/config.py` generates the trusted engine config and the closed environment: a
  default-deny `permission` block that allows only `read` (which also supplies directory listing in
  this pin), `grep`, `glob` and the non-filesystem `StructuredOutput`, one loopback provider (the
  proxy) and the discovery/runtime services switched off. The fixed core (#198) is the runner-defined
  `review` agent's prompt, so it reaches the model through the trusted channel. The flags are defence
  in depth, not a security boundary: #196 strips the discovery inputs from the export.
- `dynamic_review/budget.py` holds the limits and the ledger shared by the proxy and the adapter. The
  one budget is an operator cost limit in USD (#290: default 1.00, `RUNNER_DYNAMIC_MAX_COST_USD`, a
  ceiling of 20 in the code); the technical limits stay (600 s, 64 KiB per result, 4 MiB cumulative
  content, the byte caps). Every call is reserved before it is sent (a priced estimate), every tool
  part is counted, and a missing or oversized answer fails closed; a call without `usage.cost` ends
  the run. The input estimate is bytes over 3, tightened by the previous call's real density, and the
  model's window (from its capability descriptor, never the Diff `llm.maxTokens`) is a backstop in
  front of the provider's own limit. Details: `docs/dynamic-review.md`, "Hard limits".
- `dynamic_review/proxy.py` is the per-job model proxy on loopback. It holds the workspace credential.
  Every request must carry the job's random capability (256 bit, generated by the runner per job and
  handed to the engine only through the trusted config) as a bearer token, compared in constant time;
  anything else is refused with 401 before the upstream is touched, the capability is never forwarded
  and the workspace key is never accepted from the caller, so another process or job on the host
  cannot spend the credential. It forwards only `POST <base>/chat/completions` (and answers
  `GET <base>/models` from the trusted config), refuses every other path and query, builds the
  upstream body from an allowlist of fields (model, destination and output bound come from trusted
  config; a request that names a route or endpoint is refused), never follows an upstream redirect
  (any 3xx fails closed after the one request to the configured URL), reads at most the response bound
  plus one byte, checks the protocol byte bounds both ways, validates the destination's required
  features and takes usage from the provider as authoritative. `steps` and events are never trusted
  for enforcement.
  The upstream call honours the operator's `HTTP(S)_PROXY` / `NO_PROXY` (the https upstream goes
  through a CONNECT tunnel, so a proxy sees the destination but not the key; an operator proxy that
  terminates TLS with its own CA could read the key, which is the operator's trust decision, as for
  the static PR-Agent path). A transient provider or transport failure ends the Dynamic run at the
  first recorded cause even if the engine would have retried successfully (fail-closed, each retry
  is a paid call), the same as a provider 429/5xx.
- `dynamic_review/audit.py` enforces the tool, file and result-byte bounds **at the proxy**, from the
  model requests themselves: every request carries the whole history, so the tool calls of a provider
  answer are counted before the engine gets the answer (the call over the bound is never handed over,
  so it never runs), and the tool results in the next request are checked against the per-result and
  cumulative byte bounds and the distinct-file bound before the request is forwarded (the content over
  a bound reaches neither the provider nor the model). Each call and result is audited once by its
  call id. Files are counted from the pinned shapes of `read` (the file, not a directory listing),
  `grep` (every file it lists) and `glob`. The engine's session list is never read.
- `dynamic_review/reminders.py` (#232) neutralises `<system-reminder>` text in tool results in the
  same pass, before anything is counted or forwarded. The stock engine appends the text of nearby
  `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md` files to a `read` result in such a wrapper (uncapped, and its
  own prompt tells the model the tag is system-added): the wrapper is **dropped** and replaced by a
  short notice, the files stay readable by an explicit `read`. Any other tag text (a file or a grep
  line that contains it) is escaped (`<` becomes `&lt;`), so no `<system-reminder>` tag reaches the
  provider in a tool result. The bounds and the token reservation count the forwarded text.
- `dynamic_review/tagescape.py` (#243) is the escape itself. It matches on a normalised copy of the
  text and rewrites **only the opening bracket** of a match to `&lt;`; everything else stays byte for
  byte. It is linear-time (one `str.translate`, one character-class `sub`, and a match that scans only
  its own bracket's single run of whitespace and slashes or its own name of at most 64 characters;
  the possessive quantifier is a guard, not what keeps it linear; every pattern has a
  50,000-character regression test) and idempotent. It is a bounded
  small filter on purpose, not a list of every wrapper a model might respect: the one tag the
  engine's own prompt blesses, plus closed chat-template control tokens.

  | Spelling | Handled | Why |
  |---|---|---|
  | `<system-reminder>`, `</system-reminder>`, case, whitespace or slashes after `<` | escaped | #232 |
  | Invisible characters anywhere inside or directly in front: the Unicode `Default_Ignorable_Code_Point` set (zero-width and bidi controls, soft hyphen, variation selectors, U+034F, Hangul fillers U+115F, U+1160, U+3164, U+FFA0, Khmer U+17B4/U+17B5, U+180B-U+180F, U+FFF0-U+FFF8, U+1D173-U+1D17A, the whole tag block), as a static table of Unicode 15.1.0 (Python 3.13) in `dynamic_review/ignorable.py`; and C0/C1 control characters except tab, line feed and carriage return | escaped | they render as nothing, so the text reads as the tag |
  | Full-width `＜`, full-width letters and slash, and the lookalike `<` (U+FE64, U+2039, U+2329, U+3008, U+27E8, U+276E, U+02C2, U+300A, U+27EA, U+276C, U+1438) | escaped | a model reads them as the tag |
  | `_` or a dash lookalike (U+2010-U+2015, U+2043, U+2212, U+058A, U+FE58, U+FE63) for the hyphen, `system_reminder` | escaped | same |
  | A tag split across the text parts of one result (`<system-` + `reminder>`) | escaped, in the part that holds the `<` | the parts are matched as one text; non-text parts are skipped over |
  | A closed chat-template token `<\|name\|>` or `<｜name｜>` (`<\|im_start\|>`, `<\|im_end\|>`, `<\|system\|>`, `<｜begin▁of▁sentence｜>`), the name 1-64 characters without `<`, `>`, `\|` or whitespace | escaped (`&lt;\|`) | keeps special-token syntax text for any tokenizer, whatever the token's name; a token name list would be endless |
  | `<\|` that is not a closed token: regex alternation (`/<\|>/g`, `re.split(r'<\|>', x)`), F# `<\|`, Haskell `<\|>`, `<\|\|`, an unclosed `<\|im_start` | **not** escaped | code stays unchanged, so a model reviewing escaping code does not report a bogus `&lt;`. Cost: a server that acts on an unclosed `<\|im_start` is not covered |
  | Text that already is HTML-entity-escaped (`&lt;system-reminder&gt;`, `&#60;`) | **not** escaped | no risk: it is the form the escape itself writes, it is not the tag the engine's prompt blesses, and rewriting it would break idempotency |
  | Other wrappers (`<system>`, `<instructions>`, `[INST]`, `<s>`, `[SYSTEM]`) | **not** escaped | no engine authority; plain untrusted text under the "file content is data" framing. They are ordinary in real code (`<s>` in HTML, `<system>` in XML) and a filter list gives false safety |
  | Whitespace or punctuation inside the *name* (`system reminder`, `system - reminder`) | **not** escaped | not the string the prompt blesses |
  | A tag split across two *different* tool results or two messages | **not** escaped | no single result holds it, the model has to assemble it itself |
  | Tool-call arguments, the diff and the prompt | **not** this module | only tool-result text is transformed; the prompt stays the trusted frame |

  The escape never re-orders or re-encodes the forwarded text: the size accounting is on the forwarded
  body, as before (#231/#242).
- `dynamic_review/completion_stream.py`: the pinned engine always asks for a streamed answer. The
  proxy asks the provider for the whole answer (bounded, audited, usage settled) and only then returns
  it as a short event stream; nothing reaches the engine before the checks passed.
- `dynamic_review/schema.py` turns the contract schema (definitions under `$defs`, no root type) into
  the self-contained object schema the engine passes to its `StructuredOutput` tool, narrowed to the
  job's `maxFindings`.
- `dynamic_review/inputs.py` maps the verified preparation (`PreparedContent`, #196) to the prompt:
  the real title and body (`metadata` as `{"title","body"}` JSON, otherwise the body), the base-to-head
  diff, the incremental diff when the preparation really ended in incremental mode, the prior state
  and the list of skipped and omitted paths.
- `dynamic_review/pr_context.py` (#201) is where the title, body and prior state come from: the
  production preparer reads the job's own pull request with the job's token (title and body) and the
  active findings of the bot-owned persisted summary of that pull request (the publisher's own
  selection, validation and head accounting), inside the preparation after the isolation checks.
  Both are untrusted data: their `<system-reminder>` and chat-template framing is escaped like tool
  results (#232/#243), then they are capped in bytes (title 1 KiB, body 16 KiB, prior state 16 KiB,
  a cut says so; escaped first, so the cap bounds the final size and a cut cannot leave half of a
  tag), then redacted and counted by the preparation and shown only in the fenced data blocks of
  the user prompt. A finding id that the escape would change is refused by the findings parser, so
  every id in the prior state can be named back in `resolvedIds`. A corrupt or unaccountable state,
  a GitHub failure or a read that takes longer than its own 60 s deadline (all requests together,
  at most 10 s each) ends the job with its stable code (`git_unavailable` for the deadline); an
  empty state is never substituted.
- `dynamic_review/adapter.py` starts the engine in its own process group on a private loopback port
  (no verified ripgrep file, leading the engine `PATH`, is a refusal, because the pinned release would download one),
  waits for a healthy pinned server (short per-request timeouts: before its listening marker the server
  can accept a connection and never answer), opens one session, sends the untrusted input as one
  structured turn (bounded by the input byte limit) and validates the answer with the typed findings
  parser, bounded by the job's `maxFindings`, against the files the export really holds (a finding
  outside it is `checkout_incomplete`). While the message runs, a watch ends the run the moment the
  proxy records a limit, a provider refusal or a transport failure to the provider (timeout →
  `llm_timeout` with a 504, refused or reset connection → `llm_unavailable` with a 502; the
  reservation stays spent; the stable code of the first cause is the result, also if the engine
  still produced an answer), the whole-job deadline passes or the engine dies. The
  reviewed head comes from the validated claim (`base.headSha`), never from repository content. On any
  limit, engine exit or unusable answer the whole process group is killed and the private scratch
  removed. A group is only ever signalled while its leader is still unreaped (`process_group.py`: the
  exit is observed with `waitid(WNOWAIT)`, the group is ended, the leader is reaped last), so a reused
  group id can never be signalled (#202, ADR 0002); `shutdown_engines()` is also called by the entry point's
  watchdog so a timed-out run leaks nothing.

`run_dynamic_job` takes the sanitized export from a `prepare` seam (a context manager yielding
`PreparedContent`): the supervisor that owns the privileges supplies it (#196 `prepared_checkout`, with
the dedicated engine user of part 2b); without one the run ends with `checkout_incomplete`.

The pinned executable: `opencode-pin.json` names the exact release (version, tag, source commit),
and per platform the asset, archive size and SHA-256 and the executable's SHA-256. `scripts/fetch_opencode.py`
downloads it only over https, accepts it only when size and digest equal the pin, unpacks exactly one
regular file and checks that it reports the pinned version; nothing at run time downloads anything.
The `dynamic` target of `Dockerfile` calls the same pin in its own stage and installs the verified
file at `/usr/local/bin/opencode`; `ripgrep-pin.json` and `scripts/fetch_ripgrep.py` do the same for
`rg`, which the engine's grep and glob need. `make test-engine` and the engine CI job fetch the engine
the same way.

The answer's schema is the packaged copy of `contracts/dynamic-review/schema.v1.json`
(`dynamic_review/findings-schema.v1.json`), sent as the engine's `format`, and validated again by
`parse_dynamic_findings`. Publication of the findings is #199 (below). The isolation (dedicated uid and the
static network boundary) is part 2b of #197; whether a runner advertises `opencode` is decided once at
start by the self-check above, and only the Dynamic image run as `compose.dynamic.yml` runs it can pass.
The runner does not rely on the app alone: `run_dynamic_job` refuses a Dynamic job with
`dynamic_engine_unavailable` unless the loop handed this job process `opencode` among the advertised
engines.

What the real-binary engine suite (`tests/engine/test_engine_opencode.py`) proves today, with the
unmodified pinned release behind the real proxy: a hostile repository (plugins in `.opencode/` and
named by an `opencode.json`, nested config, agents, commands, tools, skills, AGENTS.md, instruction
files) goes through the real #196 export and nothing of it is loaded or executed, while the same tree
unsanitized does execute its plugins (the control); every write, shell, network, task and unknown tool
and every read outside the export is denied; the bounds above stop a run before the content reaches
the model; a provider refusal and a hung provider end the run with their stable code; and the engine
completes with the pinned server's message-list defect in place. It runs as the test user without a
per-job network namespace: the dedicated uid and the proxy-only network proof are not in it yet.

## Dynamic Review publication and re-review (#199)

A Dynamic Review writes **one** persistent summary comment (never inline comments, labels or a
second status comment) and reconciles each run with the earlier ones:

- `dynamic_review/state.py` is the persistent state (active findings, resolved history, reviewed
  head), stored as a base64 marker in the comment and validated like model output: an unknown
  version, an unknown field or a traversal path fails closed with `dynamic_policy_violation`, never
  an empty state that forgets history. Each active finding is checked against the head it was
  raised at (a carried-over finding keeps it). `encode_state` enforces exactly the decoder's caps
  (30 active findings, 500 resolved, 48,000 characters) and re-parses its own output, so what is
  written can always be read back; `fit_state` makes a larger state fit, deterministically: the
  oldest resolved history goes first (no visible note; a trimmed id can only re-open as a new
  finding), then the lowest priority and, within a priority, oldest active findings. Those are
  counted in `omittedFindings` for the current write and shown as "N further findings not shown"
  (cleared when a later write fits); they are never marked resolved. `render_previous_state` is the
  bounded text handed to the model so it can keep ids stable and name resolved ids.
- `dynamic_review/reconcile.py` applies the fixed core's rules to untrusted model output: a finding
  is resolved only when the run names its id (`resolvedIds`), an omitted or unreadable previous
  finding stays active (no resolution by absence), a moved or rephrased finding keeps its id, a
  duplicate is folded, a regression is re-opened, and the resolved history is retained without a cap.
- `dynamic_review/render.py` renders the reader's view (P0–P3 and confidence, a commit-pinned link,
  bounded evidence) with HTML escaping and neutralised mentions, under two independent bounds
  (65,000 characters and 64 KiB of UTF-8). The state is fitted first (see above), so the comment
  stays updatable; a view that cannot fit fails with `review_text_truncated` and the previous
  comment is kept.
- `dynamic_review/github.py` is the narrow client: page the pull request's comments, create one,
  edit one — nothing else. `dynamic_review/publish.py` selects the bot-owned summary by its exact
  hidden identity marker **and** author (the bot login, a `Bot` account and, when GitHub names the
  app, its slug; the claim has no app id, so an id comparison is a follow-up), refuses a stale
  result (a head other than the job's own, its `previousReviewedSha` or one of the app's
  `attemptedShas` (#255: earlier unsuccessful jobs, which may have published before they failed) is
  refused with `review_not_published` and left as it is), redacts the job's secrets from the
  findings before storing them, and re-reads after an ambiguous create or edit instead of
  duplicating a comment or failing a write that landed.

The app supplies `base.previousReviewedSha` from the last successful review of the same kind
(`jobs.previousReviewedSha`), so the checkout and the publisher compare against the head the earlier
review actually saw. The engine that produces the findings is #197's (above); #199 owns the publication.

## Where the result comes from

`PRAgent.handle_request` only returns `True` or `False`, and `True` also happens when nothing was
posted (or when a tool swallowed its own error). So the result does not come from its return value
(decision of CR-12, see `docs/spike/cr-12-run-result.md`). It is assembled from what the runner
observes while the command runs:

- `commentUrl`: the comment recorder wraps the two write paths of PR-Agent's GitHub provider
  (`publish_comment`, `edit_comment`) and picks the review comment
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

A review that PR-Agent shortened to fit GitHub's comment limit is a failure too, even though a
comment is on the pull request: see "The review comment size limit" below. Such a result keeps its
`commentUrl` when the comment can be found.

When there is no comment link: `review` reports `ok: false` with `review_not_published` (a review
that posted nothing, or only a standalone comment, is a failure the caller must see). No other
command exists to report otherwise.

## Error codes

Defined once, in `ErrorCode` (`src/code_reviewer_runner/result.py`); a test checks that this list
and the enum agree. Callers branch on the code, never on the text.

| Code | Meaning |
|---|---|
| `invalid_job` | The job is not valid JSON or a field is missing, malformed or not allowed |
| `invalid_command` | The command is not `review` |
| `pr_agent_version_mismatch` | The installed PR-Agent is not the version the runner was written for |
| `identity_patch_failed` | The method the identity patch replaces is missing or has changed |
| `runner_error` | A failure inside the runner itself (also reported by the job loop for a process that ended without a result) |
| `command_failed` | PR-Agent reported a failure it handled itself (failure comment, failed flag) and nothing more specific is known |
| `review_not_published` | `review` returned normally but no review comment was recorded (for example an identity problem) |
| `review_state_truncated` | `review` hit GitHub's comment size limit and PR-Agent's hidden record of findings no longer fits: it is not advanced any more, so findings are forgotten (the review is posted with the old record, or as a standalone copy). `commentUrl` is set when the review comment can be found |
| `review_text_truncated` | `review` hit GitHub's comment size limit and part of the visible review was cut off; the record of findings still fits. `commentUrl` is set when the review comment can be found |
| `pr_not_found` | GitHub answered 404 for the pull request |
| `git_auth` | GitHub rejected the token (401) |
| `git_forbidden` | GitHub refused the request (403) |
| `git_rate_limit` | GitHub rate limit (429, or 403 with a rate limit message) |
| `git_unavailable` | GitHub could not be reached, timed out or answered 5xx |
| `git_unprocessable` | GitHub answered 422 |
| `git_provider_init` | PR-Agent could not create its GitHub client and no cause is known |
| `llm_auth` | The LLM provider rejected the key (401, 403). Called `llm_auth_failed` in some planning notes; this is the same thing. In a Dynamic Review the engine sees HTTP 403 both for this and for a budget refusal; the cause of the job is the code the ledger recorded, not the engine's HTTP status |
| `llm_quota` | The LLM account has no credit left (402) |
| `llm_rate_limit` | The LLM provider rate limit (429) |
| `llm_timeout` | The LLM provider did not answer in time |
| `llm_unavailable` | The LLM provider could not be reached or answered 5xx |
| `llm_bad_request` | The LLM provider refused the request (400, 422) |
| `llm_context_length_exceeded` | A Dynamic Review request was larger than the model's context window (the provider said so, #290) |
| `llm_output_invalid` | The model answered, but its answer could not be turned into a review |
| `model_unknown` | PR-Agent does not know the model (set `llm.maxTokens`) or the provider has no such model. A Diff job also ends with it when OpenRouter answers 404 that no provider can handle the requested parameters (#270) |
| `dynamic_engine_unavailable` | A Dynamic Review job arrived but no engine is available to run it; the runner never falls back to PR-Agent |
| `dynamic_isolation_self_check_failed` | The Dynamic engine's startup self-check did not prove the dedicated user, read-only export and proxy-only egress, so the engine is not advertised or launched |
| `dynamic_config_invalid` | The Dynamic options of a job are missing or unusable (model, skill or limits) |
| `checkout_incomplete` | The checkout for a Dynamic Review could not be prepared completely |
| `dynamic_policy_violation` | The Dynamic Review would have broken a hard policy (a tool, a path or an output rule) and was stopped |
| `dynamic_budget_exceeded` | The Dynamic Review used more than its allowed budget |
| `dynamic_accounting_failed` | The Dynamic Review's model usage could not be established or accounted for |
| `dynamic_model_features_unsupported` | The configured model does not support the tool calling or structured output Dynamic Review requires, or OpenRouter found no provider that supports every parameter of a request (404, #270); there is no fallback model or provider |
| `lease_lost` | A Dynamic job was no longer held by this runner (lease lost, job cancelled) or could not be confirmed as held right before it would have written its summary; nothing was written (#260) |
| `timeout` | The command did not finish within `RUNNER_JOB_TIMEOUT_SECONDS` (also reported by the job loop for a process it had to end) |
| `unknown` | Something failed that no rule recognises |

## The review comment size limit

PR-Agent keeps one persistent review comment per pull request and hides a record of every finding it
has seen in it (`<!-- pr-agent-review-state ... -->`), so that a later run recognises earlier findings.
GitHub accepts at most 65,536 characters per comment (PR-Agent cuts at 65,000). The record grows with
every run, and in a long-lived pull request it fills the comment. PR-Agent 0.47.0 then keeps going
without failing: it cuts the visible review to make room for the record (no log line), or, when the
record alone does not fit, logs "Persistent review state did not fit the provider comment limit",
stops advancing the record and posts the old record or a "Standalone PR Review" without a marker.

The runner turns this into a result instead of a success (`review_state_watch.py` wraps the one
function that shortens the comment, `comment_recorder.py` notes a body that was longer than the
provider takes):

| What happened | Code | `commentUrl` |
|---|---|---|
| The record did not fit (also when a standalone copy was posted) | `review_state_truncated` | the review comment if it carries the marker, else `null` |
| The visible review was cut so the record fits, or the provider cut the comment | `review_text_truncated` | the review comment if it carries the marker |

Only `review` is checked. A failure comment or a failure of the command takes precedence.

**Bounding the record: not done.** The data of the CR-48 comparison and PR-Agent's code (pinned by `tests/unit/test_review_state_growth.py`) show why it is not safe
as a runner-side change. PR-Agent keeps at most 20 resolved findings (`DEFAULT_MAX_RESOLVED_FINDINGS`,
a default argument of `reconcile_review_findings`, not a setting) but every active finding without
limit, and in the CR-48 comparison all of the 93 records of the full comment were active (about 690
characters each, the record and the visible review list the same text). Dropping active findings would
make the next run treat them as new (the loss CR-11 recognition is meant to prevent) and needs a second
private PR-Agent function patched; shortening stored bodies has the same cost. The levers that exist
today are `pr_reviewer.num_max_findings` (default 3 per run, a project setting) and the fact that a
complete run resolves findings that are gone. Compacting the record is CR-52; the detection above keeps the loss visible until then.

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
  type of PR-Agent's own default for it (the review tool's options are switches, integers or
  text): a switch takes `true` or `false` (any case), an integer option takes an integer, and
  everything else, instructions above all, stays exactly the text that was sent (`123`, `[1]`,
  `2026-01-01` and `true` in an instructions field are text). A value that does not fit the type of
  its option is an `invalid_job` that names the option, never the value. An option PR-Agent does
  not know is kept as text.
- **Precedence**: PR-Agent's defaults, then the repository's `.pr_agent.toml`, then the options of
  the job. The guard puts the options of the job back after each repository file, so the project
  settings of the app win over the repository file; a repository can only set what the app does not
  manage. The settings that route a request or a credential, select the model, bound the cost or
  switch publishing and callbacks cannot be set by a repository at all: the key list
  `PROTECTED_SETTINGS` (model roles, fallbacks, token and reasoning budgets, endpoints, tokens,
  publishing switches) and the sections in `PROTECTED_SECTIONS`, which are pinned as a whole so a
  key PR-Agent does not declare cannot be added either (`model_routing`, which can swap the model per
  pull request size, `openrouter` provider routing and limits, `litellm`, `openai`, `azure_ad`,
  `aws`, `vertexai` and every provider section PR-Agent reads a key or endpoint from). A unit test
  feeds a malicious file with all of these through PR-Agent's own merge function; another compares
  the provider sections with PR-Agent's own list, so a new provider after an upgrade is noticed.
  A job cannot set the options the runner pins itself (`PR_REVIEWER__FINAL_UPDATE_MESSAGE`,
  `PR_REVIEWER__ENABLE_REVIEW_LABELS_SECURITY` and `_EFFORT`): `invalid_job`.
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
  (`config.repo_context_files`) is read from the default branch as well
  (`config.repo_context_from_default_branch`, pinned to `true`: a repository file could otherwise
  switch it to the branch a pull request targets). Repository settings files stay enabled (single
  tenant, trusted repositories).
- `config.repo_context_files` stays at PR-Agent's default `["AGENTS.md"]` on purpose: the rules a
  project writes down for agents help the review. It costs a few tokens and one extra GitHub call
  per run, and it puts repository text into the prompt, which the repositories of a single tenant
  are trusted to do. Revisit this for a multi-tenant setup.
- `job.env` cannot carry credentials, endpoints or model settings. The only LLM endpoint override
  is `llm.baseUrl`, accepted for loopback addresses.

## Required parameters on OpenRouter (#270)

OpenRouter may route a request to a provider that silently ignores a parameter it does not support
(`tools`, `tool_choice`, `response_format`). Every request the runner sends to OpenRouter for a job
therefore carries `provider.require_parameters: true`: OpenRouter then routes only to providers that
support every parameter of the request, and answers 404 ("No endpoints found that can handle the
requested parameters", or "...that support tool use") when there is none. The field states a capability requirement. It selects no
provider and expresses no preference, so it is no provider-specific routing (epic #193, decision 6);
`provider.only`, `order` and any other routing field stay forbidden.

- **Dynamic Review:** the model proxy adds the field to the body it forwards
  (`ModelProxy(require_parameters=...)`). The engine still cannot send `provider` or any other
  routing field: such a request stops the run with `dynamic_policy_violation` and never reaches the
  provider. A 404 whose text says that no endpoint "can handle the requested parameters" or "supports tool use" / "the provided 'tool_choice' value" (the wordings seen from OpenRouter; `openrouter_parameters.py`) ends the run with
  `dynamic_model_features_unsupported`; any other 404 (an unknown model, a data policy) stays `model_unknown`. No retry on another
  model or provider.
- **Diff Review:** PR-Agent 0.47.0 has no setting for it (`litellm.extra_body` takes three other
  keys, and `openrouter.provider_only` / `provider_order` are provider selectors). The runner wraps
  `LiteLLMAIHandler._apply_openrouter_request_controls` for the length of the job
  (`require_parameters_patch.py`) and adds the field to the `extra_body` PR-Agent has built; LiteLLM
  sends it verbatim. The patch refuses a handler class whose method has another shape, and
  `PATCHED_FOR_VERSION` (checked at the start of every job) ties it to the pinned PR-Agent. The
  engine suite (`tests/engine/test_engine_require_parameters.py`) reads the request that reaches the
  fake LLM. The same 404 ends the job with the existing `model_unknown`; the job's fallback models
  (the app sends none) are the only other models PR-Agent would try.
- **Only for OpenRouter.** A job without `llm.baseUrl` talks to OpenRouter and always gets the
  field. A job with `llm.baseUrl` talks to a local fake and gets the request unchanged, unless the
  test double that added the address also sets `llm.requireParameters: true` (the wrapper
  `fakes/pr-agent/run_job_against_fake_llm.py` does; the field is refused without `baseUrl`, so no
  job for the real provider can switch the requirement off).

## Identity patch

An installation token cannot call `GET /user`, so PR-Agent cannot learn which login it posts as and
a second review of the same pull request would fail instead of editing its comment.
`GithubProvider._resolve_user_login` is replaced to return `<slug>[bot]`. The patch is tied to the
exact PR-Agent version (`identity_patch.PATCHED_FOR_VERSION`) and refused for any other.

The patch reaches into a private method, so a PR-Agent upgrade must not slip through. Two layers
protect it:

- At the start of every job the runner checks the installed version, that `_resolve_user_login`
  exists and takes only `self`, and that the chain that asks it for the login is intact
  (`is_comment_authored_by_pr_agent` calls `_agent_login`, which calls `_resolve_user_login`; see
  `identity_funnel.py`). If anything differs, the job is refused before PR-Agent runs, with the
  result code `pr_agent_version_mismatch` or `identity_patch_failed`. The detail names the method,
  the installed version and, for a signature change, the expected and the found signature. The
  runner never falls back to another identity and never posts a duplicate comment instead.
- `tests/unit/test_dependency_pin.py` and `tests/unit/test_identity_funnel.py` run in the runner CI
  job against the real, pinned PR-Agent (no network). They fail when the pin, the lock file, the
  installed package and `PATCHED_FOR_VERSION` disagree, when the methods the patch relies on are
  gone or changed, or when the fingerprint of one of them (a hash of its syntax tree) differs from
  the one recorded for 0.47.0. The same file also records the fingerprint of
  `append_review_state`, the function the review state watch wraps (see "The review comment size
  limit"): read what it cuts and when before updating that fingerprint. A PR that bumps `pr-agent` therefore turns the check
  `All checks passed?` red until someone has read the release diff and updated the recorded
  fingerprints and `PATCHED_FOR_VERSION` together with the pin. The fingerprints are hashes of
  the syntax tree and were recorded on Python 3.13 (the version of `.python-version` and the
  image); on another minor version they differ, so the fingerprint tests first assert the
  interpreter and say so instead of reporting a PR-Agent change that does not exist.

## Engine tests

`tests/engine/` runs the real, pinned PR-Agent through `code-reviewer-run-job` (one process per job)
against a fake GitHub and a fake OpenAI-compatible LLM on loopback ports, with no real network and no
real model: `uv run python scripts/prime_tiktoken_cache.py` once (the only step that needs the
internet), then `uv run pytest -m engine` (about 4 minutes; CI runs it in a network namespace for pull requests that change
the runner and nightly). The suite pins down the review command, the second review that edits the
first comment, the error codes for a rate limited, silent, wrong or unreachable model or GitHub, that
no credential is found in any output, what a hostile `.pr_agent.toml` cannot do, and what happens with
a comment at GitHub's length limit. See TESTING.md for the design.

## Measuring memory and duration

`scripts/measure_runs.py` starts one or several runner processes against the sandbox pull requests
(small, medium, large) and reports the peak memory (`ru_maxrss` of each process) and the duration of
each, with minimum, median and maximum over repeats. It runs on the host or inside the runner image
with a memory limit (`--docker IMAGE --memory 2g`), where it also reads the peak memory and the OOM
kills of the whole container. `--fake-llm` replaces the model with a canned local answer and puts a
dummy key into the job, so a run costs nothing; but every run, fake or real, posts or edits the real
review comment of the sandbox pull request, and the canned finding overwrites it. The script exits
with 1 if a child failed or was killed, and limits repeats and processes to 10. The results and the numbers derived from them (default `RUNNER_CONCURRENCY`, server
size) are in `docs/spike/cr-13-measurements.md`. Like the manual run it needs `--yes`.

## Manual run

`scripts/manual_review.py` runs a real review against the sandbox repository; see its docstring.
It needs `--yes`, posts a real comment and costs a few cents.
`--no-identity-patch` starts the runner without the identity patch, as a control for the spike
(CR-11). The report of that spike is `docs/spike/cr-11-second-run.md`; the reports of the
other spike tickets are added to the same folder.
With `--record-dir DIR --label NAME` it also saves the result JSON and the text of the review comment
right after the run (the next run edits the comment in place); nothing is saved if a secret shows up in
either. The model comparison of CR-44 (`docs/spike/cr-44-model-comparison.md`) was made this way.
