# Dynamic Review: operating it

Dynamic Review is the second review kind next to Diff Review (PR-Agent): an agent reads the pull
request's code in a sanitised, read-only export and returns structured findings that the runner
publishes as one persistent summary comment. The decisions are in epic
[#193](https://github.com/ExpidetGames/code-reviewer/issues/193), the research in
`docs/spike/85-opencode-dynamic-review.md`, and the short deployment record is
[`docs/decisions/0002-dynamic-review-deployment.md`](decisions/0002-dynamic-review-deployment.md).

> **Status: not yet activatable.** The pieces below the line "What exists" ship and are tested, but
> the engine itself (the pinned stock OpenCode binary) is not in the runner image and the runner's
> isolation self-check is still fail-closed. No runner advertises `opencode`, so a Dynamic job never
> runs. Everything on this page about turning it on describes the order to follow once the rest of
> #197/#202 has shipped; the rollout gate and the deployment file can be prepared now.

## What exists, and what does not

| Part | State |
|---|---|
| Project setting `review_kind` (Diff or Dynamic), editable skill, default model `deepseek-v4.1-flash` | Shipped (#194, #200) |
| Rollout gate `dynamic_review` (instance setting, default off), admin control | Shipped (#195, #202) |
| Job tag, capability matching, `no_capable_runner`, `dynamic_review_disabled` | Shipped (#195) |
| Sanitised read-only checkout of the pull request head | Shipped (#196) |
| Fixed review core and the editable skill | Shipped (#198) |
| Engine seam: trusted config, hard limits, per-job model proxy, adapter, process-group cleanup | Shipped (#197 part 1, #202 process-group reuse) |
| Summary comment, findings state, reconciliation | Shipped (#199) |
| Opt-in deployment file for a separate Dynamic runner (`compose.dynamic.yml`) | Shipped (#202), cannot claim yet |
| Pinned OpenCode binary in the image, offline self-check, dedicated engine user, proxy-only network, hostile-repository proof | **Not shipped** (#197 part 2, rest of #202) |
| Binary and Bun lock provenance audit in `make check-licenses` | **Not shipped** |
| Worst-case memory and OOM measurements, the decision to run more than one Dynamic job at a time | **Not shipped** |
| Hosted activation | Needs the hosted egress gate (#82) |

## How a Dynamic job reaches an engine

1. A project set to Dynamic Review enqueues a job tagged `review_kind: dynamic`, **only while the
   instance gate is on**. With the gate off the run is created `failed` with
   `dynamic_review_disabled`; it is never reviewed as a Diff.
2. A runner claims a Dynamic job only if it advertises `opencode` in the claim. The runner
   advertises it only after its startup self-check proved the dedicated engine user, the read-only
   export and proxy-only egress (`runner/src/code_reviewer_runner/capabilities.py`). Today the
   check always fails closed.
3. A Dynamic job that no capable runner claims waits, without an attempt being counted, and is
   **cancelled with `no_capable_runner`** after `RUNNER_NO_CAPABLE_TIMEOUT_SECONDS` (app setting,
   default 30 minutes). It is visible in Runs; it never waits forever and never falls back to Diff.
4. The runner prepares the export (#196), starts one engine per job behind its own model proxy (the
   workspace key never reaches the engine), enforces the hard limits below, publishes (#199) and
   removes the job's temporary files and process group.

PR-Agent-only runners keep processing Diff jobs unchanged. A Dynamic-capable runner also serves Diff
jobs.

## The model

Dynamic Review is model- and provider-agnostic. The default model name is `deepseek-v4.1-flash`; it
is a default, not an allow-list, and there is no provider routing or fallback. The workspace's
existing encrypted BYOK credential is used (no new key variable, no per-project key).

The operator describes what the selected model and destination can do in
`RUNNER_DYNAMIC_CAPABILITIES` (trusted runner configuration, never repository input):

```json
{"tool_choice_required": true, "structured_output": true, "max_output_tokens": 8192}
```

If it is unset, not JSON, or lacks a required feature, the run fails with
`dynamic_model_features_unsupported`. There is no silent fallback to another model or to a Diff
review.

## Hard limits

The limits are fixed in the code (`runner/src/code_reviewer_runner/dynamic_review/budget.py`); no
project setting or pull request text widens them, and the wall-clock limit is the minimum of the
epic's 600 seconds and the runner's job timeout.

| Limit | Value |
|---|---|
| Wall clock | 600 s (lower when `RUNNER_JOB_TIMEOUT_SECONDS` is lower) |
| Model calls | 30 |
| Total tokens consumed (cumulative, not the context window) | 120,000 |
| Tool calls | 200 |
| Distinct files read | 100 |
| One tool result | 64 KiB |
| All tool results together | 4 MiB |
| Untrusted input to the engine | 2 MiB |
| Findings | 30 |

A limit hit ends the run with `dynamic_budget_exceeded`; a run whose usage cannot be established ends
with `dynamic_accounting_failed`. The previous summary comment is preserved in both cases. The
tool, file and result-byte limits are currently observed from the session after the fact; their
preventive enforcement at the model proxy belongs to the second half of #197.

## Errors an operator sees

| Code | Meaning | What to check |
|---|---|---|
| `dynamic_review_disabled` | The instance gate is off | Turn the gate on (below) when the rollout is ready |
| `no_capable_runner` | No runner advertised `opencode` within the timeout | Is a Dynamic runner running, and did its self-check pass? (`docker compose logs runner-dynamic`) |
| `dynamic_engine_unavailable` | The runner got a Dynamic job but has no engine | The job should only reach a capable runner; report it |
| `dynamic_isolation_self_check_failed` | The startup self-check did not prove user, export and network | The runner logs the failed property, never a value |
| `dynamic_model_features_unsupported` | The model or destination lacks tool choice or structured output | `RUNNER_DYNAMIC_CAPABILITIES`, the model |
| `dynamic_config_invalid` | Model, skill or limits of the job are unusable | The project's settings page |
| `dynamic_budget_exceeded`, `dynamic_accounting_failed`, `dynamic_policy_violation` | A hard limit or rule stopped the run | The Runs page |

Switching a project from Dynamic to Diff (or back) starts a fresh summary comment; findings are not
carried across kinds (lead decision of 2026-10-13, see #199). Cancelling a run kills its engine's
whole process group and removes its temporary directory.

## The opt-in runner (`compose.dynamic.yml`)

`compose.dynamic.yml` is an override file that adds a second runner, `runner-dynamic`, next to the
Diff runner of `compose.yml`:

```sh
docker compose -f compose.yml -f compose.dynamic.yml up -d --wait
```

| Setting | Default | Why |
|---|---|---|
| `RUNNER_DYNAMIC_CONCURRENCY` | 1 | One Dynamic job at a time until the memory matrix below exists |
| `RUNNER_DYNAMIC_MEMORY_LIMIT` | `2g` | At least 1 GiB per Dynamic slot plus the runner and proxy reserve (the spike's unvalidated, conservative proposal) |
| `RUNNER_DYNAMIC_MEMORY_RESERVATION` | `1536m` | The soft reservation under the limit |
| `RUNNER_DYNAMIC_IMAGE` | the runner image | The Dynamic image will carry the engine; today there is none |
| `RUNNER_DYNAMIC_CAPABILITIES` | empty | The model description above |

The container drops every capability, sets `no-new-privileges`, bounds its process count (512) and
has no swap, so a memory peak shows up as an OOM kill of the job rather than as a slow host. It
publishes no port and reaches only the app. The same service block works for Coolify (copy it into
the Compose application); a `compose.coolify.yml` variant follows with the real image.

This file does **not** make Dynamic Review work: with today's image the runner starts, fails its
self-check and keeps serving Diff jobs only. Do not set `RUNNER_OPENCODE_COMMAND` or
`RUNNER_DYNAMIC_CHECKOUT` by hand to get around that.

## Activation order (once the engine ships)

1. Deploy **every app instance** with the version that routes by `review_kind`
   (`contracts/README.md`, "Rolling out Dynamic Review"). A previous-release app on the same
   database could hand a Dynamic row to a runner as an untagged Diff job.
2. Roll out the Dynamic runner image and the runner (`compose.dynamic.yml`) and check in its log
   that the self-check passed and `opencode` is advertised.
3. As instance admin open **Admin, Setup, Instance, Dynamic Review**, tick *Allow Dynamic Review on
   this instance*, confirm that step 1 is done and save. The control is server side and admin only;
   it uses the instance settings setter (lock, then cancellation), never raw SQL.
4. Set a project's review kind to Dynamic on its settings page.

Rollback (the full procedure and its reasons are in `contracts/README.md`): switch the gate off
first. That stops new Dynamic jobs and cancels the waiting ones with `dynamic_review_disabled`;
**running jobs finish** on their leases. Before any downgrade of the app, quiesce the runners, check
that no Dynamic engine process is left and that no Dynamic job is `queued` or `running`.

## Capacity: what is measured and what is not

The spike's stock trace (11 model calls, 5.8 s, 596.57 MiB peak RSS of the engine process with fake
model answers) is **not** a capacity figure: it excludes the export's page cache, the proxy, the
runner and helper processes, and it used a tiny repository. Before the Dynamic concurrency is raised
above one, the following has to be measured in the Dynamic image on a documented deployment target,
reading the container's cgroup peak (`memory.peak`), not process RSS:

- a worst-case job at the full export size and the full tool-result envelope;
- an injected OOM kill and an injected engine kill: the previous comment is preserved and no
  process or job temp directory survives;
- the recommended concurrency per GiB, written into this page.

No prices, quality or latency claim is made here; the offline benchmark plan is in the spike
write-up and needs a separately authorised run.

## Not covered

- The firewall of hosted runners (#82) is a separate gate for hosted activation, not a permission
  for unrestricted self-hosted agent egress.
- Running repository code (build, tests) is out of scope (#130 and #82).
- A nested `AGENTS.md` or similar file in the repository can still influence the model. The core
  marks repository content as untrusted data and the engine has no write, execute or general
  network capability, but there is no guarantee of model resistance.
