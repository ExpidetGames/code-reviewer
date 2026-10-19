# Billing module

The place of billing in the app. **Billing is off unless an instance admin switches it on, and a self-hoster who never
does sees no change.** The design is ADR 0006 (`docs/decisions/0006-prepaid-billing-via-stripe-managed-payments.md`,
epic #489): prepaid pay-as-you-go through Stripe Managed Payments, a provider-neutral adapter in front of it. The
earlier subscription design (plans, plan versions, prices with a payment provider, an admin page for them) was deleted
before it reached a release (#491); the model catalog, the providers and `modelAccess` of epic #420 are unaffected.

What is here today is only the part every later billing issue builds on. Server-only: every source file imports
`"server-only"` (`server-only.test.ts`).

| File            | What it is                                                                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.ts`   | The instance setting `billing_settings`: `{ enabled }` today, the rates later. `readBillingSettings` reads a stored value leniently: a field it does not know (a value of the older shape also had an environment, a client token and grace days) is ignored, and `enabled` is true only when it is exactly `true`. |
| `enabled.ts`    | `isBillingOn(db)`: the one reader of the switch. `guardBillingRoute`: the first line of every billing route.                                                                                                                                                                                                        |
| `journal.ts`    | The vocabulary of the balance journal (#495): the entry types as an `as const` set, the sign of each, the stable error codes, `validateEntry`. The table checks restate the type and sign rules in SQL; `journal.test.ts` fails when they drift apart.                                                              |
| `public-url.ts` | Whether an address can be reached from the internet (https, no credentials, no loopback, private, link-local or local name; pure), and the one spelling addresses are compared in. A Stripe webhook endpoint needs it.                                                                                              |

## The switch

`isBillingOn` reads the instance setting `billing_settings.enabled` and nothing else. It calls nobody and reads no
billing table. The readiness of the payment adapter joins the answer with the adapter (#501, #504). **There is exactly
one reader of the switch**; a test (`src/ci/billing-cleanup.test.ts`) fails when a second one appears. Every billing
route, page and sweep step asks `isBillingOn` first: while it is false they are inert, a route answers the 404 of a path
that does not exist (`guardBillingRoute`, Next.js's own `notFound()`), no billing table is read and nobody is called.

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
