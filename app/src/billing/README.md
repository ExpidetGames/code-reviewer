# Billing module

The place of billing in the app. **Billing is off unless an instance admin switches it on, and a self-hoster who never
does sees no change.** The design is ADR 0006 (`docs/decisions/0006-prepaid-billing-via-stripe-managed-payments.md`,
epic #489): prepaid pay-as-you-go through Stripe Managed Payments, a provider-neutral adapter in front of it. The
earlier subscription design (plans, plan versions, prices with a payment provider, an admin page for them) was deleted
before it reached a release (#491); the model catalog, the providers and `modelAccess` of epic #420 are unaffected.

What is here today is the part every later billing issue builds on, the price of a run (#494), the adapter seam with its event application and the `manual` adapter (#497), the Stripe client (#500), the admin page that switches billing on (#504, below) and the money flow of a job: a hold at claim, the settlement when the job ends and the refusal when the balance cannot hold it (#498, "Reserve, settle, release" below), and the Stripe adapter with the billing profile and the top-up route (#501, below), and the start credit with its abuse protection (#507, "The start credit" below). Server-only: every
source file imports `"server-only"` (`server-only.test.ts`).

| File                                                                                                                              | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.ts`                                                                                                                     | The instance setting `billing_settings`: the switch `enabled`, the `adapter`, the rates, the numbers next to them and the record of the Stripe check (`stripe`). `readBillingSettings` reads a stored value leniently: a field it does not know (a value of the older shape also had an environment, a client token and grace days) is ignored, `enabled` is true only when it is exactly `true`, and a rate that is damaged reads as not set. |
| `rates.ts`                                                                                                                        | The rates and numbers (pure): the bounds, `validateRatesPatch` with the stable codes `factor_invalid`, `rate_invalid`, `reserve_invalid`, `start_credit_invalid`, `low_balance_invalid`, `hourly_limit_invalid`, `billingRatesOf` (the complete rates or null), `billingNumbersOf` (the numbers with their defaults) and `canSwitchBillingOn` (`billing_rates_incomplete`).                                                                    |
| `rates-service.ts`, `settings-store.ts`                                                                                           | The one writer of the rates and numbers: validates, merges into the stored setting under an advisory lock (`db/billing-settings-lock.ts`), keeps the switch, the adapter and the Stripe record as they are. `settings-store.ts` is the read-modify-write both this service and the admin service (#504) go through.                                                                                                                            |
| `outcome.ts`                                                                                                                      | `classifyOutcome`: the end state of a job and its stable codes to `charged`, `minutes_only` or `free`, from an exhaustive table (pure).                                                                                                                                                                                                                                                                                                        |
| `pricing.ts`                                                                                                                      | `priceRun` and `reserveFor` (pure): the two prices of a run and the hold of a job, in whole micro-USD.                                                                                                                                                                                                                                                                                                                                         |
| `journal.ts`                                                                                                                      | The vocabulary of the balance journal (#495): the entry types as an `as const` set, the sign of each, the stable error codes, `validateEntry`. The table checks restate the type and sign rules in SQL; `journal.test.ts` fails when they drift apart.                                                                                                                                                                                         |
| `minutes.ts`                                                                                                                      | Billable minutes (pure, #493): `billableMinutes`, `backstopEnd`, `boundedEnd`, the end sources and `STOP_RETRY_WINDOW_SECONDS`.                                                                                                                                                                                                                                                                                                                |
| `wall-clock.ts`                                                                                                                   | `createWallClockRecorder`: the measure of a job without a VM, where billing is on (#493). `shared.ts` hands it to the platform after the response.                                                                                                                                                                                                                                                                                             |
| `hold.ts`                                                                                                                         | What a hold is made for (#498): the longest a VM lives (the Dispatcher's job timeout plus VM margin, pinned to it by a test in both places) and the Dynamic cost limit (the runner's default).                                                                                                                                                                                                                                                 |
| `claim-billing.ts`                                                                                                                | Billing at the claim (#498): `readClaimBilling` (off, rates incomplete, or on with the rates), `holdOf`, `reserveAtClaim`.                                                                                                                                                                                                                                                                                                                     |
| `claim-key-mode.ts`                                                                                                               | `keyModeAtClaim`: whose key a job runs on, as far as the claim knows. The seam of #496.                                                                                                                                                                                                                                                                                                                                                        |
| `settle-jobs.ts`                                                                                                                  | `settleEndedJobs`: prices the jobs a transaction ended and writes a `release` and, unless free, a `usage` entry (#498).                                                                                                                                                                                                                                                                                                                        |
| `stranded-holds.ts`                                                                                                               | `releaseStrandedHolds` (#591): releases the holds of ended jobs that have none released (a job that ended while billing was off), never charging; run by the switch-on and the sweep.                                                                                                                                                                                                                                                          |
| `start-credit.ts`                                                                                                                 | `ensureStartCredit` / `ensureStartCreditWhileOn` (#507): the one function that grants the start credit, once per GitHub account ("The start credit" below).                                                                                                                                                                                                                                                                                    |
| `late-minutes.ts`                                                                                                                 | `correctLateMinutes`: one `correction` when the real end of a VM arrives within a day and moves the minutes by more than one (#498).                                                                                                                                                                                                                                                                                                           |
| `dispatcher-features.ts`                                                                                                          | Which Dispatchers the app has seen (with and without `vm_lifecycle`) and `canSwitchBillingOnWithDispatcher` (#498).                                                                                                                                                                                                                                                                                                                            |
| `enabled.ts`, `readiness.ts`                                                                                                      | `isBillingOn(db)`: the one reader of the switch (on = the switch is set and the adapter is ready, `readiness.ts`); `readBillingSwitch(db)`: the same with what is missing. `guardBillingRoute`: the first line of every billing route.                                                                                                                                                                                                         |
| `adapter.ts`                                                                                                                      | The provider-neutral seam (#497): `BillingAdapter`, `BillingCapabilities`, the normalized `BillingEvent`s, `WebhookResult`, the code constants (USD, the top-up range 10 to 500), the registry and `validateBillingEvent`.                                                                                                                                                                                                                     |
| `apply-event.ts`                                                                                                                  | `applyBillingEvent`: the one place where a normalized event becomes money (#497).                                                                                                                                                                                                                                                                                                                                                              |
| `topup-intent.ts`                                                                                                                 | The vocabulary of a top-up intent: states, codes and the shape the app sees.                                                                                                                                                                                                                                                                                                                                                                   |
| `manual-adapter.ts`, `manual-credit.ts`                                                                                           | The `manual` adapter and the service an operator's credits and corrections go through (#497).                                                                                                                                                                                                                                                                                                                                                  |
| `webhook-handler.ts`, `active-adapter.ts`, `shared.ts`                                                                            | The generic handler behind `POST /api/billing/webhook`, which adapter is active, and the wiring (#497); `shared.ts` also hands the wall-clock recorder to the platform (#493).                                                                                                                                                                                                                                                                 |
| `public-url.ts`                                                                                                                   | Whether an address can be reached from the internet (https, no credentials, no loopback, private, link-local or local name; pure), and the one spelling addresses are compared in. A Stripe webhook endpoint needs it.                                                                                                                                                                                                                         |
| `stripe-client.ts`, `stripe-schemas.ts`                                                                                           | A thin typed `fetch` client of the Stripe API and our own schemas of the fields we read (#500); no SDK. Used by the Stripe adapter (#501) and the webhook route (#502).                                                                                                                                                                                                                                                                        |
| `stripe-webhook-verify.ts`                                                                                                        | `verifyStripeSignature` (pure): the `Stripe-Signature` header over the raw body bytes (#500).                                                                                                                                                                                                                                                                                                                                                  |
| `stripe-adapter.ts`, `stripe-credentials.ts`                                                                                      | The Stripe adapter (#501): `ensureCustomer` and `createTopUpCheckout` over the client, and the client made from the stored key when a top-up needs it.                                                                                                                                                                                                                                                                                         |
| `profile.ts`, `profile-service.ts`                                                                                                | The billing profile (#501): validation of what a person typed (pure, stable field codes) and the service that lets an Owner and an Admin read and write it.                                                                                                                                                                                                                                                                                    |
| `topup-service.ts`, `topup-http.ts`, `topup-limits.ts`                                                                            | Starting a top-up (#501): the checks in order, the handler behind `POST /api/w/:workspace/billing/top-ups` and its limit.                                                                                                                                                                                                                                                                                                                      |
| `admin-service.ts`, `admin-credit-service.ts`, `admin-http.ts`, `admin-errors.ts`, `enabling-copy.ts`, `stripe-webhook-events.ts` | The billing page of the admin portal (#504): the settings service (adapter, credentials, rates, connection check, webhook endpoint, the switch), the manual credit, the handlers of the data routes with their stable codes, the wording of the enabling statement, and the events Stripe is told to send. The page itself is `src/admin/ui/billing-*` and `src/app/(app)/instance-portal/billing/`.                                           |

## The Stripe client and the webhook verifier

The first real adapter (#501, #502) talks to Stripe through `stripe-client.ts` and trusts a webhook only after
`stripe-webhook-verify.ts` has checked its signature. Neither knows a workspace, a journal or a page (#500).

- **No SDK.** A `fetch` client of the dozen endpoints we use (customers with tax ids, Checkout sessions, payment intents,
  charges, refunds, webhook endpoints, the account), form-encoded as Stripe wants it, with our own zod schemas of only the fields
  we read (`stripe-schemas.ts`): a field we do not list cannot reach the app, a listed one with another type is refused
  (`invalid_response`). Nothing personal is read (no email, address or card).
- **Base URL.** Injected, no default: the client reaches no host it was not given. `STRIPE_API_BASE_URL` is Stripe's one
  address (the same for test and live); a test passes the address of `fakes/stripe`. Plain `http:` is accepted for the loopback
  only (`localhost`, `127.0.0.0/8`, `::1`); any other host must be `https:`, or the client is not configured
  (`invalid_configuration`): the key is a bearer token.
- **API version.** Every request pins `Stripe-Version: 2025-03-31.basil; managed_payments_preview=v1`
  (`managedPayments: false` leaves the preview flag out). Checkout also needs `managed_payments[enabled]=true` in the body and
  an eligible product `tax_code`; `CreateCheckoutSessionInput` has no field for what Managed Payments does not support
  (`tax_id_collection`, `invoice_creation`, `customer_update`, `payment_method_types`, `custom_text`), so none can be sent by accident.
- **The key and its environment.** The environment is read from the prefix (`sk_test_`/`rk_test_` is `test`, `sk_live_`/
  `rk_live_` is `live`, anything else is none). Stripe has one address for both, so the caller states the environment it is
  configured for (`environment`); on a Stripe host a key of another environment, or of an unknown prefix, throws
  `environment_mismatch` when the client is made, and the environment is required. A Stripe host is judged by the parsed host,
  not by the text: `stripe.com` and everything below it, in any case, with trailing dots or percent-escapes
  (`api.stripe.com.`, `API.STRIPE.COM%2e:443`). Only a host that is not Stripe's (the fake on the loopback) accepts any key.
- **Idempotency.** Every POST carries an `Idempotency-Key`: the caller's (`{ idempotencyKey }`; #501 derives it from the top-up
  intent), or a fresh one made for the call and kept for every retry of it. That is why a POST may be repeated after a lost
  answer or a 5xx and still creates one object. For the two calls that move money, `createCheckoutSession` and
  `createRefund`, the key is a required argument (`MoneyWriteOptions`; the type refuses a call without it), because a key made
  per call would not survive a restart of the caller.
- **Retries.** A 429 is retried after `Retry-After` (default 1 s, at most 30 s, else it fails at once); a 5xx, a lost connection
  and a timeout are retried with 0.5 s, 1 s, ... unless Stripe says `Stripe-Should-Retry: false`; any other 4xx is never retried. Two
  retries by default (`maxRetries`). The wait is injectable (`sleep`).
- **Limits.** 10 s for a request, all of it (connect, answer, body); no redirect is followed (`redirect_refused`); a body past
  2,000,000 bytes is refused (`response_too_large`), also while it streams; a list is followed for at most 20 pages.
- **Errors.** `StripeClientError` with a code of `STRIPE_CLIENT_ERROR_CODES` (`invalid_configuration`, `environment_mismatch`,
  `invalid_argument`, `timeout`, `network_error`, `rate_limited`, `bad_request`, `idempotency_conflict`, `unauthorized`,
  `forbidden`, `not_found`, `conflict`, `rejected`, `server_error`, `invalid_response`, `response_too_large`, `redirect_refused`),
  the HTTP status, and Stripe's own `type` and `code` when they are plain identifiers (`stripeCode: "resource_missing"` tells a
  buyer's deleted object from other 404s; the journal tolerates it). Fixed texts; **no response body, no header, no key and no
  cause** in an error, and the client logs nothing. A customer Stripe reports as `deleted: true` is `not_found`.
- **Secrets.** `stripe_api_key` and `stripe_webhook_secret` are names in `SECRET_NAMES` (encrypted, write-only like the others);
  the billing page sets them (#504).
- **The verifier.** `verifyStripeSignature({ header, rawBody, secret, now, toleranceSeconds })` returns `{ ok: true, timestamp }`
  or `{ ok: false, code }` with a code of `STRIPE_SIGNATURE_ERROR_CODES` (`secret_missing`, `signature_missing`,
  `signature_malformed`, `signature_mismatch`, `timestamp_out_of_tolerance`, `tolerance_invalid`). It takes the body as the
  bytes received, accepts several `v1` values (Stripe sends two while a secret is rotated) and ignores `v0` and unknown
  schemes, compares every candidate in constant time, checks the signature **before** the age (a message with a bad signature
  never learns whether it was also old), and refuses a timestamp too far in the future as well as one too old. The tolerance
  is a parameter (default 300 s; `NaN`, infinite and negative are refused); an empty secret is refused. Replay inside the
  tolerance is stopped by the dedupe on the event id (#502).
- **The fake.** `fakes/stripe/` (see `fakes/README.md`); a test starts it with `startTestStripe` and gets a client with
  `clientFor(fake)` (`app/src/test-support/stripe-fake.ts`).

## The price of a run

All money is a whole number of micro-USD (1 USD = 1,000,000). No floating point touches an amount: the arithmetic is
BigInt, the result must fit the safe integer range (a larger one is refused with `pricing_amount_overflow`, never
wrapped), and a price is never negative. The worked numbers below are made up; no rate of an operator is in the repository.

```
aiPrice    = key mode managed, class charged, cost known ? round(cost x A / 10,000) : 0
infraPrice = class free ? 0 : billableMinutes x B[reviewKind]
total      = aiPrice + infraPrice
```

- **A** is stored in parts per 10,000 (1.2 is 12,000; at least 10,000, at most 1,000,000). **B** is micro-USD per started
  minute, one per review kind (0 allowed, at most 10,000,000). The **AI reserve of a Diff review**
  (`diffAiReserveMicroUsd`, 0 to 50,000,000) is the AI part of its hold. A, both B and the reserve have **no default**
  and are all required: billing cannot be switched on before they are set (`canSwitchBillingOn`,
  `billing_rates_incomplete`).
- **The reserve is real model cost.** It is in micro-USD of real model cost, before A, the unit of the Dynamic cost limit,
  and the hold multiplies it by A. Changing A therefore never changes the real-cost margin of a hold. The admin form (#504)
  labels it "real model cost, before the factor". _Guidance, not a default:_ the #492 estimate for a Diff review is
  about 150,000 (0.15 USD of real cost, Sonnet-class: the largest run measured was 0.1004 times 1.5); about 370,000 if an
  Opus-class model joins the catalog. At A = 5 the first is 0.75 USD of hold.
- **Rounding.** The AI price is `cost x A / 10,000` rounded **half up** to a whole micro-USD, once per run, on the whole
  cost. The infrastructure price is whole started minutes times a whole rate, so it is exact and needs no rounding;
  minutes that are not whole are refused. The two are separate amounts, each computed alone, and the total is their sum.
- Example (made up): cost 1,000,000, A 12,000, 3 minutes, B 10,000 gives AI 1,200,000 and infrastructure 30,000.
- **No minimum.** A run that costs nothing and needs no minute charges nothing.
- A run that cannot be priced (a fact that is no whole, non-negative number, rates that are not valid, an amount beyond
  the safe range) throws a `PricingError` with a stable code; the settlement of #498 releases the hold of such a run, charges nothing and logs `BILLING_PRICING_FAILED` with the job id and the code (a customer is never charged a number nobody could compute, and money is never left held).

### The hold

`reserveFor` is the hold of ADR 0006, D6: the longest the VM lives (rounded up to a started minute) times `B[kind]`, plus,
on the managed key, `round(AI budget x A / 10,000)`, where the AI budget is the cost limit of the job for Dynamic and
`diffAiReserveMicroUsd` for Diff (both real model cost, multiplied by A). A bring-your-own-key job holds the minutes only.
A hold is not a price: settlement charges what the run really cost, even above the hold.

`reserveFor` returns the **full** hold. Decision 5 of #489 (reserve at most the available balance; the final charge may take
the balance slightly negative) is applied by the claim (`reserveAtClaim`, #498) through the journal's `reserveUpTo`, that is
`min(hold, available)`, so that there is one interpretation of it. A hold is never clamped here.

### The classes of an outcome

| Class          | AI price                                  | Infrastructure price |
| -------------- | ----------------------------------------- | -------------------- |
| `charged`      | yes, on the managed key with a known cost | yes                  |
| `minutes_only` | no                                        | yes                  |
| `free`         | no                                        | no                   |

The rule is the maintainer's decision of 2026-10-19 (#489, #523): **a run is `free` only when the failure is clearly our
fault; everything else is `charged` in full (AI and minutes).** `minutes_only` is used for one thing only: a run whose AI
cost is unknown (`RunEnd.aiCostKnown === false`), because the AI part cannot be priced. No code, reason or settled reason
maps to it.

`classifyOutcome` maps the end of a job to a class.

- `free`, our fault: the launch failed, the VM or the Worker died, the lease ran out, the runner shut down or failed, our
  infrastructure (the Dispatcher, a runner, the Dynamic engine, the isolation, GitHub's availability and rate limit for our
  App, a checkout that failed on our transport) was unavailable, and **every timeout** (the queue's `timeout`, the runner's
  and, on the managed key, `llm_timeout`). The key, the account, the model, the rate limit, an outage and a timeout of the
  managed key are ours when it fails (`llm_auth`, `llm_quota`, `llm_rate_limit`, `llm_unavailable`, `llm_timeout`, ...) and
  the customer's on their own key. Also free: `no_capable_runner`, `dynamic_review_disabled`, `entitlements_invalid` and
  `dynamic_config_invalid` (missing job options, missing model prices or an invalid operator environment, raised before any
  model call: the operator's side; the job never ran), and the four refusals of the claim for billing (`balance_negative`,
  `insufficient_balance`, `billing_rates_incomplete`, `billing_hold_released`: nothing ran).
- `charged`, everything else: a delivered result; a run that failed, including the `AI_COST_FAILURE_CODES` group
  (`command_failed`, `dynamic_budget_exceeded`, `dynamic_policy_violation`, `llm_bad_request`,
  `llm_context_length_exceeded`); a run stopped at a cost or time limit; a run that ended without a result (`no_result`,
  `review_not_published`, `llm_output_invalid`, a process the loop of a runner had to end); a run cancelled or superseded
  by a new commit; `git_auth` and `git_forbidden` (a revoked installation or our own App token: not clearly ours); and a
  code or checkout reason the build does not know. It never throws.
- A job that **never ran** (superseded or cancelled while queued, or refused at claim by `workspace_suspended` or
  `quota_exhausted`) is `charged` and prices to **0**: it has 0 billable minutes and no cost, so nothing is billed whatever
  its class.
- A run with an **unknown AI cost** that would be `charged` is `minutes_only`; one that is `free` stays free.

When several facts apply (the code, a finer reason, the settled reason of the usage record) the cheapest class for the
customer wins, so a run that was our error and also left no result is ours.

The table is exhaustive over today's terminal codes: the job end codes, the release reasons, the error codes and checkout
reasons of the runner contract, the reasons of the loop of a runner and the settled reasons. `outcome.test.ts` fails when
one of those lists gains a code with no class, so adding a code means deciding who pays for it.

## Billable minutes (#493)

The infrastructure price is `billable minutes x B` (ADR 0006, 2.4 and 2.11); this part **only measures**. It sets no price
and writes no journal entry, and #498 reads it when it settles. The table is `job_vm_runs` (workspace-scoped:
`db/repositories/job-vm-runs-repository.ts`): one row per VM the Dispatcher reported, with the raw timestamps for audit
(`started_at`, `reported_at`, `ended_at`), where the end came from (`end_source`), the VM's own timeout, the claim it was
started for and the whole minutes (`billable_minutes`, an integer). `measure(jobId)` is the one answer #498 needs:
`{ state: "not_ended" }` while the job runs, else `{ state: "measured", minutes, run }`, where `run` is the run that counts
(null and 0 minutes when no VM or Worker ever ran for the final claim).

**Started minutes.** `ceil((end - start) / 60 s)`, at least 1 once a VM exists, 0 when none does (`minutes.ts`; a test pins 0 s,
1 s, 59 s, 60 s, 61 s and 3,600 s). The price takes this integer as `billableMinutes` (#494).

**Where the start is recorded.** The Dispatcher creates the VM and is the only party that knows when. It tells the App right
after `Sandbox.create` returned, with `POST /api/runners/v1/jobs/:id/vm` (`vm_lifecycle`; `runner-api/README.md`). The report
is the Dispatcher's dispatcher token plus the job credential it holds during the launch (the VM and the Worker cannot call it),
a closed body, idempotent (the first report of a VM wins) and accepted only while that credential holds the running claim.
`started_at` is the Dispatcher's clock **kept between the claim and the moment the report arrived**: a skewed or wrong clock can
shorten or lengthen a VM by at most the launch, never by hours. A report that does not arrive (the call failed, an old
Dispatcher) leaves no row and the job measures 0 minutes: deploy the Dispatcher before billing is switched on.

**Where the end is recorded.** The reaper does not tell the App, and the VM timeout is only the platform's backstop, so neither
can be the source. The source is **the answer to the App's own stop call (#487)**: the Dispatcher's `202` now names the VMs it
is stopping (`vms`), and the App's clock at that moment is the end (`app_stop_confirmed`). The answer comes before the
platform has finished stopping a VM with a running container (20 seconds or more), so the measure is that much shorter than
the platform's own bill, in the customer's favour; a report of the finished stop is a follow-up. When no answer names the VM
(the stop call failed after its retries, a Dispatcher of the previous release answered `404`, the answer was `no_vm` or a
replay, the App went down) `measure` applies the **backstop**: `min(job end + 60 s, start + the VM's timeout)`
(`timeout_backstop`). Why: a VM that is still up after the job ended and our stop had its window is up because our stop did not
work, and that is our error; billing it up to the VM's timeout (35 minutes for a Diff job) would charge the customer for it.
The VM's timeout is the hard cap, so a missing teardown can never make a bill unbounded. A confirmation that arrives after a
backstop was applied replaces it (it is better evidence), bounded by the same cap; nothing else ever changes an end.

**Several VMs for one job.** Every VM is stored. The one that counts is **the VM of the claim that produced the final outcome**
(`billable`): a job claimed again after a lost attempt (a failed launch, a lapsed lease) gets a new claim, and the VMs of
earlier claims are our fault ("an error on our side is free") and are never billed, even if the final claim never created a VM
(then the job measures 0 minutes). A second VM reported for the same claim is kept but does not count. The claim is identified by
`jobs.claimed_at`, which a job keeps after it ends and which every claim sets anew; the attempt number alone is not reliable
(`complete` and `timeout` do not count a lost attempt, a failed release does).

**No VM: self-hosted and Compose.** There is none to measure. Where billing is on (`isBillingOn`), the job's wall clock on a
runner (the claim of the settled attempt to its end) is recorded with `end_source = job_wall_clock` when its claim ends
(`wall-clock.ts`, through the queue's `onClaimsEnded`); with billing off nothing is read or written. A job a Dispatcher
acknowledged is left to its VM. An operator who does not want to charge for it sets B to 0. VM rows themselves are stored
whether or not billing is on: it is one insert per hosted job, it reads no billing table, and it means a billing switch has
history.

**Edge: a superseded run that drains.** Its job is final when the push replaced it, while its Worker finishes a few model
requests; its VM ends with the claim, which the stop call reports, so a confirmed end is right. Only the backstop (no
confirmation) counts from the job's `finished_at`.

## Reserve, settle, release (#498)

While billing is on, the money of a job moves in three places, all inside a transaction the queue already runs. With billing off
**no money moves, and nothing reads or writes a billing table** (`claim-billing.integration.test.ts` checks that no statement of a claim and
a completion names one). What billing off does add, exactly:

- **one read of the instance setting `billing_settings`** per claim that reaches a candidate job (`readClaimBilling`, once per claim
  transaction), per `settleEndedJobs` call that has job ids, and per answer to a stop call (`correctLateMinutes`); with a Stripe adapter
  and the switch set it also looks for the two Stripe secrets by name, which is not the case while the switch is off;
- **`RETURNING job_id`** on the statements that end a usage record (`voidEndedJobs`, the sweep and the closing of records), to know which
  jobs ended;
- for a claim that names `worker_credential` (a Dispatcher): **one read of `dispatcher_sightings`**, and a **write of it at most once an hour
  per kind** of Dispatcher (`noteDispatcherClaim`, inside a `try`/`catch`: a failure logs `DISPATCHER_NOT_NOTED` and never delays or fails a
  claim). This runs also while billing is off, because the sighting must exist before an admin switches billing on.

The usage records, the claim and the operator feed are otherwise exactly as before.

**Reserve (`claim-billing.ts`, called from `claimNext` after the admission of the entitlements and before the usage record).**
The hold is `reserveFor`: the longest the VM lives (`hold.ts`: the Dispatcher's default job timeout plus its default VM margin, 25 minutes,
rounded up to a started minute) times B of the kind, plus, **on the operator's key only**, the AI budget times A: the cost limit of a Dynamic
job (`DYNAMIC_COST_LIMIT_MICRO_USD`, the runner's default of 1.00 USD; the app does not know an operator's own `RUNNER_DYNAMIC_MAX_COST_USD`, so
a higher one only makes the hold smaller than its real maximum) or the admin's Diff AI reserve. The key mode is `keyModeAtClaim` (the key mode
of the entitlements the claim has read, as the LLM access resolves it; the seam of #496). The journal's `reserveUpTo` takes `min(hold, balance)`
(decision 5 of #489, "option b" of the maintainer on #489): any positive balance holds `min(hold, balance)` and the job runs, only a balance of exactly zero is refused (`insufficient_balance`), and the final charge may take the balance below zero. ADR 0006 (D8, 2.8) and the case #498-T03 still say "refuse below the hold"; they are updated on #490. Refusals fail the job with
the stable codes below, count no attempt, leave **no usage record and no entry**, and are reported to `onRefused` like the refusals of the entitlements:

| Code                       | When                                                                                                                       | Notice |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| `insufficient_balance`     | the balance is zero: nothing can be held                                                                                   | yes    |
| `balance_negative`         | the balance is below zero (a refund, a chargeback or a final charge above the hold took it there), also for a hold of zero | yes    |
| `billing_rates_incomplete` | billing is on and a rate is missing, or the switch is set and the adapter is not ready (`isBillingOn` is false)            | no     |
| `billing_hold_released`    | a job claimed again whose hold was released already: it must not run as if it were paid                                    | no     |

A hold of zero (the workspace's own key and B = 0) writes no reservation, but a balance below zero still refuses. A job that is claimed again after
a lost attempt keeps its one hold and its one usage record (`reservation` is keyed by the job).

**The notice.** `insufficient_balance` and `balance_negative` are in `NOTICE_CODES` (`refusal-notices/`): one comment on the pull request,
"Add credit to continue", naming no amount, rate, formula or model, linking to the workspace settings (the balance page of #505 will take
the link over). It is one per pull request **head** (`head:<sha>` in the `period_start` column, `notice-key.ts`), so a new push after a top-up that
was not enough is told again and the same head is not told twice. The check of the column took two more codes (migration
`20261021090000_widen_refusal_notice_codes`).

**Settle (`settle-jobs.ts`, `settleEndedJobs`).** Called with the ids of the jobs whose usage record just reached its end, in the same
transaction, from every place that does it: `complete` (a result, also the report of a superseded run), `closeRecordsOfEndedJobs` (a lease or
runtime that ran out, a release on the last attempt, a cancel of the claim, the drain of a superseded run that never reported, the expiry of a
queued job), `voidEndedJobs` (`cancelWaiting...`, the replacement in `enqueue`) and the switch-off of Dynamic Review. For each job that took a
hold and has none released yet it reads the usage record (key mode, real cost, settled reason), classifies the end (`classifyOutcome`, with
`aiCostKnown` from `usage_records.cost_micro_usd !== null`: one source of truth), measures the minutes (below), prices the run (`priceRun`) and
writes, in one transaction with the end of the job, a `release` of the hold and, unless the price is zero, a `usage` entry with its AI and
infrastructure parts. A `free` run is not even measured. Because the key of an entry is the job, a completion delivered twice, a sweep after it
and a requeue change nothing (`settle-jobs.integration.test.ts`, case T13). The usage record and the operator feed keep the **real** model cost; the
journal holds the price.

- The price is charged in full even above the hold: the balance may go below zero (a Diff run whose cost passed its reserve; a Dynamic run whose
  result says `usage.limitExceededBy`, the documented bound of the cost guard), and then every claim is refused `balance_negative` until credit
  arrives. Settlement never takes `min(cost, hold)`. The final-call exemption of the cost guard (a run never ends without a review) is the
  runner's; billing only prices what the run reports.
- A job that **never ran** has no minutes and no cost and prices to zero: only the `release` is written.
- A superseded run with **no error code** (its Worker reported a result, or the run was drained) is charged in full, AI and minutes; one that never
  reported within window and grace is charged its minutes only, up to the push plus a minute (the end of the drain is not counted; accepted). A
  superseded run that **carries an error code** is classed by that code like any other end (`classOfEnd` in `outcome.ts`), so a code that is ours
  (`runner_error`, `launch_failed`, ...) makes it free. That is the behaviour today; whether it should be charged in full instead awaits a
  maintainer decision.
- A job whose billing was **off at the claim** has no hold and is never settled, even if billing is switched on while it runs. A job whose
  billing is switched **off after** its claim ends without a settlement (none runs while billing is off): its hold stays in the journal
  until it is released (next section).

**Holds of jobs that ended while billing was off (`stranded-holds.ts`, #591).** A run that ended while billing was off is **released, not
charged**: billing off means no charge, and the customer was shown no price for that time. (This is the safe default; the maintainer
confirms it on #591. If they want the run charged, the change is the one `release` in `releaseStrandedHolds`: hand the job ids to
`settleEndedJobs`, the one interpretation of the price.) `releaseStrandedHolds(db, now)` finds the `reservation` entries of **jobs that
have ended, have no `release` and whose usage record is no longer `reserved`** (`findStrandedHolds`) and gives each hold back with
the journal's `release`: one `release` entry, no `usage`, so the balance is whole again and `reserved` falls by the hold. A job that is
still running, queued again after a lost attempt, or already settled is never touched, and neither is a **superseded run that still drains**:
its job is `superseded` at once, but its usage record stays `reserved` until its Worker reports or the drain window and the grace run out, and
that settlement (a `release` and the `usage` of what the run used) is still to come; releasing it earlier would lose the charge. Every job that
ends closes its record in the transaction that ends it, so "the record is no longer `reserved`" means that nothing is left to settle the
hold. The finder works in two steps so that the work grows with the holds that are open and not with the journal: (1) the workspaces whose
`reserved_micro_usd` is more than the holds that belong to a `reserved` record explain (the partial index of the reserved records, the unique key
of the journal, and the partial index `billing_balances_reserved` of the balances that hold something), which is none in steady state;
(2) only for those workspaces, their open reservations of ended jobs. A workspace whose cache says more is reserved than its holds explain, and
that has no stranded hold (a job row is gone, a damaged cache), takes step 2 in every run; `verify()` is where it shows. It runs in two places:

- **When billing is switched on**, in the transaction that writes `enabled` (`admin-service.ts`, under `lockBillingSettings`): billing is
  never on with the money of an ended run still held, and a refused switch-on releases nothing (the transaction does not commit).
- **In the sweep while billing is on**: the step `billing_holds` of the cron sweep of a hosted deployment, and the hourly timer of a server
  (`maintenance/startup.ts`), through `releaseStrandedHoldsWhileBillingOn`, which reads only the switch while billing is off. It catches a
  job that ended in the same moment the switch-on committed (the switch-on's transaction does not see it), and any other leftover.

Both are idempotent and safe next to settlement and claims: every release goes through the journal's `release`, which takes the lock of
the workspace's balance row first and writes under the key of the job, so a settlement racing it either finds the release (and charges
nothing) or wrote its own (and the release finds it); a claim only ever takes a hold under another job's key. At most 500 holds a run
(`STRANDED_HOLDS_BATCH`); the rest goes with the next run. **Lock order.** The balance row of a workspace is locked at the first release
of its job and held until the transaction ends, so the switch-on (up to 500 holds, in the order workspace, then job) and `settleEndedJobs`
(the jobs of one transaction, in the same order: workspace, then job) lock the workspaces in one global order, and two such transactions cannot each
wait for a row the other holds. A hold of a job whose row is gone is not found (the journal keeps opaque job ids).
The log line is `[billing] BILLING_HOLDS_RELEASED count=<n>`. **`verify()`** counts the stranded holds of the workspace
(`strandedHoldCount`, `strandedHoldMicroUsd`) and is not `consistent` while there is one. A job that is still running when billing is switched
off and ends after it is switched on again settles as any other (billing is on when it ends).

**Late minutes (`late-minutes.ts`).** A job settles with the best end of its VM known when it ends (the confirmed stop, else the bounded backstop).
When the answer to the App's stop call arrives later (`dispatch/stop.ts`, after `confirmStopped`), within a day of the settlement, and the started
minutes differ by more than one, **one** `correction` (key `late-minutes:<job id>`) moves the difference at the rate the run was charged at;
otherwise the settlement stands. A stop that answers late is our error (#493), so the correction **never charges beyond the backstop** (the job's
end plus 60 seconds, bounded by the VM's timeout, `lateMinutesTarget`): a measure above it counts as the backstop, and a measure below the settlement
credits the customer (#498-T14, T24). A job that was never charged has nothing to correct.

**Hosted jobs never measure zero minutes silently** (the gate of the review of #524, B-1). `settleEndedJobs` asks `measure`; a charged run with
a claim and no VM row of it falls back to its claim wall clock: `claim_wall_clock` when a Dispatcher acknowledged the job (a VM was started and its
report was lost, or the Dispatcher is of an earlier release), `job_wall_clock` for a runner with no VM (also the Compose and self-hosted rule). A stop
answer that names a VM of our own naming for the job (`cr-<kind>-<job id>-...`) that has no row creates it (`app_stop_unreported`, from the claim to
the stop, at most the longest a VM lives); a better end (a VM's own) wins over a wall clock in `measure`. A claim keeps at most four VMs (N-1). A late
`/vm` report for a claim that already ended stays refused (customer-friendly). The Dispatcher names `vm_lifecycle` in its claim and the app notes when
it last saw a Dispatcher with and without it (`dispatcher-features.ts`, the instance setting `dispatcher_sightings`, at most once an hour per kind);
`canSwitchBillingOnWithDispatcher` refuses with `dispatcher_lacks_vm_lifecycle` while one without it has claimed within a day; the switch-on of the
admin page asks it inside the same `lockBillingSettings` transaction that writes `enabled`, next to the readiness of the adapter, and names the item in
`missing` (#498-T19).

## The switch

Billing is **on** when the instance setting `billing_settings.enabled` is exactly `true` **and the active adapter is ready**
(`isBillingOn`, `readiness.ts`; #504). Ready means, for every adapter, that A, both B and the Diff AI reserve are set, and for
`stripe` also that the API key and the webhook secret are stored and a connection check passed. The passing check is a record in
the setting (`stripe.checkedAt`, with the environment of the key): the switch reader may not call Stripe, so the admin page makes
the check and the setting remembers it. A new API key clears the record; a check that fails never does, so a click during a
Stripe outage cannot turn billing off. The switch reader looks for the two Stripe secrets by name in the secret table and does not
decrypt them: whether they can be read is judged when they are saved, at the connection check and on the page ("cannot be
read"). It calls nobody. **There is exactly one reader of the switch**; a test (`src/ci/billing-cleanup.test.ts`) fails when a
second one appears. Every billing route, page and sweep step asks `isBillingOn` first: while it is false they are inert, a route
answers the 404 of a path that does not exist (`guardBillingRoute`, Next.js's own `notFound()`), no billing table is read and
nobody is called.

**Switch set, adapter not ready (and incomplete rates).** `readBillingSwitch(db)` answers `{ enabled, missing, rates }` from one
read: `isBillingOn` is `enabled && missing.length === 0`. The state "set, but not ready" (a rate or a credential that is gone
since the switch was set, which the admin page does not allow but a damaged database can show) is **off for `isBillingOn`**, so
a route is inert; the claim of a job (#498, `readClaimBilling`) tells it from off and refuses the job with the stable code
`billing_rates_incomplete` (the closest existing code: a new job error code would widen the check of the jobs table and the
refusal notices for a state the operator has to repair; the Runs page says so, the pull request gets no notice, it is the
operator's side), so reviews do not run free and no hold is taken while `isBillingOn` is false
(`jobs/claim-billing.integration.test.ts`, #498-T15 and #498-T18). The admin page shows "the switch is on, but billing is not
running" with the list. To keep the state from arising, the switch-on in `admin-service.ts` judges `missingItemsOf` (the
rates) and `canSwitchBillingOnWithDispatcher` (a Dispatcher that does not report `vm_lifecycle` and claimed within a day,
`dispatcher_lacks_vm_lifecycle`) inside the same `lockBillingSettings` transaction that writes `enabled`
(`admin-billing.integration.test.ts`, #498-T19). Text in `billing_settings` that is no JSON reads as not set, on the claim
path too (#498-T23).

There is no environment variable: billing is configured in the admin portal and in nothing else, so `.env.example` and
the deployment files stay as they are for a self-hoster (`no-environment-variable.test.ts`).

The credentials of Stripe are the encrypted, write-only secrets `stripe_api_key` and `stripe_webhook_secret` of the secret
store (`src/secrets/`, ADR 0006 2.14). A row of a removed secret name that an old database still holds is not read, not listed
and not an error.

## The billing page

`/admin/billing` (data routes below `/api/admin/billing`; `src/admin/README.md` has the guards), instance admin only. Opening it
changes nothing and calls nobody; a self-hoster who never opens it sees no change, no new route that answers and no outbound call.

- **The switch.** `PUT { "enabled": true }` reads everything again, the stored credentials too, in one transaction under
  `lockBillingSettings` (`settings-store.ts`; the service gets the secret store on that transaction, `secretsOn`) and writes the
  switch only if `missingItemsOf` is empty. Saving or removing a credential and replacing the endpoint change the secret in the
  transaction of the settings, so a removal cannot slip in between the check and the write of the switch; otherwise it is refused with `billing_not_ready`
  and `missing`, every missing item by its code (`factor_a_missing`, `minute_rate_diff_missing`, `minute_rate_dynamic_missing`,
  `diff_ai_reserve_missing`, `stripe_api_key_missing`, `stripe_webhook_secret_missing`, `connection_check_missing`,
  `connection_check_failed`). With Stripe the connection check is made once more just before, so a key that was revoked since the
  last click is found now. Switching off is always allowed and writes nothing else: rates, credentials, journal and balances stay.
- **The enabling statement** (`enabling-copy.ts`) says what switching on does: the reviews of every workspace are charged from a
  prepaid balance, workspaces choose their key mode (our models are the default), a workspace with no balance cannot start a
  review until it has the start credit or credit, the run quotas are not applied and the operator API limits stay, with the
  number of workspaces and of those that hold a stored own key (`db/repositories/own-key-count-repository.ts`).
- **The adapter** is `manual` or `stripe` (`PUT { "adapter" }`); it stays while billing is on (`billing_disable_first`).
- **The Stripe credentials** (`PUT { "stripe": { "apiKey", "webhookSecret" } }`, an empty field keeps the stored one) are
  write-only: the answers carry `configured`, `unreadable` or `not_configured` and the last four characters of a long value. The
  key must start with `sk_test_`, `rk_test_`, `sk_live_` or `rk_live_`; its environment is read from the prefix and shown. A
  credential is not removed while billing is on, and a new key must pass a check before it replaces the one that works. A key of
  the other environment is refused while billing is on (`billing_disable_first`: it would take the webhook secret and the
  endpoint with it and turn billing off without a word); with billing off it takes the stored webhook secret and endpoint id with it.
- **The connection check** (`POST /check`) reads the account (`GET /v1/account`) and answers `{ ok, environment }` or a stable
  code (`stripe_key_rejected`, `stripe_rate_limited`, `stripe_unreachable`, `stripe_unavailable`, `api_key_missing`,
  `api_key_unreadable`). A pass is recorded.
- **The webhook endpoint** (`POST /webhook-endpoint`) registers the public address of this app (`BETTER_AUTH_URL`, never a
  request header) plus `/api/billing/webhook` with the events in `stripe-webhook-events.ts` and stores the returned secret. The
  address must pass `isPublicHttpsUrl` or nothing is called (`webhook_url_not_public`). One creation runs at a time (a lease of
  60 seconds in the setting `billing_destination_lock`: `webhook_endpoint_in_progress`), Stripe is asked first and an endpoint of
  our address that exists is **adopted**, not duplicated, when it is enabled at Stripe, is told about every event of
  `stripe-webhook-events.ts` (or `*`: otherwise `webhook_endpoint_unusable`) and its secret is stored. Stripe shows an endpoint's secret only in the
  answer to the create, so an endpoint of ours without a stored secret answers `webhook_endpoint_secret_unknown` (enter the
  secret, or `{ "recreate": true }` with billing off, which deletes ours and creates a new one). An endpoint whose `livemode` is
  not the key's environment is refused (`webhook_environment_mismatch`) and removed again; a secret that cannot be stored removes
  the endpoint too (`webhook_secret_not_stored`), because the secret cannot be fetched later.
- **Rates and numbers** (`PUT { "rates" }`): A, B for Diff and Dynamic, the Diff AI reserve, the start credit, the low-balance
  threshold and the hourly brake, with the codes of `rates.ts`. The API takes the stored whole numbers (A in parts per 10,000,
  money in micro-USD); the page shows and takes decimals (`src/admin/ui/billing-money.ts`: no float touches an amount). A, both B
  and the reserve have no default; the start credit is 2 USD, the threshold 5 USD and the brake 60 reviews per rolling hour until
  they are set (ADR 0006 D3, D9, D10; `billingNumbersOf`). The numbers are stored here for the later issues that read them (the
  start credit grant #507, the notifications #506, the brake #499). They can be changed at any time, also while billing is on.
- **Manual credit and correction** (`GET /workspaces?q=`, `GET /workspaces/<id>`, `POST /workspaces/<id>/credit`
  `{ type: "credit" | "correction", amountMicroUsd, note, requestId }`; the request id is required, `request_id_required`, so a retry is one entry): the admin searches a workspace by name, sees its balance
  and its ten newest entries, and writes a `top_up` (credit) or a signed `correction` through `createManualCreditService` with
  their user id as the actor and the required note. It works with either adapter and while billing is off.

## The balance journal

One USD balance per workspace (ADR 0006, 2.7; #495), kept in **micro-USD integers**, never a float, as the sum of an
append-only journal. The repository is `src/db/repositories/billing-journal-repository.ts`, created for one workspace; the
tables and their triggers are described in `src/db/README.md` ("Billing journal and balances"). The job lifecycle writes to it
while billing is on (a hold at claim, a settlement at the end: "Reserve, settle, release" below), and payment events credit and debit it
through `applyBillingEvent` (below).

| Type           | Sign | Meaning                                                                    |
| -------------- | ---- | -------------------------------------------------------------------------- |
| `top_up`       | +    | A payment arrived (net amount); the key is the payment intent id.          |
| `start_credit` | +    | The grant for a new workspace.                                             |
| `reservation`  | -    | The hold taken at claim; the key is the job id. Only `reserve` writes one. |
| `usage`        | -    | The charge of a finished run, `ai_micro_usd` + `infra_micro_usd`.          |
| `release`      | +    | The whole hold given back at settlement or when a job is voided.           |
| `refund`       | -    | A payment was refunded; the key is the refund id.                          |
| `chargeback`   | -    | A dispute was lost; the key is the dispute id.                             |
| `correction`   | +/-  | A manual correction, or the reversal of an entry (`reverses_entry_id`).    |

- **Repository.** `append(entry)` for every type but the three of a job's hold (`reservation_required` for a reservation,
  `job_entry_required` for a `release` or a `usage`: only `reserve`, `release()` and `settle()` write those); `reserve(hold, jobId)`; `reserveUpTo(jobId, maxHold)` (the
  hold of a claim, see below); `settle(jobId, charge)` (a `release` of the hold and a `usage` of the charge, in one
  transaction; a charge of zero writes only the release; `created` is true when this call wrote the usage, the release
  when there is none); `release(jobId)` (a job that never ran); `balance()`; `entries({ cursor, limit })` (newest first,
  by `seq`, cursor `{ seq }`; the caller clamps `limit`); `verify()`.
- **Idempotent.** The key is `(workspace, type, ref_key)`: the job id for a job's entries, the provider reference for
  money from outside. The same key with the same amount returns the entry that exists (`created: false`) and changes
  nothing; with another amount it is an `idempotency_conflict`. A `usage` is also its parts, its minutes and its kind: a
  settlement repeated with the same total but other numbers is an `idempotency_conflict` too. A reversal happens once (`already_reversed`), names an
  entry of the workspace with the opposite amount, and is never of a reservation or a release.
- **Atomic and race free on both engines.** An entry and the balance change in one transaction (the caller's, when it
  hands in a transaction). `reserve` and `reserveUpTo` are the conditional writes: they hold at most the balance, so 20 claims of 3
  against 10 grant exactly 3, on Postgres (one pool, two pools) and on SQLite (one connection, several processes).
  `settle` and `release` take the lock of the balance row before they read what a job has, so a release and a settlement
  of one job are decided one after the other: a job whose release committed first, or commits at the same moment, is
  never charged (`job_already_released`). `append` takes the same lock before it writes, so **every writer is "balance row
  first"** and none can wait for another's row (a test holds the lock and appends the same key from both sides).
- **`reserveUpTo(jobId, maxHold)` is the hold of a claim** (#498, decision 5 of #489: hold at most the available balance).
  Under the lock: a job that has a reservation gets it back unchanged (`created: false`), whatever its amount and the
  balance are now, so a claim retried after a crash, a top-up or a refund is never a conflict; otherwise the hold is
  `min(maxHold, balance)`. A balance of exactly zero is refused with `balance_exhausted`, one below zero with
  `balance_negative` (a hold of 0 is not a hold; the UI copy for `balance_exhausted` is "no balance", for
  `balance_negative` "overdrawn"). `reserve` stays for a caller that wants an exact hold or a refusal.
- **The hold of a job: the contract for #498.** A hold lives from the job's first claim to the job's end. **A requeue keeps
  the hold**: a lost lease, a retry or a second claim of the same job id calls `reserveUpTo` again and gets the same
  reservation back (`created: false`), and the job later settles against it. **A release happens only when the job ends
  free** (`release(jobId)`: it never ran, or the class is `free`), and a charged end is `settle`. Keys are per job, not per
  attempt (`reservation`, `release` and `usage` all use the job id), so a job's hold is taken once, ever. If a caller
  claims a job whose hold was released already, `reserveUpTo` and `reserve` answer **`reservation_released`**
  (`ok: false`), not the old reservation: nothing is held, so the retry must not run as if it were paid. #498 decides what
  that means (it should not happen when a requeue never releases); the journal only refuses to say "held" when it is not.
- **A negative balance blocks.** A refund, a chargeback or a final charge above the hold may take the balance below zero;
  every `reserve` and `reserveUpTo` is then refused with `balance_negative`, whatever the amount. A balance that is
  positive but below the hold is refused by `reserve` with `insufficient_balance`; a balance of exactly zero is refused by
  `reserveUpTo` with `balance_exhausted` (and by `reserve` with `insufficient_balance`, there is nothing to hold). All
  come back as the answer (`ok: false`), never as an exception. Credit lifts the block; it never expires.
- **Stable codes** (`BILLING_JOURNAL_ERROR_CODES`): thrown for a caller's bug or a replay with other numbers
  (`invalid_entry`, `idempotency_conflict`, `already_reversed`, `reversed_entry_not_found`, `reservation_required`,
  `job_entry_required`), answered by `reserve`, `reserveUpTo`, `settle` and `release` (`insufficient_balance`,
  `balance_exhausted`, `balance_negative`, `reservation_released`, `reservation_not_found`, `job_already_released`).
- **`verify()`** returns the cache and the sum of the journal side by side with the difference of each (cache minus sum), the holds of
  jobs that ended with nothing left to settle them and without a release (`strandedHoldCount`, `strandedHoldMicroUsd`, #591; a superseded run
  that still drains is not one) and `consistent` (both differences zero and no stranded hold), read in one statement (one snapshot), so traffic that commits meanwhile never shows as drift. The nightly job
  that runs it is #510's.
- **Order.** Every entry has a `seq`, the order it was written in (a Postgres identity, the SQLite row id). `entries()`
  lists by it, so a `release` and its `usage`, written in one millisecond, keep their order. On Postgres a transaction
  that commits late can land below a `seq` a reader has passed; a cursor reader sees it on its next fresh read.

## The adapter seam

Money arrives through an **adapter**, never through code that knows a provider (ADR 0006, 2.12; #497). An adapter
performs actions at its provider and returns **normalized events**; it **never touches the journal**. A generic layer
applies the events. The first real adapter is Stripe Managed Payments (#500 to #502); `manual` needs no provider.

```ts
interface BillingAdapter {
  readonly id: string; // lower case letters, digits, _ and -; the key of the registry
  readonly capabilities: BillingCapabilities;
  ensureCustomer(i: {
    workspace;
    profile;
    customer: ProviderRef | null; // the id the app stored from an earlier call
  }): Promise<ProviderRef | null>; // null: the provider has no such object
  createTopUpCheckout(i): Promise<{
    checkout: { kind: "redirect"; url } | { kind: "none" };
    session: ProviderRef | null;
    payment: ProviderRef | null;
  }>;
  verifyAndParseWebhook?(i: {
    headers;
    rawBody: Uint8Array;
    now;
  }): Promise<WebhookResult>; // absent: no webhook
  lookupTopUp?(i: {
    intentId;
    checkout;
    payment;
  }): Promise<TopUpLookupEvent | null>; // absent: cannot be asked
}
```

- **Refunds are an event only.** There is no `refund` method and no auto-recharge capability. The operator refunds in the
  provider's dashboard and the webhook books it.
- **Capabilities** (`merchantOfRecord`, `customAmount`, `partialRefund`, `minTopUp`, `maxTopUp`, `currencies`,
  `providerMayRefund`, `checkout`, `requiresBillingProfile`, `receiptsFrom`) drive the UI, so a page never names a provider. The
  code constants are the currency USD and the top-up range **10 to 500 USD**; an adapter may **narrow** the range and
  never widen it (`assertValidCapabilities` fails the registry at startup; `assertTopUpAmount` checks an amount before a
  checkout is created).
- **Money is `Usd`**: a whole number of micro-USD, a branded type (`toUsd(n)` is the way in), so cents or another
  currency cannot be mixed in by accident. A refund's or dispute's `amount` is NOT `Usd`: it is a `ProviderAmount`, see
  below. `ProviderRef` is an opaque id (`isProviderRef`: letters, digits and
  `_ . : -`, at most 255): no card, address, tax id or email is ever stored or carried.
- **The events.** `payment.succeeded` (`creditable` is the net amount that becomes credit; `gross`; `tax`, where `0` is a
  real tax and `null` is "not said"), `payment.failed`, `payment.expired` (the checkout ended unpaid: the only way an
  intent becomes `expired`), `refund.updated` (`status` `pending`/`approved`/`rejected`/`reversed`, `initiatedBy`),
  `dispute.updated` (`opened`/`lost`/`won`, with the dispute id) and `ignored` (a verified event of a type the adapter
  does not use). `validateBillingEvent` refuses an event with a non-integer amount, an id that is not an opaque id, a
  time that is not ISO 8601 or an unknown status, so nothing past it trusts a provider's number.
- **Payments are net, refunds and disputes are gross.** A payment carries OUR amounts (`creditable`, net of tax, in
  micro-USD). A refund or dispute carries the PROVIDER's: `amount` of this refund or dispute and `paymentAmount` of the
  whole payment, both gross, in the SAME unit (cents in the buyer's currency, say; the unit never matters), because the
  provider says nothing of the tax split of a refund. The application computes the net share under the intent lock:
  `floor(credited x amount / paymentAmount)` in whole numbers (`net-share.ts`). The whole payment takes exactly what it
  credited (a full refund of 29.75 on a 25.00 credit debits 25.00), and rounding down means the shares of one payment
  never add up to more than its credit.
- **One refund per event.** A delivery carries one event. A provider delivery that lists several refunds (Stripe's
  `charge.refunded`) is not mapped; the adapter maps the per-refund events instead (`refund.created`, `refund.updated`,
  `refund.failed`), each under its own event id and refund id. An adapter must not read a cumulative amount (Stripe's
  `amount_refunded` of a charge) as the amount of one refund; the caps below stop the damage, not the mistake.
- **Disputes** map to three statuses (the Stripe adapter of #502 uses these words): `opened` is `charge.dispute.created`
  or `funds_withdrawn` (the provider takes the money when a dispute opens); `lost` is `charge.dispute.closed` with the
  status `lost`; `won` is `charge.dispute.closed` with `won` or `charge_refunded`, or `funds_reinstated` (the money comes
  back; a refund, if any, is its own event). Early warnings (`warning_*`) and a dispute still under review move no money:
  the event is `ignored`.
- **Asking the provider.** `lookupTopUp` returns what became of a top-up as a `payment.succeeded`, `payment.failed` or
  `payment.expired` event, or `null` (unknown yet, or the object is gone). It is the one outbound call of an adapter,
  made in a user's request (#502's "Check payment"), never in the webhook; its event goes through `applyBillingEvent`,
  so a lost webhook, a late one and a click are idempotent together.
- **`WebhookResult`** is `{ ok: true, event }` or `{ ok: false, code }` with a code of
  `BILLING_WEBHOOK_REJECTION_CODES` (`signature_missing`, `signature_invalid`, `signature_expired`, `body_invalid`) and
  nothing else: no body, no header, no secret. An adapter gets the body as the bytes that were received (`Uint8Array`,
  never decoded text: a byte order mark or a byte that is not UTF-8 would change what a signature covers), checks the
  signature over them before it reads the body, decodes it itself, makes no outbound call and touches no database.

**How to add an adapter.** Implement `BillingAdapter`, add it to `getBillingAdapterRegistry()` in `shared.ts`, and run the
shared kit on it: `describeAdapterContract` (parses its fixtures into the normalized events, refuses bad signatures with a
code, no outbound call, and `lookupTopUp` when it has one) and, when it has a webhook, `describeAdapterApplication` (applies what it parsed on every
engine; the same event twice, the same payment under another event id and the wrong order leave the state of one correct
delivery). Both live in `src/test-support/billing-adapter-kit.ts`; the fake adapter in `fake-billing-adapter.ts` is the
model, and `adapter-kit.test.ts` / `adapter-kit.integration.test.ts` show the call. The active adapter is the `adapter`
field of the instance setting `billing_settings` (`manual` when it is not set or not an adapter id); the admin page sets it
(#504). The Stripe adapter is in the registry (#501); its webhook joins with #502, until then the webhook route answers the
missing path for it. Errors of an adapter are `BillingAdapterError`s with a stable code (`provider_unavailable` for a timeout,
a 5xx or a rate limit, `provider_rejected`, `provider_not_configured` for a key Stripe does not accept, `vat_id_rejected`,
`customer_missing`) and never carry a word of what the provider said.

## The billing profile, the Stripe adapter and the top-up (#501)

**What is kept.** Managed Payments allows neither `tax_id_collection` nor `customer_update[name|address]`, so the app keeps
the buyer's **billing profile** itself (`billing_profiles`, one row per workspace, repository
`billing-profiles-repository.ts`, workspace-scoped): legal name, address (country, two lines, postal code, city), an optional
VAT ID, the business confirmation (`confirmed_at`, `confirmed_by`, `terms_version`) and the id of the provider's customer made
from it (`customer_adapter`, `customer_ref`, an opaque id). It is customer data: only an Owner and an Admin
(`manage_billing`) read or write it through `profile-service.ts`, a Member gets `forbidden` and nothing, it is never logged,
and it is sent to the payment provider and nowhere else (a test scans every table and the logs for it). `profile.ts`
validates what was typed and answers a **field and a code** (`required`, `too_long`, `invalid_characters`,
`country_unknown`, `vat_id_invalid`, `vat_country_unsupported`), never the value. Control, line and paragraph separators and
format characters (a right-to-left override, a zero-width space, a byte order mark) are `invalid_characters`: the text is
printed on an invoice. The VAT ID check is **light**: the shape
of the country's number (the EU, Great Britain, Norway, Switzerland; Greece is `EL`); it is never a claim that the number is
valid, and a country without a shape takes no VAT ID. The business confirmation text is bumped by `BILLING_TERMS_VERSION`.

**What is sent to Stripe, and why.**

| When                  | What                                                                                                                                                                                                                                                                                                                                                                  | Why                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ensureCustomer`      | A Customer with `name` and `business_name` (the legal name), `address`, `preferred_locales` (`en`: the UI is English), `metadata[workspace]` (an opaque id), and the VAT ID as a **tax id** (`eu_vat`, `gb_vat`, `ch_vat`; `no_vat` without the `NO` prefix, which Stripe refuses)                                                                                    | The invoice of Managed Payments is made from the Customer, and the Checkout cannot ask for it. Created once (the Idempotency-Key is the workspace and the exact content, the id is stored); the next top-up updates the same Customer, replaces a changed VAT ID, removes one that was cleared, and makes a new Customer when Stripe no longer knows the stored one. |
| `createTopUpCheckout` | `mode=payment`, one line **"Review credit"** with `price_data` (USD, the amount in cents, `tax_behavior: exclusive`, `tax_code txcd_10105002`), `managed_payments[enabled]=true`, `customer`, `client_reference_id` and `metadata[intent]` (our intent id), `success_url` and `cancel_url` (the workspace's billing page with `?topup=success` or `?topup=cancelled`) | The intent id maps the payment back to the workspace (#502). The **Idempotency-Key is `topup-checkout:<intent id>`**: the same intent is the same session however often it is asked for (a lost answer, a repeated click, a retry after a crash).                                                                                                                    |

`STRIPE_CHECKOUT_PARAMETERS` is the whole set of top-level parameters a session takes from us; a unit test pins it and
asserts that none of `tax_id_collection`, `invoice_creation`, `customer_update`, `payment_method_types`, `custom_text`,
`automatic_tax` and the address collections is sent. The amount is never the client's word: the route takes **integer cents
from 1000 to 50000** and the adapter checks the range again (Stripe itself would take 50 cents, and the fake one cent, so
the floor is ours: `stripe-adapter.integration.test.ts` shows the fake accepting 1 cent and the adapter not sending it).
Capabilities: `merchantOfRecord`, `customAmount`, `partialRefund` (to be confirmed in #503), 10 to 500 USD, USD,
`providerMayRefund` 60 days, `checkout`, `requiresBillingProfile`, `receiptsFrom: "provider"`.

**The route.** `POST /api/w/:workspace/billing/top-ups` with `{ amountCents, confirmBusiness?, intentId? }` answers
`{ intentId, url }`; the buyer is sent to `url`. It never credits: the balance changes when the webhook arrives (#502), and the
success page only says the payment is on its way (#505). The order (`topup-http.ts`, `topup-service.ts`): billing on and an
adapter with a checkout (else the 404 of a path that does not exist, also for the `manual` adapter), same site, session and
role (`manage_billing`), a limit of 10 starts per person and workspace in 10 minutes and of 200 for the whole instance (one API key serves all workspaces; `top_ups_busy`, 503; the counters are shared across app instances and the route **fails closed**: counters that cannot be read are `limits_unavailable`, 503, and Stripe is not asked), a JSON body of at most 4 KiB, then the
amount, the intent id (a UUID the form makes once per attempt, so a repeated click is the same intent), the profile, the
**business confirmation at the first top-up** (stored with the time, the user and the terms version), the **intent row
written first**, the Customer and the session. Refusals are `{ "error": <code> }`: `forbidden`, `amount_invalid`,
`amount_out_of_range`, `intent_id_invalid`, `profile_required`, `business_confirmation_required`, `intent_conflict`,
`checkout_unavailable`, `rate_limited`, `top_ups_busy`, `limits_unavailable`, `request_in_progress` (409: the same start is still running at Stripe, the 409 `idempotency_key_in_use`; try again in a moment, the intent is untouched), `provider_unavailable` (502: a timeout, a 5xx, a rate limit), `provider_rejected`,
`provider_not_configured` (503), `vat_id_rejected`. When the provider fails the intent becomes `failed` (a payment that still
arrives can pay it, as for any failed intent) so none stays pending without a way back, except one that already has a page
(judged on the row under the lock, not on what the request read first) or whose same start is still running: the buyer may be on
that page, or the winning request decides. The person tries again with a new intent id.

**One page per intent.** An intent that has a page (`provider_checkout_ref`) never gets a second one. A repeat of its id asks
the adapter about the page it has (`resumeTopUpCheckout`, a GET, never a create): while the session is `open` the same address
is returned, otherwise (paid, expired, unknown to Stripe, or an adapter that cannot ask) the answer is `intent_conflict` and the
form must use a new intent. Stripe forgets an Idempotency-Key after 24 hours, so without this rule a late repeat would create a
second payable session and then fail on the unique ref, leaving the first payable and the second unreachable. For the same
reason an intent that never got a page is failed after `TOP_UP_PENDING_WITHOUT_PAGE_MS` (30 minutes, swept at the next start of
the workspace and refused on a late repeat): the start that wrote it died before Stripe was asked or before the page was recorded. A start that crashed between the provider and the database leaves a `pending` intent whose session Stripe expires on
its own (#502 turns `checkout.session.expired` into `payment.expired`). The log carries the workspace id and a result code
(`[billing] TOPUP_STARTED workspace=<id> result=ok`), never an amount, a name, an address, a VAT ID, a customer or a page.

**Go-live order.** The route for the billing-profile form (#505) **must not ship before #502** (the webhook and the
crediting). Once a profile can be saved, the top-up route becomes usable (`profile_required` is the only thing keeping a
buyer out today), and a payment made before #502 is taken by Stripe and credited to nobody. The rule is also on #510 (go-live).

**What is not here.** The pages (#505, which also needs a route for the profile form: `profile-service.ts` is ready for it),
the webhook, refunds and chargebacks (#502), the sandbox plan for invoices and VAT (#503), auto-recharge.

**Checked against the Stripe sandbox (test mode, 2026-10-21).** A Customer takes `business_name` at API version
`2025-03-31.basil`; `eu_vat`, `gb_vat`, `ch_vat` (the compact form is stored as `CHE-123.456.789 MWST`) and `no_vat` (without
`NO`) tax ids are taken, a malformed one is `400 Invalid value for <type>` (the adapter says `vat_id_rejected`), a customer
holds at most five tax ids; an address update replaces the whole address. Managed Payments takes both `txcd_10105002` and
`txcd_10103001` (and the rest of `txcd_10...` probed), refuses `txcd_99999999`, `txcd_00000000`, `txcd_20030000` and a text
that is no code ("ineligible for Managed Payments"), and takes any amount, 999 cents included (the floor is ours). A webhook
endpoint takes `api_version` as `2025-03-31.basil` and with the preview flag; the admin page now creates the endpoint with the
version the client's calls use, so the events #502 reads are rendered in a pinned shape (an endpoint that already exists is
adopted as it is).

## Top-up intents

`billing_topup_intents` (workspace-scoped repository `billing-topup-intents-repository.ts`) is the row the application
writes **before any checkout is created**. It holds the adapter, the amount WE asked for, a state (`pending`, `paid`,
`failed`, `expired`) and the provider's opaque ids of the checkout and the payment once known (unique per adapter,
recorded once, never changed). Once paid it also holds what the payment **credited** (net, fixed at that moment) and two
running totals, of what **refunds** and of what **disputes** took back of it; together they never exceed the credit (a
database check as well as the code). It is the only thing that maps a payment to a workspace. To find an intent from an event,
before the workspace is known, `billing-topup-intent-directory-repository.ts` (read only, instance level) looks it up by
payment, checkout or intent id, only for the adapter that made it.

## Applying an event

`applyBillingEvent(db, { provider, event })` runs **one database transaction per event**:

1. **Claim** the event id in `billing_webhook_events` (id, outcome, order; no payload). A repeat is `duplicate_ignored`.
   Only `intent_unresolved` lets the same event id be handled again, if it is delivered again. The route answers 200
   for it, so a provider does NOT redeliver on its own: a refund that arrives before its payment is recorded for review
   (below), and "Check payment" (#502) or the operator repairs it.
2. **Resolve** the intent: by the payment, then the checkout, then our own intent id recorded in the event, and every
   other field must agree. An event that names another intent than the payment belongs to, or another payment than the
   one recorded, resolves to nothing: `intent_unresolved`, no change, answered 200. The intent row is locked (Postgres
   `FOR UPDATE`, SQLite one writer), so every event about one payment is applied one after the other.
3. **Order**: a refund or dispute state older than the last one applied is `stale_ignored`.
4. **Bound**: a credit is at least 10 USD and at most the amount of the intent. A refund or dispute is turned into its
   net share (see above); it is `amount_rejected` when it is larger than its payment, and when it would take the
   refunds and disputes of that payment **together** above what the payment credited (two refunds of 20 on a 25 credit
   take 20, then the second is rejected; a refund of 25 and a dispute of 25 take 25). A debit adds to its total, a
   reversal (a rejected or reversed refund, a won dispute) subtracts what it gave back. Nothing is written for a
   rejected amount. This is a deliberate limit: a provider can really lose money twice on one charge (a refund and a lost
   dispute), and that case lands in review (below) instead of silently debiting more than the payment gave.
5. **Write**: `payment.succeeded` is a `top_up` keyed by the **payment** (D14: two events for one payment credit once, and
   the same payment with another amount is `amount_conflict`) and the intent becomes `paid`; `payment.failed` marks a
   pending intent `failed`, `payment.expired` a pending intent `expired` (a late payment still pays either);
   `refund.updated` `pending`/`approved` is a `refund` and a dispute `opened`/`lost` a
   `chargeback`, keyed by the refund or dispute and written **even beyond the unspent balance** (it goes negative and the
   claim refuses the workspace with `balance_negative`); `rejected`/`reversed` and `won` write a `correction` that reverses
   the debit once (`nothing_to_reverse` when there is none yet). A dispute is debited when it opens, because that is when
   the provider takes the money, and when it is lost, whichever is seen first: one `chargeback`.
6. The outcome (`BILLING_EVENT_OUTCOMES`) is recorded with the event id in the same transaction.

**Paid but not credited, and the other outcomes an operator must see.** `intent_unresolved`, `amount_rejected`,
`amount_conflict` (`BILLING_REVIEW_OUTCOMES`) of an event that moves money (a payment, a refund, a dispute), and
`event_invalid`, mean a buyer may have paid and got nothing (an unknown intent, a second payment of an intent that is
paid, an amount above what we asked, a payment that changes the amount of a credit) or been refunded and kept the credit
(a refund before its payment, or beyond the caps). Each is recorded with `review_state = 'open'` and the subject it was
about (`payment:<id>`, `refund:<id>`, `dispute:<id>`; `listOpenReviews` reads them; the admin view of them is a follow-up of #504), logged
at error level with its code (`billing_webhook_needs_review outcome=...`), and answered 200: the provider's retry would
not change it. The repair is the operator's: a `manual` grant or correction, or "Check payment" (#502) when the provider's
state is the doubt. A signed event that is not a normalized event (an adapter bug, a provider change) is recorded
`event_invalid` under its event id, answered 200 like the rest (a 500 would be retried for days and can disable the
endpoint) and logged `billing_webhook_event_invalid`; if even its id is no id it is answered but cannot be recorded.

Not handled here: a refund that returns to a debit after a reversal (`approved`, `rejected`, `approved` again) stays
reversed, because a refund's journal key is used once; the order of two states of a refund inside one second follows the
provider's clock (`>` on its timestamp); rows of `billing_webhook_events` are never pruned (they are a few bytes each; the journal key is the second idempotency layer, so
a prune after the provider's retry window is safe and left to a follow-up).

## The webhook route

`POST /api/billing/webhook` (`webhook-handler.ts`, wired in `shared.ts`) is public (`src/auth/access.ts`), runs on Node,
and is the same for every provider. Order: guard (billing off, or the active adapter has no webhook, is the 404 of a path
that does not exist, before the body is read and before any billing table is touched), a raw body limited to 256 KiB (413),
`adapter.verifyAndParseWebhook` over the exact bytes (401 for a missing, wrong, altered or old signature and 400 for a signed
body the adapter cannot read, both with an **empty body**), then `applyBillingEvent` (200 and `{ "outcome": "<code>" }`).
The adapter gets the body as bytes (`body.bytes`). Anything that throws is 500 with an empty body and nothing applied; the
provider redelivers. A signed event that is no event, and a paid-but-not-credited outcome, are not thrown: they are
answered 200 and recorded for review (see above). The log names a code only
(`billing_webhook_rejected code=signature_invalid`): never a body, header, signature, id, amount or error message.
**There is no outbound call in the handler** (`webhook-handler.test.ts` pins it), so the route answers within a few
seconds whatever the provider does.

## The manual adapter

For a self-hoster who runs prepaid billing with no payment provider. No checkout (`{ kind: "none" }`: the workspace page
says "ask your operator to add credit") and no webhook. `createManualCreditService(db)` offers `grant` (a `top_up` with the
provider `manual`) and `correct` (a `correction` of either sign, which may take a balance below zero), both with an actor
and a note: the immutable journal entry is the audit trail. A grant is keyed by a random reference, so granting twice is
two grants, unless the caller passes a `requestId` (a form token): then the same request makes one entry. An amount is a
whole micro-USD amount, never zero, at most 10,000 USD at once, a note is required (at most 500 characters) and the
workspace must exist (`MANUAL_CREDIT_ERROR_CODES`). The form is the billing page (#504, above); its routes check that the
caller is an instance admin first and work whether billing is on or off.

## The start credit

The start credit (ADR 0006, 2.16, D11, P7; #507) replaces the Free plan: a new workspace can try our models before it pays. It is a
`start_credit` journal entry of the amount the admin set on the billing page (`startCreditMicroUsd`, default 2 USD, **0 disables it**).
It is the easiest thing to farm, so it is tied to the **GitHub account**, not to the workspace.

- **When.** Lazily, by one idempotent function, `ensureStartCredit(db, workspaceId)`, the first time a workspace with a bound
  installation meets billing **while billing is on**: the first claim of a job (inside the claim transaction, before the hold, so the
  first job can use it; `runner-jobs-repository.ts` calls `ensureStartCreditWhileOn` once billing is `on`) and the first visit of the
  workspace's billing page (that page does not exist yet: the issue that adds it, #501, calls `ensureStartCredit` before it reads the balance). There is no scheduler and no
  hook on binding. Existing workspaces when billing is switched on get theirs through the same path, on their first contact.
- **Who.** The numeric account id of the installation (`config.accountId`, #103) of an integration that is not `disconnected`. A
  workspace without such an installation, or whose installation names no account id, gets nothing, and its claim is refused for
  balance as usual (`insufficient_balance`). A workspace is granted **at most once** whatever the number of its installations
  (the journal key `(workspace, start_credit, "start-credit")`), and an account at most once whatever the number of workspaces.
- **The memory.** `billing_start_credit_grants` (instance level, `billing-start-credit-grants-repository.ts`): the numeric account id
  (primary key), the id of the workspace that got the credit and the time. **No foreign key to a workspace**, so the row outlives
  it: deleting a workspace and creating it again for the same installation account finds the account granted. It holds ids and a
  time only: no login, no name, no address, no amount (the amount is the journal entry, which is what the customer sees). The
  account id is checked to be a plain positive number (a database check on both engines).
- **Race safety.** The grant is one transaction (the claim's, or its own): look for the workspace's entry, read the amount, read the
  accounts of the installations, take the balance row's lock (the journal's rule for every writer: the lock first, then any write,
  the grants table included), take the first bound account nobody was granted (`insert ... on conflict do nothing` on the primary
  key: of two writers exactly one wins, the other waits for the first to commit on Postgres and gets "already granted"), write the
  entry. Nothing is written when any step fails, and every step is keyed, so a retry never grants twice.
- **It never fails the claim.** The grant runs inside a savepoint. An error of any kind (a database error, a row it cannot read)
  rolls back to the savepoint, is logged as `BILLING_START_CREDIT_FAILED workspace=<id>` (never the error text), and the result is
  `failed`: no grant, no entry, the claim goes on and the workspace is judged on its balance as usual; the next contact tries
  again. It reads only the `config` of the rows with `type = 'github_app'` and a status other than `disconnected`, never the
  credentials or the webhook secret, and an unreadable config or account id skips that row. A claim tries a workspace once, not
  once per candidate job.
- **Amount changes.** The amount is read when the grant is made. A grant is never edited (the journal is append-only), so a changed
  amount affects only grants not made yet. Raising it from 0 grants later contacts; accounts that met billing while it was 0 were not
  consumed (no row was written), so they are granted at the new amount on their next contact.
- **Billing off.** `ensureStartCredit` reads the instance setting and nothing else: no billing table and no integration. The claim
  does not call it unless billing is on and ready. Nothing is granted while billing is off.
- **Log.** `BILLING_START_CREDIT_GRANTED workspace=<id> amountMicroUsd=<n>` per grant, written after the transaction committed (a
  claim that rolls back announces nothing); never an account id.

### Abuse protection of version 1, and the surface that is left

What protects the credit: the memory above (one grant per GitHub account, kept past the workspace), the hourly brake (#499; its setting exists, the brake itself is not built yet), the holds
that bound what a run can cost (a hold is at most the balance, a balance of zero is refused), and the sign-up rules of the instance
(allowed organizations, invitation only, verified email as the operator configured them). Not in version 1, by ADR 0006 2.16:
disposable-email lists, a first-top-up cap, a verified email as a condition.

What is observed, so a follow-up can be sized:

- **A new GitHub account is a new credit.** A farmer needs a GitHub account, an installation of the App on it and a workspace that
  binds it. Each costs a few minutes and no money, and yields the start credit (2 USD by default) of real model cost and VM time.
  The limit is the sign-up rule of the instance and GitHub's own abuse handling, not this code.
- **Org accounts.** Any user can create organizations and install the App on each. Every one is a distinct account id.
- **Transfer.** The credit stays with the workspace; it cannot be withdrawn or refunded (credit never expires and is never refunded),
  so the loss of one grant is bounded by the amount.
- **Sizing.** `select count(*), min(granted_at), max(granted_at) from billing_start_credit_grants` and the log line above give grants
  per day; compare `start_credit` totals in `billing_journal_entries` with the `usage` of the same workspaces to see how much of the
  credit is ever spent and by workspaces that never top up.

## Where billing is not allowed to reach

- A browser: `server-only.test.ts` fails when a client component imports this folder, directly or through a file.
- The environment: see above.
- A workspace's data: anything a later issue stores about a workspace is scoped to it (`src/db/README.md`, "Workspace
  scoping").
