# Billing module

The place of billing in the app. **Billing is off unless an instance admin switches it on, and a self-hoster who never
does sees no change.** The design is ADR 0006 (`docs/decisions/0006-prepaid-billing-via-stripe-managed-payments.md`,
epic #489): prepaid pay-as-you-go through Stripe Managed Payments, a provider-neutral adapter in front of it. The
earlier subscription design (plans, plan versions, prices with a payment provider, an admin page for them) was deleted
before it reached a release (#491); the model catalog, the providers and `modelAccess` of epic #420 are unaffected.

What is here today is the part every later billing issue builds on, the price of a run (#494), and the adapter seam with its event application and the `manual` adapter (#497). Server-only: every
source file imports `"server-only"` (`server-only.test.ts`).

| File                                                   | What it is                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.ts`                                          | The instance setting `billing_settings`: the switch `enabled` and the rates. `readBillingSettings` reads a stored value leniently: a field it does not know (a value of the older shape also had an environment, a client token and grace days) is ignored, `enabled` is true only when it is exactly `true`, and a rate that is damaged reads as not set. |
| `rates.ts`                                             | The rates (pure): the bounds, `validateRatesPatch` with the stable codes `factor_invalid`, `rate_invalid`, `reserve_invalid`, `billingRatesOf` (the complete rates or null) and `canSwitchBillingOn` (`billing_rates_incomplete`).                                                                                                                         |
| `rates-service.ts`                                     | The one writer of the rates: validates, merges into the stored setting under an advisory lock (`db/billing-settings-lock.ts`), keeps the switch as it is. The admin form is #504.                                                                                                                                                                          |
| `outcome.ts`                                           | `classifyOutcome`: the end state of a job and its stable codes to `charged`, `minutes_only` or `free`, from an exhaustive table (pure).                                                                                                                                                                                                                    |
| `pricing.ts`                                           | `priceRun` and `reserveFor` (pure): the two prices of a run and the hold of a job, in whole micro-USD.                                                                                                                                                                                                                                                     |
| `journal.ts`                                           | The vocabulary of the balance journal (#495): the entry types as an `as const` set, the sign of each, the stable error codes, `validateEntry`. The table checks restate the type and sign rules in SQL; `journal.test.ts` fails when they drift apart.                                                                                                     |
| `enabled.ts`                                           | `isBillingOn(db)`: the one reader of the switch. `guardBillingRoute`: the first line of every billing route.                                                                                                                                                                                                                                               |
| `adapter.ts`                                           | The provider-neutral seam (#497): `BillingAdapter`, `BillingCapabilities`, the normalized `BillingEvent`s, `WebhookResult`, the code constants (USD, the top-up range 10 to 500), the registry and `validateBillingEvent`.                                                                                                                                 |
| `apply-event.ts`                                       | `applyBillingEvent`: the one place where a normalized event becomes money (#497).                                                                                                                                                                                                                                                                          |
| `topup-intent.ts`                                      | The vocabulary of a top-up intent: states, codes and the shape the app sees.                                                                                                                                                                                                                                                                               |
| `manual-adapter.ts`, `manual-credit.ts`                | The `manual` adapter and the service an operator's credits and corrections go through (#497).                                                                                                                                                                                                                                                              |
| `webhook-handler.ts`, `active-adapter.ts`, `shared.ts` | The generic handler behind `POST /api/billing/webhook`, which adapter is active, and the wiring (#497).                                                                                                                                                                                                                                                    |
| `public-url.ts`                                        | Whether an address can be reached from the internet (https, no credentials, no loopback, private, link-local or local name; pure), and the one spelling addresses are compared in. A Stripe webhook endpoint needs it.                                                                                                                                     |

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
  the safe range) throws a `PricingError` with a stable code; the caller (#498) decides what happens to such a run.

### The hold

`reserveFor` is the hold of ADR 0006, D6: the longest the VM lives (rounded up to a started minute) times `B[kind]`, plus,
on the managed key, `round(AI budget x A / 10,000)`, where the AI budget is the cost limit of the job for Dynamic and
`diffAiReserveMicroUsd` for Diff (both real model cost, multiplied by A). A bring-your-own-key job holds the minutes only.
A hold is not a price: settlement charges what the run really cost, even above the hold.

`reserveFor` returns the **full** hold. Decision 5 of #489 (reserve at most the available balance; the final charge may take
the balance slightly negative) is applied by the caller, **#498**, as `min(hold, available)`, with its own test, so that
there is one interpretation of it. A hold is never clamped here.

### The classes of an outcome

| Class          | AI price                                  | Infrastructure price |
| -------------- | ----------------------------------------- | -------------------- |
| `charged`      | yes, on the managed key with a known cost | yes                  |
| `minutes_only` | no                                        | yes                  |
| `free`         | no                                        | no                   |

`classifyOutcome` maps the end of a job to a class. A delivered result and a run that failed on the customer's side of
the line are `charged` (an unknown cost then leaves only the minutes, which is also how a superseded run without a report
bills). A run that ended without a result that is not attributable (a result that was not published, a process the loop
of a runner had to end, `git_auth` and `git_forbidden`, which can be a revoked installation or our own App token) is
`minutes_only`. An error on our side and a job that never ran are `free`: the launch failed, the VM or the Worker died,
the lease ran out, the runner shut down, a limit refused the claim, and **every timeout** (the queue's `timeout`, the
runner's and `llm_timeout`; decision 1: "a timeout caused by us bills nothing"). A queued job superseded before it ran has
no run and is `free`; a superseded run that began (its usage record says `superseded`) is `charged`. The key, the account,
the model and the rate limit of the managed key are ours when they fail, and the customer's on their own key. When several
facts apply (the code, a finer reason, the settled reason of the usage record) the cheapest class for the customer wins. A
code or a checkout reason the build does not know is `minutes_only`; it never throws.

**Open question for the maintainer (B2 of the review of #520).** A run that failed after it used the model and delivered
no result (`command_failed`, `dynamic_budget_exceeded`, `dynamic_policy_violation`, `llm_bad_request`,
`llm_context_length_exceeded`) is `charged` (AI and minutes) today, as ADR 0006, 2.6 row 2 says. Decision 1 ("a review that
ends without a result but already incurred AI cost bills the minutes only"), read literally, makes them `minutes_only`.
The five codes are one group in `outcome.ts` (`AI_COST_FAILURE_CODES`) with one class (`AI_COST_FAILURE_CLASS`), so the
answer is a one-line change; a test pins the members. The money difference is mostly `dynamic_budget_exceeded`: a run that
burns its whole cost limit pays up to `limit x A`.

The table is exhaustive over today's terminal codes: the job end codes, the release reasons, the error codes and checkout
reasons of the runner contract, the reasons of the loop of a runner and the settled reasons. `outcome.test.ts` fails when
one of those lists gains a code with no class, so adding a code means deciding who pays for it.

## The switch

`isBillingOn` reads the instance setting `billing_settings.enabled` and nothing else. It calls nobody and reads no
billing table. The readiness of the payment adapter joins the answer with the adapter (#501, #504). **There is exactly
one reader of the switch**; a test (`src/ci/billing-cleanup.test.ts`) fails when a second one appears. Every billing
route, page and sweep step asks `isBillingOn` first: while it is false they are inert, a route answers the 404 of a path
that does not exist (`guardBillingRoute`, Next.js's own `notFound()`), no billing table is read and nobody is called.

**Billing on with incomplete rates.** `isBillingOn` stays a pure switch. If `enabled` is true while a rate is missing or
damaged (`rates()` is null), the claim of a job (#498) refuses it with the stable code `billing_rates_incomplete`, with a
test; reviews do not run free. To keep that state from arising, #504 must call `canSwitchBillingOn` **inside the same
`lockBillingSettings` transaction that writes `enabled`**, or the check can race with a rate write.

There is no environment variable: billing is configured in the admin portal and in nothing else, so `.env.example` and
the deployment files stay as they are for a self-hoster (`no-environment-variable.test.ts`).

The credentials of a payment provider are encrypted, write-only secrets of the secret store (`src/secrets/`, ADR 0006
2.14); no name of one is in `SECRET_NAMES` yet. A row of a removed secret name that an old database still holds is not
read, not listed and not an error.

## The balance journal

One USD balance per workspace (ADR 0006, 2.7; #495), kept in **micro-USD integers**, never a float, as the sum of an
append-only journal. The repository is `src/db/repositories/billing-journal-repository.ts`, created for one workspace; the
tables and their triggers are described in `src/db/README.md` ("Billing journal and balances"). Nothing in the job
lifecycle calls it yet: reserving at claim and settling are #498, prices #494. Payment events credit and debit it through `applyBillingEvent` (below).

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
- **`verify()`** returns the cache and the sum of the journal side by side with the difference of each (cache minus sum) and
  `consistent`, read in one statement (one snapshot), so traffic that commits meanwhile never shows as drift. The nightly job
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
  ensureCustomer(i): Promise<ProviderRef | null>; // null: the provider has no such object
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
  `providerMayRefund`, `requiresBillingProfile`, `receiptsFrom`) drive the UI, so a page never names a provider. The
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
field of the instance setting `billing_settings` (`manual` when it is not set or not an adapter id); the admin page that
sets it is #504.

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
about (`payment:<id>`, `refund:<id>`, `dispute:<id>`; `listOpenReviews` reads them for the admin page of #504), logged
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
workspace must exist (`MANUAL_CREDIT_ERROR_CODES`). The forms are #504; they check that the caller is an instance admin and
that billing is on first.

## Where billing is not allowed to reach

- A browser: `server-only.test.ts` fails when a client component imports this folder, directly or through a file.
- The environment: see above.
- A workspace's data: anything a later issue stores about a workspace is scoped to it (`src/db/README.md`, "Workspace
  scoping").
