# Runner API

The runner (Python, `runner/`) asks the app for work over HTTP: it **claims** a job, sends
**heartbeats** while it works, and **completes** the job with the result. The wire format is
`contracts/runner-api.v1.json` (see `contracts/README.md`); this file says what the calls mean.

| Call                                      | Success                        | Meaning                                                           |
| ----------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `POST /api/runners/v1/claim`              | `200` job, `204` nothing to do | Reserves the oldest due job and hands it out with its credentials |
| `POST /api/runners/v1/jobs/:id/heartbeat` | `200`                          | Extends the lease (2 minutes; runners beat every 30 seconds)      |
| `POST /api/runners/v1/jobs/:id/complete`  | `200`                          | Stores the result and finishes the job                            |

| File                           | Role                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `api.ts`                       | `createRunnerApi(deps)`: the order of the checks and the three entry points                                                             |
| `claim.ts`                     | The claim: guard, settings, pull request, credentials, the response                                                                     |
| `report.ts`                    | Heartbeat and complete                                                                                                                  |
| `requests.ts`                  | The checks on job id, `X-Runner-Id` and the two request bodies (hand written, kept in line with the contract by the compatibility test) |
| `token-auth.ts`                | The `RUNNER_TOKEN` check (constant time)                                                                                                |
| `redact.ts`                    | Removes anything that looks like a credential from a result before it is stored                                                         |
| `responses.ts`                 | Every answer: `Cache-Control: no-store`, the error form `{ error: { code, message } }`                                                  |
| `claim-guard.ts`, `job-env.ts` | The two hooks (below)                                                                                                                   |
| `contract.ts`                  | The TypeScript types and code lists of the contract                                                                                     |
| `shared.ts`                    | The wiring of the running server (`getRunnerApi()`); the route files under `src/app/api/runners/v1/` only call it                       |

## Authentication

`Authorization: Bearer <RUNNER_TOKEN>` on every call. One shared token in the MVP, read from the
environment on every request. A missing, wrong, empty or differently schemed token, and a server
without `RUNNER_TOKEN` (or with a blank one), all get the same `401 RUNNER_UNAUTHORIZED` answer,
before anything else is looked at. The comparison hashes both sides and compares in constant time, so
lengths and characters do not matter and it never throws. The session guard lets `/api/runners/**`
through (`src/auth/access.ts`): this token is the authentication.

`X-Runner-Id` is a free-form name (letters, digits and `._:@-`, up to 64 characters) that ends up in
`jobs.runner_id` and in the logs. It is bookkeeping, not a security boundary: what proves that a runner
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
2. **LLM access** must be configured (`src/llm/config.ts`: `LLM_PROVIDER` default `openrouter`,
   `LLM_MODEL`, `LLM_API_KEY`). Otherwise the job ends as `failed` with `llm_not_configured`.
3. **The pull request** is read through the provider's `getPullRequest`. A pull request that does not
   exist ends the job with `pr_not_found`, one that is closed or merged with `pull_request_closed`;
   `prUrl` in the response is the URL the provider reports.
4. **Credentials** are created with the provider's `jobAccess`: a new installation token for exactly this
   repository, with the least permissions. This is the only place that does it; nothing is created when a
   job is queued, and nothing is cached or kept. The token is revealed (`revealGitAccess`) into the
   response and the local value is dropped with it.

A job that cannot run for a reason that will not go away (guard, LLM not configured, pull request
gone, connection removed or suspended, repository not part of the installation, permissions missing)
ends as `failed` with a stable code (`CLAIM_FAILURE_CODES` in `claim.ts`), the runner is not told, and
the next job is tried (up to 25 per request, then `204`). A reason that may pass (GitHub rate limiting
or down, the pull request could not be read) gives the job back with `release`: it counts as a lost
attempt like a lapsed lease (3 attempts, then it fails with the reason as its code), waits until the
`Retry-After` time and the runner gets `503`. `Retry-After` is what the platform said (a rate limit),
otherwise 30 seconds, at most 15 minutes. An unexpected error also gives the job back and answers
`500`.

`ask` jobs carry their question as `args: [question]`; the other commands never carry `args`, whatever
text followed the command. An `ask` job with an empty question, or one over 4000 characters, ends as
`job_args_invalid` instead of being handed to a runner that would refuse it.

## Complete

The body is `{ leaseToken, result }`. `result` is what `code-reviewer-run-job` prints, plus an optional
`errorMessage`. `ok` and `errorCode` agree (`errorCode` is `null` exactly when `ok`).

- Stored: the checked result, with every field filled, in `jobs.result`; for `ok: false` the job's
  `error_code` is the runner's code, or `unknown` if the app does not know it (the original stays in the
  result).
- **No secrets are stored.** The runner redacts its own log. As a second line, `redact.ts` removes
  anything that looks like a credential (GitHub tokens, provider keys, bearer credentials) and the exact
  LLM key and runner token from `logTail`, `errorMessage` and `commentUrl` before they are stored. The
  git token is not known to the app after the claim, so it can only be recognised by its shape.
- Repeating the same completion answers `200` with `alreadyCompleted: true`; another result for a
  completed job is `409`. "Same" is compared on the stored form, so leaving out an optional field is
  not a different result.
- A body over 64 KiB is refused with `413` before it is parsed.

## Hooks that other tickets fill in

- **`ClaimGuard`** (`claim-guard.ts`): `check(job)` returns `{ allow: true }` or
  `{ allow: false, errorCode }`. The default allows everything. It exists for projects (CR-5): a job
  whose repository has no active project (the project was switched off after the job was queued) must
  not run. When the CR-5 and CR-6 epics meet, `shared.ts` gets a guard that asks the projects and
  returns `project_deactivated`. A refused job ends as `failed` with that code. (The queue has no
  operation that cancels a claimed job; if `cancelled` is wanted for this case, that is a small addition
  to `src/jobs` at that time.)
- **`JobEnvSource`** (`job-env.ts`): `envFor(job)` returns the extra options of the four PR-Agent tools
  (`PR_REVIEWER__*`, `PR_DESCRIPTION__*`, `PR_CODE_SUGGESTIONS__*`, `PR_QUESTIONS__*`) that become the
  job's `env`. The default is empty. CR-25 (settings) fills it from the project settings. A key outside
  those four families ends the job as `job_env_invalid`, because the runner would refuse it.
- **`src/llm/config.ts`** is the minimum the claim needs; CR-26 owns the module and extends it.

## Before this is used in production

The runner API must not process jobs in production before the trigger policy (CR-31) and the project
gate (CR-24, CR-5) are on the same branch, or old jobs would run with paid model calls
(`src/jobs/README.md`, "For the tickets that build on it"). Until then the default guard allows all.

## Tests

- `integration-tests/http/runner-api-claim.integration.test.ts`, `-report`, `-security` and
  `-route-files`: the real handlers with a real SQLite file and the fake GitHub; the route files with
  the wiring of the running server and a delivery that goes through the webhook route first.
- `integration-tests/compatibility/runner-api-contract.integration.test.ts`: the contract.
- `token-auth.test.ts`, `requests.test.ts`, `redact.test.ts`, `src/llm/config.test.ts`: unit tests.
- The harness is `src/test-support/runner-api-harness.ts`.
