# Contracts

Machine-readable descriptions of the interfaces that two parts of the system share. A contract file
is the single source of its format: the code on both sides is checked against the file, never the
other way round, so a change to the format has to change the file and both sides.

| File                         | What                                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner-api.v1.json`         | The wire format of the runner API v1 (JSON Schema, draft 2020-12): the claim request, the claim response, the heartbeat and complete requests and responses, and every error. The `$defs` are the named bodies. |
| `examples/<Definition>.json` | One valid document per body. Both test suites validate them, so an example can never drift from the schema. They hold dummy values only.                                                     |
| `dynamic-review/schema.v1.json` | The neutral findings of a Dynamic Review (#195), before the runner renders them: opaque id, P0–P3, confidence, bounded title/body, a lexically safe repository-relative path, a line range (ordering is the runner's semantic check), evidence references, and the reviewed SHA. Resolutions of earlier findings sit on the run envelope (`resolvedIds`), so a run that leaves no current finding can still report them. No permission, provider, routing, endpoint or command field. `dynamic-review/example.v1.json` and `example-resolved.v1.json` are validated by both suites. |

## Who checks what

- **App** (`app/integration-tests/compatibility/runner-api-contract.integration.test.ts`, with Ajv):
  the real answers of the routes are valid against the file; the hand-written checks on what a runner
  sends give the same verdict as the file for a set of good and bad bodies; the lists the app keeps
  in TypeScript (`app/src/runner-api/contract.ts`: error codes, commands) equal the lists in the file.
- **Runner** (`runner/tests/contract/test_runner_api_contract.py`, with `jsonschema`): the examples are
  valid, and the rules the runner relies on hold (the job input is closed, because the runner refuses
  unknown fields; the only command is `review`; a previous release's review payload — the legacy `args`
  and the removed tools' env families — is still accepted; the error code rules of a result).

## Rules of version 1

- The version is in the path (`/api/runners/v1/...`) and in every response body (`"version": 1`).
  A change that breaks a reader makes a version 2 with its own file; this file only grows in ways
  readers may ignore. #203 follows this: `Command` narrows to `["review"]`, and the removed tools'
  legacy review fields (`args`, `PR_DESCRIPTION__*`, `PR_CODE_SUGGESTIONS__*`, `PR_QUESTIONS__*`) stay
  in the schema so a new runner still accepts a review payload a previous-release app sends.
- A reader ignores fields it does not know. The one exception is `RunnerJobInput` (the job the runner
  reads on stdin), which is closed because the runner refuses unknown fields.
- Callers branch on error codes, never on messages. The codes the runner reports are listed in
  `KnownRunnerErrorCode`; the app accepts any code of the right form and stores one it does not know as
  `unknown` (the original stays in the stored result).
- Secrets (`git.token`, `llm.apiKey`, `leaseToken`) appear in the claim response and in requests that
  prove a claim, and nowhere else.
- #195 grows v1 without breaking a reader: the optional `ClaimRequest` body (`engines`), the optional
  `reviewKind`/`dynamic`/`base` fields of `RunnerJobInput` for a tagged Dynamic job, and the new
  `Engine`, `ReviewKind`, `DynamicReview`, `ClaimBase` definitions and Dynamic failure codes. A
  previous-release app ignores the claim body; a previous-release runner sends none (pr-agent only) and
  never receives the tagged fields, so its closed `RunnerJobInput` parsing is unchanged. The tagged
  union is enforced on both sides: a Dynamic job must carry `dynamic` and `base`, a Diff job (no
  `reviewKind`, or `"diff"`) must not, and a Dynamic `model` uses the same character pattern the runner
  accepts.
- #255 adds the optional `ClaimBase.attemptedShas`. The app leaves the key out when it is empty, but a
  runner from before #255 rejects it when present (`RunnerJobInput` is closed): update the runner
  before or together with the app. The reverse (a newer runner, an older app) is safe: absent means none.
- #257 adds the optional `ClaimBase.attemptedShasTruncated`: `true` when more heads qualified than
  `attemptedShas` holds. The app leaves the key out unless it is true (never sends `false`), and a runner
  from before #257 rejects it when present: update the runner before or together with the app. A newer
  runner with an older app is safe: absent means false, and the publisher stays fail-closed.

### Rolling out Dynamic Review (#195, finding 4)

A previous-release **app** ignores `review_kind` in its claim SQL: on a shared, migrated database it
could hand a Dynamic row to a runner as an untagged Diff payload — a silent fallback. It must never be
able to see a Dynamic row, so Dynamic jobs are only enqueued when the instance setting
`dynamic_review` is `{ enabled: true }` (default off; `dynamic-review-gate.ts`). With the gate off, a
Dynamic project's run is created `failed` with `dynamic_review_disabled`, visible in Runs.

Order:

1. Deploy every app instance with the version that routes by `review_kind` (this change). New runners
   are safe next to old apps.
2. Only then set `dynamic_review` to `{ enabled: true }`, once a Dynamic runner is deployed and
   advertises `opencode` (`docs/dynamic-review.md`, "Activation, step by step").
3. To roll back, keep every app instance on this gate-aware version while calling the instance
   settings repository's `set("dynamic_review", { enabled: false }, operatorId)`. Wait for commit:
   it stops new Dynamic enqueue and cancels **queued** Dynamic jobs with `dynamic_review_disabled`.
   **Running jobs are untouched**: their leases, heartbeats and PR slots stay valid until they finish.
   A release or lease expiry with the gate off fails the job with `dynamic_review_disabled` instead
   of requeueing it, including on the last attempt and for a requested delayed retry.
4. Keep the gate-aware app and runners serving the remaining leases until the Dynamic work finishes.
   Before downgrade, quiesce the runners and verify **all Dynamic engine processes have ended** as
   well as **zero Dynamic jobs in `queued` or `running` status**. If a runner is stopped, terminate
   and confirm cleanup of its engine processes before releasing its claims; handle any expired
   claims with the gate-aware app. Terminal database rows alone do not prove process termination.
5. Only after that boundary may an older app start serving claims. Keep the setting off throughout
   rollback; retain the forward migration and historical Dynamic rows. Resume compatible runners.

Removing the setting is equivalent to disabling it. Use the repository setter, not raw SQL, which
would bypass the lock and cancellation. The operator control is the instance admin's **Dynamic Review**
card on the portal's Instance page (`PUT /api/admin/settings` with `{ "dynamicReview": { "enabled":
boolean } }`, admin only, server side), which calls that setter; it asks the admin to confirm step 1
before it turns the gate on. It is off in every shipped configuration; the activation steps and the
rollback are in `docs/dynamic-review.md`.

### Queue lock order

All queue writers acquire locks in this order, held through commit:

1. **Instance gate transaction advisory lock `(195, 1)`**, before any repository, project, setting
   or job row. Enqueue, project writes and waiting-job cancellation take it shared;
   gate writes/removal and runner mutations (expiry, release, claim, heartbeat, completion and
   claimed cancellation) take it exclusive. This covers a missing gate row as well. A transaction
   that will run a runner mutation must take the exclusive lock first; never upgrade after row locks.
2. **Workspace-scoped repository, then project row**, for producers/settings that need them. Enqueue
   and settings saves retain the same repository `FOR UPDATE` lock from kind resolution through write.
3. **Job rows in ascending `id`**, reserving a multi-row transition's complete live candidate set
   before its first update. Expiry/claim reserve live jobs once before expiry passes and selection;
   disable reserves only queued Dynamic rows. Single-job lease operations touch only their own row.

Runner mutations briefly serialize on the gate, keeping drain and expiry from holding opposing job
rows and making the gate read/lease transition atomic. Locks cover database work only, never engine,
network or credential preparation. SQLite uses its immediate transaction write lock. Callers using
an existing transaction must take the appropriate gate lock before any row locks in that transaction.

The meaning of the calls (status codes, the lease, what happens on failure) is in
`app/src/runner-api/README.md`.

## The job options

- `env` (`JobEnv`) holds options of the PR-Agent tools, one option name per key: the key pattern is
  `PR_<TOOL>__<NAME>` with `NAME` made of upper case letters and digits in groups separated by one `_`
  (never a second `__`, never a trailing `_`). It is the runner's `_ENV_KEY`, and the app's
  `RUNNER_ENV_KEY_PATTERN` (a test compares the app's pattern with this file). Values are text of the
  type of the PR-Agent option (`"5"`, `"true"`); the runner refuses a value that does not fit. The app
  sends only `PR_REVIEWER__*`; a previous release's `PR_DESCRIPTION__*`, `PR_CODE_SUGGESTIONS__*` and
  `PR_QUESTIONS__*` are accepted and ignored (never handed to PR-Agent).
- The runner reserves some options for itself and refuses a job that sets them:
  `PR_REVIEWER__FINAL_UPDATE_MESSAGE`,
  `PR_REVIEWER__ENABLE_REVIEW_LABELS_SECURITY` and `PR_REVIEWER__ENABLE_REVIEW_LABELS_EFFORT`. The app never sends them (a test over the options of the
  review settings checks it).
- `llm.maxTokens` is the token budget of a review. `llm.fallbackModels` (at most five names) is accepted
  by the runner; the app does not send it until a chain is decided, and then `maxTokens` must fit the
  smallest window of the chain.

## Size of a result

A `complete` request must stay under 64 KiB serialized, or the app answers `413` and the job can never
finish (the lease runs out and it is tried again). The largest document the schema allows can exceed
that, because `logTail` (8192 characters) and `errorMessage` (2000) may hold characters that take
several bytes in JSON; with `ensure_ascii` (the runner's output mode) a non-ASCII character takes 6 to 12
bytes. The runner keeps `logTail` at 4 KB. The job loop (CR-29, `job_loop/reporting.py`) sends ASCII-escaped JSON, caps
the result **before** serializing and keeps the body under 48 KB (measured in that form).

## A shutdown is not a result

A runner that is shut down while it holds a job reports `ok: false, errorCode: "runner_shutdown"` with
`complete`. The app gives the job back to the queue instead of finishing it (the answer's `job.status`
is `queued`, or `failed` when that was the last allowed attempt).
