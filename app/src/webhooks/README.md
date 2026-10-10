# Webhooks

`POST /api/webhooks/github-app` is the one webhook URL of the GitHub App: installations, repository
changes, pull requests and comment commands of every installation arrive here. The route file
(`src/app/api/webhooks/github-app/route.ts`) only calls `getGithubAppWebhookHandler()`; the logic is a
function of its collaborators in this folder, so tests wire fakes in.

The route is **public**: it needs no session, and the auth guard must keep letting `/api/webhooks/**`
through. The signature of the delivery is its authentication.

| File                       | Role                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `github-app-handler.ts`    | `createGithubAppWebhookHandler(deps)`: the steps below                                                                                     |
| `limited-body.ts`          | `readLimitedBody`: reads the body as text and stops at the limit, whatever `Content-Length` claims                                         |
| `review-trigger-intake.ts` | `ReviewTriggerIntake`: where a review trigger goes (`enqueueReviewTrigger(trigger, integration)`), and the logging intake used until CR-27 |
| `shared.ts`                | The wiring of the running server: database, registry, the process-wide sync service, the intake. The only file the jobs tickets change     |
| `errors.ts`, `logger.ts`   | The stable error codes of the answers, and the two-level logger                                                                            |

## What happens to a delivery

Each step ends the request when it fails; nothing before step 5 writes anything.

| Step | What                                                                                                                                                                                     | Answer                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1    | Size: more than 1 MiB (`WEBHOOK_MAX_BODY_BYTES`) is refused, by `Content-Length` or while reading                                                                                        | `413` `WEBHOOK_BODY_TOO_LARGE`                                                                          |
| 2    | Signature: `verifyWebhook(null, request)`, HMAC-SHA256 of the exact body, constant time                                                                                                  | `401` `WEBHOOK_SIGNATURE_INVALID`; `503` `WEBHOOK_NOT_CONFIGURED` when the secret is not set            |
| 3    | Shape: `X-GitHub-Event` and `X-GitHub-Delivery` exist and look like names, the body is JSON                                                                                              | `400` with `WEBHOOK_EVENT_HEADER_INVALID`, `WEBHOOK_DELIVERY_HEADER_INVALID` or `WEBHOOK_BODY_NOT_JSON` |
| 4    | Relevance: only `pull_request`, `issue_comment`, `installation` and `installation_repositories` are used; any other event (`ping`, `push`, ...) is answered at once, nothing is recorded | `202` `event_not_used`                                                                                  |
| 5    | Claim: the delivery id goes into `webhook_deliveries`; an id that is already there is a duplicate                                                                                        | `202` `duplicate`                                                                                       |
| 6    | Identify: `identifyWebhook` names the installation; the integration is loaded by `(github_app, externalId)`                                                                              |                                                                                                         |
| 7    | Translate: `parseEvent` gives `review_trigger`, `installation_changed` or `ignored`                                                                                                      |                                                                                                         |
| 8    | Act: a trigger goes through `canTrigger` to the intake; an installation change to the shared sync                                                                                        | `202` with the outcome                                                                                  |

Answers carry only an error code or `{ "status": "accepted", "outcome": ... }`, never the body, a
signature or a secret. Log lines name the delivery id, the event and the outcome, and nothing else.

The outcomes of step 6 to 8 are `trigger_enqueued`, `installation_changed`, `ignored` (a genuine event
that starts nothing, such as `pull_request` `closed`, or a command from a user without write access),
`trigger_not_allowed` (`canTrigger` said no), `integration_disabled` (the installation is suspended or
removed: its own installation events still go through, everything else is not looked at) and
`unknown_installation` (no row for the installation and the event is not an installation event). They
are stored with the delivery.

### Installations the app does not know yet

An `installation` `created` delivery arrives before any row exists. The route lets `parseEvent` read it
with a stand-in integration and hands the `installation_changed` event to
`getIntegrationSync().handleInstallationChange`, which asks GitHub (App JWT) whether the installation
exists and only then creates the row. The route never creates an integration itself and never starts a
second sync service. For every other event an unknown installation is `unknown_installation`, and
GitHub is not asked.

### Failures and redelivery

If anything after the claim fails (the intake rejects, GitHub cannot be asked, the sync reports
`failed`), the claim is removed and the route answers `500` (`503` for a failed sync) with
`WEBHOOK_PROCESSING_FAILED`. The delivery is therefore not remembered, and GitHub's redelivery of the
same id is handled again. GitHub does not retry by itself; "Redeliver" in the app's advanced settings
does. A request that dies without removing its claim blocks the id for
`WEBHOOK_DELIVERY_PROCESSING_LEASE_MS` (5 minutes), after which the next request takes it over.

The answer is sent when the work is done, not before: the work is a handful of calls at most, and a
failure has to reach GitHub as a status code, which work scheduled with `after()` could not do.
GitHub gives up on a delivery after 10 seconds; the GitHub client times out after 15, so a slow GitHub
can make GitHub record a failed delivery even though the work finishes. That is harmless (the
redelivery is a duplicate or repeats an idempotent sync) and is the price of not acknowledging early.
Revisit it when jobs are enqueued by the real queue.

### Deduplication

`webhook_deliveries` (`src/db/migrations/20261010170000_create_webhook_deliveries.ts`, repository
`src/db/repositories/webhook-deliveries-repository.ts`) holds one row per delivery id: the event, the
outcome and when it was received. The claim is a single `insert ... on conflict do nothing`, so of
several simultaneous requests with one id exactly one proceeds; the others answer `202 duplicate`.
Rows older than 7 days are deleted whenever a claim is written. The id alone decides: a redelivery with
a different body but the same id is a duplicate. The same event under a new id (someone pushes
"Redeliver" for an old delivery, GitHub assigns a new id) is a new delivery; deduplicating by pull
request and head commit is the queue's business (CR-27), as `ReviewTriggerIntake` says.

## The review trigger intake

The route hands a `ReviewTrigger` to `ReviewTriggerIntake.enqueueReviewTrigger(trigger, integration)`
and knows nothing about jobs. Until CR-27 creates the jobs table the app uses
`createLoggingReviewTriggerIntake`, which logs kind, command (not its arguments), repository, pull
request number and the first 12 characters of the head commit. CR-27 and CR-31 replace
`getReviewTriggerIntake` in `shared.ts`; the route and its tests stay as they are. The contract of the
intake (what rejecting means, what it may assume) is documented on the type. Whether a repository has
an active project is decided there as well (CR-24), as is skipping drafts (CR-31).

## Testing

`src/test-support/webhook-harness.ts` starts everything the route needs: a real SQLite file, the fake
GitHub API, the real GitHub App provider, a `RecordingReviewTriggerIntake`
(`recording-review-trigger-intake.ts`, which can fail or take its time) and the handler. Tests send
signed requests built by `fakes/github/webhooks.ts` from the recorded payloads in
`fakes/fixtures/github-webhooks/`. `integration-tests/webhooks/github-app-route.integration.test.ts`
covers every behavior above; `github-app-route-file.integration.test.ts` calls the real `route.ts`
with the production wiring.
