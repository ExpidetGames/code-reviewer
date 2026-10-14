# Runner API

The runner (Python, `runner/`) asks the app for work over HTTP: it **claims** a job, sends
**heartbeats** while it works, and **completes** the job with the result. The wire format is
`contracts/runner-api.v1.json` (see `contracts/README.md`); this file says what the calls mean.

| Call                                      | Success                        | Meaning                                                           |
| ----------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `POST /api/runners/v1/claim`              | `200` job, `204` nothing to do | Reserves the oldest due job and hands it out with its credentials |
| `POST /api/runners/v1/jobs/:id/heartbeat` | `200`                          | Extends the lease (2 minutes; runners beat every 30 seconds)      |
| `POST /api/runners/v1/jobs/:id/complete`  | `200`                          | Stores the result and finishes the job                            |

| File                               | Role                                                                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.ts`                           | `createRunnerApi(deps)`: the order of the checks and the three entry points                                                                                                                                     |
| `claim.ts`                         | The claim: guard, settings, pull request, credentials, the response                                                                                                                                             |
| `report.ts`                        | Heartbeat and complete                                                                                                                                                                                          |
| `requests.ts`                      | The checks on job id, `X-Runner-Id` and the two request bodies (hand written, kept in line with the contract by the compatibility test)                                                                         |
| `token-auth.ts`, `startup.ts`      | The `RUNNER_TOKEN` check (constant time, at least 32 characters) and the warning at a start without the production check                                                                                        |
| `redact.ts`                        | Removes anything that looks like a credential from a result before it is stored                                                                                                                                 |
| `responses.ts`                     | Every answer: `Cache-Control: no-store`, the error form `{ error: { code, message } }`                                                                                                                          |
| `claim-guard.ts`, `job-options.ts` | The two hooks (below); `project-claim-guard.ts` and `review-settings-job-options.ts` are what the running server plugs in                                                                                       |
| `claimed-keys.ts`                  | In the database, encrypted (`job_claimed_keys`): the LLM key handed out with the claim of each job, so a rotated key can still be masked in its result by whichever app instance completes it                   |
| `contract.ts`                      | The TypeScript types and code lists of the contract                                                                                                                                                             |
| `shared.ts`                        | The wiring of the running server (`getRunnerApi()`, `withRunnerApi`); the route files under `src/app/api/runners/v1/` only call `withRunnerApi`, which answers a failure while setting up in the usual 500 form |

## Workspaces

The runner token belongs to the instance, not to a workspace: a claim hands out the oldest due job of any
workspace (`createRunnerQueue`, not scoped). Everything the claim then looks up for that job (repository,
connection, project, review settings) is looked up in the workspace of the job (`job.workspaceId`), so the
credentials are those of the job's own connection. Nothing of this shows in the contract: the answers
are the same as for a single workspace.

## Authentication

`Authorization: Bearer <RUNNER_TOKEN>` on every call. One shared token in the MVP, read from the
environment on every request, without surrounding white space. A missing, wrong, empty or
differently schemed token, and a server without `RUNNER_TOKEN` (or with a blank or **too short** one:
under 32 characters never matches, so a weak token fails closed), all get the same
`401 RUNNER_UNAUTHORIZED` answer,
before anything else is looked at. The comparison hashes both sides and compares in constant time, so
lengths and characters do not matter and it never throws. The session guard lets `/api/runners/**`
through (`src/auth/access.ts`): this token is the authentication.

`X-Runner-Id` is a free-form name (letters, digits and `._:@-`, up to 64 characters) that ends up in
`jobs.runner_id` and in the logs. There is no rate limit on failed attempts: that is why the token must
be long and random (`openssl rand -hex 32`); a production start with a missing or short token is refused (`DEPLOY_CONFIG_INVALID`, `src/deploy/startup.ts`), any other start logs one warning. It is bookkeeping, not a security boundary: what proves that a runner
holds a job is the **lease token**.

## The lease token

Every claim response carries a new `leaseToken`; heartbeat and complete must send it in the body.
The queue (`src/jobs`) checks it, not the runner id, so a runner that stalled past its lease, lost the
job and claimed it again gets a different token, and its old execution is turned away with
`409 RUNNER_LEASE_LOST`. The token is a secret of the holder: logs never contain it.

## Status codes

| Status | Code                            | When                                                                                                                |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `401`  | `RUNNER_UNAUTHORIZED`           | Token missing, wrong or not configured                                                                              |
| `400`  | `RUNNER_ID_INVALID`             | `X-Runner-Id` is not a plain id                                                                                     |
| `400`  | `RUNNER_REQUEST_INVALID`        | Job id is not a UUID, the body is not JSON or a field is missing or wrong (`fields` names them, never their values) |
| `404`  | `RUNNER_JOB_NOT_FOUND`          | No job with that id                                                                                                 |
| `409`  | `RUNNER_LEASE_LOST`             | The caller does not hold the job (lease lost, job finished, wrong token, past the hard time limit)                  |
| `409`  | `RUNNER_RESULT_CONFLICT`        | `complete` for a completed job with another result                                                                  |
| `200`  |                                 | `complete` repeated with the same result (`alreadyCompleted: true`, nothing is stored twice)                        |
| `413`  | `RUNNER_BODY_TOO_LARGE`         | Body over 64 KiB                                                                                                    |
| `503`  | `RUNNER_GIT_ACCESS_UNAVAILABLE` | Credentials could not be created now; `Retry-After` says when                                                       |
| `500`  | `RUNNER_INTERNAL_ERROR`         | Something unplanned; the log has the cause, the answer none                                                         |

Every answer, including `204`, carries `Cache-Control: no-store`.

## Claim

`claimNext(runnerId)` reserves a job (and first expires lapsed leases, see `src/jobs/README.md`). Then,
for that job, in this order:

1. **The claim guard** may refuse it (below).
2. **LLM access** of the job's own workspace (`llm.accessFor(job.workspaceId)`, `src/llm/resolve.ts`): the key the
   workspace entered itself, or, if the operator offers included usage (off), the operator's, or, on a
   single-tenant instance, the legacy `LLM_PROVIDER`/`LLM_API_KEY` variables. The key of another workspace is
   never looked at, and a workspace without a key does not get one: the job ends as `failed` with
   `llm_not_configured` (the log line names the reason, `no_key`, `key_unreadable`, `key_binding_mismatch`, or the
   legacy variables that are wrong). **Operations:** this fails every job of that workspace a runner claims, up to 25
   per request, for good; entering a key later does not revive them (they have to be queued again, for example
   by a new commit or a comment). The key is remembered, encrypted, in the database before the response leaves
   (`claimed-keys.ts`); if that fails the job is given back and the runner gets a 500 without a key.
   **Options** of the job come next (`JobOptionsSource`, below): the model and token budget of the
   review settings replace the instance's model and context window (`llm.model`, `llm.maxTokens`), and
   the other options go into `env`. `llm.baseUrl` and `llm.fallbackModels` are never sent (the LLM
   configuration has no base URL, and the MVP has no fallback chain).
3. **The pull request** is read through the provider's `getPullRequest`. A pull request that does not
   exist ends the job with `pr_not_found`, one that is closed or merged with `pull_request_closed`;
   `prUrl` in the response is the URL the provider reports.
4. **Credentials** are created with the provider's `jobAccess`: a new installation token for exactly this
   repository, with the least permissions. This is the only place that does it; nothing is created when a
   job is queued, and nothing is cached or kept. The token is revealed (`revealGitAccess`) into the
   response and the local value is dropped with it.

### The engines of a claim (#195)

The claim body is optional: `{ "engines": ["pr-agent", "opencode"] }`. The runner advertises the
engines it can run; an absent or empty body is a previous-release runner and means `pr-agent` only.
The claim only hands out a job whose review kind one of those engines can run (`pr-agent` runs Diff,
`opencode` runs Dynamic), filtered in the atomic SQL claim. An unknown engine, a duplicate or an
empty list is `400 RUNNER_REQUEST_INVALID`, and a body over 64 KiB is `413`, both before any job is
claimed and any credential is created. The token check comes first.

A Diff job keeps the exact legacy payload, whatever runner asked: no field is added, so a
previous-release runner parses it unchanged. A Dynamic job is only ever handed to a runner that
advertised `opencode`, and its `input` is tagged:

- `reviewKind: "dynamic"`;
- `dynamic`: `{ model, skill, limits: { maxFindings } }` — model/skill/limits only, a closed object.
  There is no field for the fixed core, a permission, an executable command or an endpoint, and the
  skill is literal data;
- `base`: `{ repository, baseRef, headSha, previousReviewedSha, attemptedShas, attemptedShasTruncated, comparison }` — the exact queued head,
  the base identity the provider reported, and the _declared_ comparison mode (`full` in this stage;
  the checkout verifies completeness before it trusts it). `previousReviewedSha` is the head of the
  last successful review of the same kind (#199), or `null` when there is none; `attemptedShas`
  (#255, optional: left out when there are none, so a runner from before #255 still accepts the job)
  are the heads of the pull request's earlier jobs of that kind that ran and did not succeed (`failed`
  or at least one lost attempt; created after the last succeeded job and before this one, newest
  first, at most 20): a run may have written the summary before it ended, and the publisher accepts
  exactly these heads as the comment's state; `attemptedShasTruncated` (#257, optional: sent only as
  `true`, so a runner from before #257 still accepts the job) says that more heads qualified than the
  list holds, and lets the publisher recover a bot-owned summary whose head fell out of it with a full
  review;
- `env: {}`: no PR-Agent option is promoted into the Dynamic job.

The kind, the engines and the tagged shape are also the contract `ClaimRequest`, `Engine`,
`ReviewKind`, `DynamicReview` and `ClaimBase` in `contracts/runner-api.v1.json`; a Dynamic job whose
kind is not in the runner's engines ends as `dynamic_engine_unavailable` rather than being run by
PR-Agent.

A job that cannot run for a reason that will not go away (LLM not configured, pull request
gone, connection removed or suspended, repository not part of the installation, permissions missing)
ends as `failed` with a stable code (`CLAIM_FAILURE_CODES` in `claim.ts`; a guard may name its own code),
the runner is not told, and
the next job is tried (up to 25 per request, then `204`). If ending the job itself fails (a database
error), the job is given back like after any other unexpected error. A reason that may pass (GitHub rate limiting
or down, the pull request could not be read) gives the job back with `release`: it counts as a lost
attempt like a lapsed lease (3 attempts, then it fails with the reason as its code), waits until the
`Retry-After` time and the runner gets `503`. `Retry-After` is what the platform said (a rate limit),
otherwise 30 seconds, at most 15 minutes. An unexpected error also gives the job back and answers
`500`.

`/review` takes no arguments: the claim never carries `args` (#203). The claim refuses a job whose
command is not `review` as `job_args_invalid` instead of handing a runner a command it would refuse
(in practice the claim selection already excludes removed commands).

## Complete

The body is `{ leaseToken, result }`. `result` is what `code-reviewer-run-job` prints, plus an optional
`errorMessage`. `ok` and `errorCode` agree (`errorCode` is `null` exactly when `ok`).

- Stored: the checked result, with every field filled, in `jobs.result`; for `ok: false` the job's
  `error_code` is the runner's code, or `unknown` if the app does not know it (the original stays in the
  result).
- **No secrets are stored.** The runner redacts its own log. As a second line, `redact.ts` removes
  anything that looks like a credential (GitHub tokens, provider keys, bearer credentials) and the exact
  LLM key of the claim (from the database, so any app instance knows it), the current key of the job's workspace
  and the runner token from `logTail`, `errorMessage` and `commentUrl` before they are stored. The
  git token is not known to the app after the claim, so it can only be recognised by its shape.
- **A runner that is shut down** reports `ok: false, errorCode: "runner_shutdown"`. That is not a result:
  the job is given back with `release` (it waits again, one attempt counted, the same cap as a lapsed
  lease; on the last allowed attempt it fails with `runner_shutdown`) and the answer says
  `status: "queued"` (or `failed`). Nothing is stored. Reporting it again, or after the lease was lost,
  is `409`.
- Repeating the same completion answers `200` with `alreadyCompleted: true`; another result for a
  completed job is `409`. "Same" is compared on the stored form, so leaving out an optional field is
  not a different result.
- A body over 64 KiB is refused with `413` before it is parsed.

## Hooks

- **`ClaimGuard`** (`claim-guard.ts`): `check(job)` returns `{ allow: true }` or
  `{ allow: false, errorCode, outcome? }`. The running server uses `createProjectClaimGuard`
  (`project-claim-guard.ts`): a job whose repository has no active project (the project was switched
  off after the job was queued, or the deactivation raced with the claim) is not handed out. Its
  outcome is `cancel`: `cancelClaimed` ends exactly this job as `cancelled` with `project_deactivated`
  in one statement fenced by the lease token (running to cancelled, no attempt counted, never queued
  in between, so also on the last allowed attempt, and the slot of its head commit is free again), like
  a job that was waiting when the project was switched off. The other waiting jobs of the repository
  were cancelled by the deactivation, and a job enqueued after a reactivation is not touched. The
  default outcome `fail` ends the job as `failed` with the guard's code. No credentials are created
  for a refused job. The other half of the rule is `createJobProjectHooks` (`src/jobs/project-hooks.ts`),
  wired in `src/projects/shared.ts`: deactivating a project cancels its waiting jobs in the same
  transaction; running jobs finish.
- **`JobOptionsSource`** (`job-options.ts`): `optionsFor(job)` returns the options of one job, so they
  can differ per repository: `env` (the extra options of the review PR-Agent tool, `PR_REVIEWER__*`;
  a previous release also sent the removed tools' families, which the runner accepts and ignores) and
  optionally
  `llm: { model, maxTokens, fallbackModels }`. The running server uses
  `createReviewSettingsJobOptionsSource` (`review-settings-job-options.ts`): the review settings of the
  job's repository (project over global defaults over built-in values, read at claim time) go through
  `toRunnerSettings`. The values are text of the type PR-Agent's option has (`"5"`, `"true"`); an option
  that is off is left out. A `model` replaces the model of the LLM access, a `maxTokens` (a whole number
  from 1000 to 10 000 000) becomes `llm.maxTokens` and wins over `LLM_MAX_TOKENS`; a null or missing
  value is left out of the job. `fallbackModels` is accepted and **not handed on**: no fallback chain is
  decided for the MVP. A key outside the review family ends the job as `job_env_invalid`, a model or
  size the runner would refuse as `job_llm_options_invalid`. The key pattern is
  `RUNNER_ENV_KEY_PATTERN` in `contract.ts` (one option name per key, no second `__`): the only
  definition in the app, equal to `JobEnv` in the contract file and to the runner's `_ENV_KEY`; the
  review settings import it.
- **`claimed-keys.ts`**: the claim notes the key it handed out; `complete` masks the key of the claim
  and the current key (`redact.ts`, `maskSecretInText` of `src/llm`) in the log, the error message and
  the other text fields before the result is stored. The note lives in the memory of the process only
  (capped, oldest first; a restart forgets it, and masking then falls back to the current key and to the
  shape of a credential), because a key is never written to the database.

## Where the trigger policy lives

The trigger policy (CR-31: drafts, the review settings, the debounce of a push, the check against
the current head commit, dropping the waiting jobs of a closed pull request) and the project gate
(CR-24, CR-5) are wired in the webhook handler (`src/webhooks/README.md`), so the runner API only sees
jobs the policy let through.

## Tests

- `integration-tests/http/runner-api-claim.integration.test.ts`, `-report`, `-security` and
  `-route-files`: the real handlers with a real SQLite file and the fake GitHub; the route files with
  the wiring of the running server and a delivery that goes through the webhook route first.
- `integration-tests/http/runner-api-projects.integration.test.ts`: the wiring to the projects, the
  review settings and the LLM configuration (CR-46).
- `integration-tests/compatibility/runner-api-contract.integration.test.ts`: the contract.
- `token-auth.test.ts`, `requests.test.ts`, `redact.test.ts`, `claimed-keys.test.ts`, `project-claim-guard.test.ts`: unit tests.
- The harness is `src/test-support/runner-api-harness.ts`; `projects: true` wires the guard and the
  options like the running server (real project service and review settings), otherwise every job may
  run and has no extra options.
