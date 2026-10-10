# Webhooks

`POST /api/webhooks/github-app` is the one webhook URL of the GitHub App: installations, repository
changes, pull requests and comment commands of every installation arrive here. The route file
(`src/app/api/webhooks/github-app/route.ts`) only calls `getGithubAppWebhookHandler()`; the logic is a
function of its collaborators in this folder, so tests wire fakes in.

The route is **public**: it needs no session, and the auth guard must keep letting `/api/webhooks/**`
through. The signature of the delivery is its authentication.

| File                       | Role                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `github-app-handler.ts`    | `createGithubAppWebhookHandler(deps)`: the steps below                                                                               |
| `limited-body.ts`          | `readLimitedBody`: reads the body as text and stops at the limit, whatever `Content-Length` claims                                   |
| `review-trigger-intake.ts` | `ReviewTriggerIntake`: where a review trigger goes (`enqueueReviewTrigger(trigger, integration, source)`)                            |
| `job-queue-intake.ts`      | `createJobQueueReviewTriggerIntake`: the intake of the running app, a thin mapping from a trigger to a job in the queue (`src/jobs`) |
| `shared.ts`                | The wiring of the running server: database, registry, the process-wide sync service, the intake (`getJobQueueReviewTriggerIntake`)   |
| `errors.ts`, `logger.ts`   | The stable error codes of the answers, and the two-level logger                                                                      |

## What happens to a delivery

Each step ends the request when it fails; nothing before step 5 writes anything.

| Step | What                                                                                                                                                                                     | Answer                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1    | Size: more than 1 MiB (`WEBHOOK_MAX_BODY_BYTES`) is refused, by `Content-Length` or while reading                                                                                        | `413` `WEBHOOK_BODY_TOO_LARGE`                                                                                       |
| 2    | Signature: `verifyWebhook(null, request)`, HMAC-SHA256 of the exact bytes received, constant time                                                                                        | `401` `WEBHOOK_SIGNATURE_INVALID` (also when the secret is not configured: the cause is logged once, never answered) |
| 3    | Shape: `X-GitHub-Event` and `X-GitHub-Delivery` exist and look like names, the body is JSON                                                                                              | `400` with `WEBHOOK_EVENT_HEADER_INVALID`, `WEBHOOK_DELIVERY_HEADER_INVALID` or `WEBHOOK_BODY_NOT_JSON`              |
| 4    | Relevance: only `pull_request`, `issue_comment`, `installation` and `installation_repositories` are used; any other event (`ping`, `push`, ...) is answered at once, nothing is recorded | `202` `event_not_used`                                                                                               |
| 5    | Claim: the delivery id is claimed in `webhook_deliveries`; an id that succeeded before is a duplicate, an id another request holds right now is in progress                              | `202` `duplicate`; `409` `WEBHOOK_DELIVERY_IN_PROGRESS`                                                              |
| 6    | Identify: `identifyWebhook` names the installation; the integration is loaded by `(github_app, externalId)`                                                                              |                                                                                                                      |
| 7    | Translate: `parseEvent` gives `review_trigger`, `installation_changed` or `ignored`                                                                                                      |                                                                                                                      |
| 8    | Act: a trigger goes through `canTrigger` to the intake; an installation change to the shared sync                                                                                        | `202` with the outcome                                                                                               |

Answers carry only an error code or `{ "status": "accepted", "outcome": ... }`, never the body, a
signature or a secret. Log lines name the delivery id, the event and the outcome, and nothing else.

The outcomes of step 6 to 8 are `trigger_enqueued`, `installation_changed`, `ignored` (a genuine event
that starts nothing, such as `pull_request` `closed`, or a command from a user without write access),
`trigger_not_allowed` (`canTrigger` said no), `integration_disabled` (the installation is suspended or
removed: its own installation events still go through, everything else is not looked at) and
`unknown_installation` (no row for the installation and the event is not an installation event). They
are stored with the delivery. Anything unexpected before the claim (a stream error, a registry problem)
is logged and answered with a generic `500 WEBHOOK_PROCESSING_FAILED`.

### Installations the app does not know yet

An `installation` `created` delivery arrives before any row exists. The route lets `parseEvent` read it
with a stand-in integration and hands the `installation_changed` event to
`getIntegrationSync().handleInstallationChange`, which asks GitHub (App JWT) whether the installation
exists and only then creates the row. The route never creates an integration itself and never starts a
second sync service. For every other event an unknown installation is `unknown_installation`, and
GitHub is not asked.

### Failures and redelivery

GitHub does not retry a failed delivery by itself. "Redeliver" in the app's advanced settings (or the
API) sends the delivery again **with the same `X-GitHub-Delivery` id**, so the id is how a manual retry
reaches the app, and the rules below make sure it is handled again when that is what the operator
wants:

- Only a delivery that **succeeded** (`trigger_enqueued`, `installation_changed`) stays a duplicate
  (`202 duplicate`, nothing done) for 7 days.
- A delivery that was turned away for a reason that can change (`unknown_installation`,
  `integration_disabled`, `trigger_not_allowed`, `ignored`, for example a pull request delivery that
  raced the `installation.created` sync, or a command from a user who gets write access later) is
  recorded with that outcome for diagnostics, but the id can be claimed again: redelivering it
  handles it anew.
- If anything after the claim fails (the intake rejects, GitHub cannot be asked, the sync reports
  `failed`), the claim is released and the route answers `500` (`503` for a failed sync) with
  `WEBHOOK_PROCESSING_FAILED`.
- A request with an id that another request is handling right now gets `409`
  `WEBHOOK_DELIVERY_IN_PROGRESS`, not `202`: the first one may still fail, and GitHub must then show
  the delivery as failed so it can be redelivered.
- A request that dies without releasing its claim blocks the id for
  `WEBHOOK_DELIVERY_PROCESSING_LEASE_MS` (5 minutes), after which the next request takes it over. Each
  claim has an ownership token and only its owner can complete or release it, so a request that
  stalled past its lease cannot clobber the claim of the one that took over.

The answer is sent when the work is done, not before: the work is a handful of calls at most, and a
failure has to reach GitHub as a status code, which work scheduled with `after()` could not do.
GitHub gives up on a delivery after 10 seconds; the GitHub client times out after 15, so a slow GitHub
can make GitHub record a failed delivery even though the work finishes. A redelivery is then a
duplicate or repeats an idempotent sync. The enqueue is one short local transaction, so the work itself stays well inside that.

### Deduplication and replay

`webhook_deliveries` (`src/db/migrations/20261010170000_create_webhook_deliveries.ts`, repository
`src/db/repositories/webhook-deliveries-repository.ts`) holds one row per delivery id: the event, the
outcome, the owner token of the claim and when it was claimed. The claim is a single
`insert ... on conflict do nothing`, so of several simultaneous requests with one id exactly one
proceeds. Rows older than 7 days are deleted, at most every 10 minutes per process.

**The delivery id is not covered by the signature** (GitHub signs the body only). Replaying a captured
signed body with a fresh id passes the signature check and the delivery dedupe. Replay protection is
therefore the queue's: it deduplicates on (pull request, head commit, command), as
`ReviewTriggerIntake` says. The same event can also legitimately arrive under different ids
(two identical comments).

## The review trigger intake

The route hands a `ReviewTrigger` to `ReviewTriggerIntake.enqueueReviewTrigger(trigger, integration, source)`
and knows nothing about jobs. The intake of the running app is `createJobQueueReviewTriggerIntake`
(`job-queue-intake.ts`, wired in `shared.ts` by `getJobQueueReviewTriggerIntake`): it looks up the
`repositories` row of the trigger's repository and enqueues a job with the delivery id.

- `opened` and `updated` become an automatic `webhook` job for the command `review`; a `command`
  trigger becomes a `comment` job with its command and arguments.
- It is a thin mapping on purpose. It adds **no trigger policy**: whether the repository has an active
  project (CR-24), whether a draft waits, the debounce of `synchronize` (CR-31) are decided around
  it, not in the queue.
- What the queue does with a job (the same delivery gives the same job; one automatic job per pull
  request, head commit and command; a newer commit replaces the waiting job) is described in
  `src/jobs/README.md`. That is the replay protection the signature cannot give: a captured signed body
  replayed under a new delivery id finds the job of the head commit and creates nothing.
- A trigger the queue can never accept (today only: a command whose arguments are over 10 000
  characters) is dropped with an error log line naming the field and code, not the value, and the
  intake resolves. Rejecting would make the route answer `500` and release the delivery, and every
  redelivery would fail the same way. Truncating the arguments is the comment commands ticket (CR-32).
- A trigger for a repository the app has no row for (the delivery outran the synchronization) makes
  the intake reject with `JOB_REPOSITORY_UNKNOWN`; the route answers `500` and releases the delivery,
  so "Redeliver" works after the sync.
- The log line names the job, the outcome (`created` or `existing` with the reason), repository, pull
  request, command and delivery id, never the arguments.

## Testing

`src/test-support/webhook-harness.ts` starts everything the route needs: a real SQLite file, the fake
GitHub API, the real GitHub App provider, a `RecordingReviewTriggerIntake`
(`recording-review-trigger-intake.ts`, which can fail or take its time) and the handler. Tests send
signed requests built by `fakes/github/webhooks.ts` from the recorded payloads in
`fakes/fixtures/github-webhooks/`. `integration-tests/webhooks/github-app-route.integration.test.ts`
covers every behavior above; `github-app-route-file.integration.test.ts` calls the real `route.ts`
with the production wiring; `review-trigger-jobs.integration.test.ts` runs the handler with the real
job queue intake.
