# Billing module

The place of billing in the app. **Billing is off unless an instance admin switches it on, and a self-hoster who never
does sees no change.** The design is ADR 0006 (`docs/decisions/0006-prepaid-billing-via-stripe-managed-payments.md`,
epic #489): prepaid pay-as-you-go through Stripe Managed Payments, a provider-neutral adapter in front of it. The
earlier subscription design (plans, plan versions, prices with a payment provider, an admin page for them) was deleted
before it reached a release (#491); the model catalog, the providers and `modelAccess` of epic #420 are unaffected.

What is here today is the part every later billing issue builds on, and the price of a run (#494). Server-only: every
source file imports `"server-only"` (`server-only.test.ts`).

| File               | What it is                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.ts`      | The instance setting `billing_settings`: the switch `enabled` and the rates. `readBillingSettings` reads a stored value leniently: a field it does not know (a value of the older shape also had an environment, a client token and grace days) is ignored, `enabled` is true only when it is exactly `true`, and a rate that is damaged reads as not set. |
| `rates.ts`         | The rates (pure): the bounds, `validateRatesPatch` with the stable codes `factor_invalid`, `rate_invalid`, `reserve_invalid`, `billingRatesOf` (the complete rates or null) and `canSwitchBillingOn` (`billing_rates_incomplete`).                                                                                                                         |
| `rates-service.ts` | The one writer of the rates: validates, merges into the stored setting under an advisory lock (`db/billing-settings-lock.ts`), keeps the switch as it is. The admin form is #504.                                                                                                                                                                          |
| `outcome.ts`       | `classifyOutcome`: the end state of a job and its stable codes to `charged`, `minutes_only` or `free`, from an exhaustive table (pure).                                                                                                                                                                                                                    |
| `pricing.ts`       | `priceRun` and `reserveFor` (pure): the two prices of a run and the hold of a job, in whole micro-USD.                                                                                                                                                                                                                                                     |
| `journal.ts`       | The vocabulary of the balance journal (#495): the entry types as an `as const` set, the sign of each, the stable error codes, `validateEntry`. The table checks restate the type and sign rules in SQL; `journal.test.ts` fails when they drift apart. |
| `enabled.ts`       | `isBillingOn(db)`: the one reader of the switch. `guardBillingRoute`: the first line of every billing route.                                                                                                                                                                                                                                               |
| `public-url.ts`    | Whether an address can be reached from the internet (https, no credentials, no loopback, private, link-local or local name; pure), and the one spelling addresses are compared in. A Stripe webhook endpoint needs it.                                                                                                                                     |

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
lifecycle calls it yet: reserving at claim and settling are #498, crediting from payment events #497, prices #494.

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

- **Repository.** `append(entry)` for every type but a reservation; `reserve(hold, jobId)`; `settle(jobId, charge)` (a
  `release` of the hold and a `usage` of the charge, in one transaction; a charge of zero writes only the release);
  `release(jobId)` (a job that never ran); `balance()`; `entries({ cursor, limit })` (newest first, `(created_at, id)`
  cursor); `verify()`.
- **Idempotent.** The key is `(workspace, type, ref_key)`: the job id for a job's entries, the provider reference for
  money from outside. The same key with the same amount returns the entry that exists (`created: false`) and changes
  nothing; with another amount it is an `idempotency_conflict`. A reversal happens once (`already_reversed`), names an
  entry of the workspace with the opposite amount, and is never of a reservation or a release.
- **Atomic and race free on both engines.** An entry and the balance change in one transaction (the caller's, when it
  hands in a transaction). `reserve` is the only conditional write: it holds at most the balance, so 20 claims of 3 against
  10 grant exactly 3, on Postgres (one pool, two pools) and on SQLite (one connection, several processes).
- **A negative balance blocks.** A refund, a chargeback or a final charge above the hold may take the balance below zero;
  every `reserve` is then refused with `balance_negative`, whatever the amount. A balance that is positive but below the
  hold is refused with `insufficient_balance`. Both come back as the answer of `reserve` (`ok: false`), never as an
  exception. Credit lifts the block; it never expires.
- **Stable codes** (`BILLING_JOURNAL_ERROR_CODES`): thrown for a caller's bug or a replay with other numbers
  (`invalid_entry`, `idempotency_conflict`, `already_reversed`, `reversed_entry_not_found`, `reservation_required`),
  answered by `reserve`, `settle` and `release` (`insufficient_balance`, `balance_negative`, `reservation_not_found`,
  `job_already_released`).
- **`verify()`** returns the cache and the sum of the journal side by side with the difference of each (cache minus sum) and
  `consistent`. The nightly job that runs it is #510's. The entries of one millisecond are ordered by id, so two entries
  written in the same transaction (a `release` and its `usage`) have no meaningful order among themselves.

## Where billing is not allowed to reach

- A browser: `server-only.test.ts` fails when a client component imports this folder, directly or through a file.
- The environment: see above.
- A workspace's data: anything a later issue stores about a workspace is scoped to it (`src/db/README.md`, "Workspace
  scoping").
