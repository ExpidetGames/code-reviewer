# Billing module

The place of billing in the app. **Billing is off unless an instance admin switches it on, and a self-hoster who never
does sees no change.** The design is ADR 0006 (`docs/decisions/0006-prepaid-billing-via-stripe-managed-payments.md`,
epic #489): prepaid pay-as-you-go through Stripe Managed Payments, a provider-neutral adapter in front of it. The
earlier subscription design (plans, plan versions, prices with a payment provider, an admin page for them) was deleted
before it reached a release (#491); the model catalog, the providers and `modelAccess` of epic #420 are unaffected.

What is here today is the part every later billing issue builds on: the switch, the journal (#495) and the adapter seam with its event application and the `manual` adapter (#497). Server-only: every source file imports
`"server-only"` (`server-only.test.ts`).

| File                                                   | What it is                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.ts`                                          | The instance setting `billing_settings`: `{ enabled }` today, the rates later. `readBillingSettings` reads a stored value leniently: a field it does not know (a value of the older shape also had an environment, a client token and grace days) is ignored, and `enabled` is true only when it is exactly `true`. |
| `enabled.ts`                                           | `isBillingOn(db)`: the one reader of the switch. `guardBillingRoute`: the first line of every billing route.                                                                                                                                                                                                        |
| `journal.ts`                                           | The vocabulary of the balance journal (#495): the entry types as an `as const` set, the sign of each, the stable error codes, `validateEntry`. The table checks restate the type and sign rules in SQL; `journal.test.ts` fails when they drift apart.                                                              |
| `adapter.ts`                                           | The provider-neutral seam (#497): `BillingAdapter`, `BillingCapabilities`, the normalized `BillingEvent`s, `WebhookResult`, the code constants (USD, the top-up range 10 to 500), the registry and `validateBillingEvent`.                                                                                          |
| `apply-event.ts`                                       | `applyBillingEvent`: the one place where a normalized event becomes money (#497).                                                                                                                                                                                                                                   |
| `topup-intent.ts`                                      | The vocabulary of a top-up intent: states, codes and the shape the app sees.                                                                                                                                                                                                                                        |
| `manual-adapter.ts`, `manual-credit.ts`                | The `manual` adapter and the service an operator's credits and corrections go through (#497).                                                                                                                                                                                                                       |
| `webhook-handler.ts`, `active-adapter.ts`, `shared.ts` | The generic handler behind `POST /api/billing/webhook`, which adapter is active, and the wiring (#497).                                                                                                                                                                                                             |
| `public-url.ts`                                        | Whether an address can be reached from the internet (https, no credentials, no loopback, private, link-local or local name; pure), and the one spelling addresses are compared in. A Stripe webhook endpoint needs it.                                                                                              |

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
  verifyAndParseWebhook?(i: { headers; rawBody; now }): Promise<WebhookResult>; // absent: no webhook
}
```

- **Refunds are an event only.** There is no `refund` method and no auto-recharge capability. The operator refunds in the
  provider's dashboard and the webhook books it.
- **Capabilities** (`merchantOfRecord`, `customAmount`, `partialRefund`, `minTopUp`, `maxTopUp`, `currencies`,
  `providerMayRefund`, `requiresBillingProfile`, `receiptsFrom`) drive the UI, so a page never names a provider. The
  code constants are the currency USD and the top-up range **10 to 500 USD**; an adapter may **narrow** the range and
  never widen it (`assertValidCapabilities` fails the registry at startup; `assertTopUpAmount` checks an amount before a
  checkout is created).
- **Money is `Usd`**: a positive integer in micro-USD. `ProviderRef` is an opaque id (`isProviderRef`: letters, digits and
  `_ . : -`, at most 255): no card, address, tax id or email is ever stored or carried.
- **The events.** `payment.succeeded` (`creditable` is the net amount that becomes credit; `gross`, `tax`),
  `payment.failed`, `refund.updated` (`status` `pending`/`approved`/`rejected`/`reversed`, `initiatedBy`), `dispute.updated`
  (`opened`/`lost`/`won`, with the dispute id) and `ignored` (a verified event of a type the adapter does not use). Every
  amount is OUR ledger amount, net of tax: the adapter converts cents and subtracts what is not ours.
  `validateBillingEvent` refuses an event with a non-integer amount, an id that is not an opaque id, a time that is not
  ISO 8601 or an unknown status, so nothing past it trusts a provider's number.
- **`WebhookResult`** is `{ ok: true, event }` or `{ ok: false, code }` with a code of
  `BILLING_WEBHOOK_REJECTION_CODES` (`signature_missing`, `signature_invalid`, `signature_expired`, `body_invalid`) and
  nothing else: no body, no header, no secret. An adapter checks the signature over the exact bytes before it reads the
  body, makes no outbound call and touches no database.

**How to add an adapter.** Implement `BillingAdapter`, add it to `getBillingAdapterRegistry()` in `shared.ts`, and run the
shared kit on it: `describeAdapterContract` (parses its fixtures into the normalized events, refuses bad signatures with a
code, no outbound call) and, when it has a webhook, `describeAdapterApplication` (applies what it parsed on every
engine; the same event twice, the same payment under another event id and the wrong order leave the state of one correct
delivery). Both live in `src/test-support/billing-adapter-kit.ts`; the fake adapter in `fake-billing-adapter.ts` is the
model, and `adapter-kit.test.ts` / `adapter-kit.integration.test.ts` show the call. The active adapter is the `adapter`
field of the instance setting `billing_settings` (`manual` when it is not set or not an adapter id); the admin page that
sets it is #504.

## Top-up intents

`billing_topup_intents` (workspace-scoped repository `billing-topup-intents-repository.ts`) is the row the application
writes **before any checkout is created**. It holds the adapter, the amount WE asked for, a state (`pending`, `paid`,
`failed`, `expired`) and the provider's opaque ids of the checkout and the payment once known (unique per adapter,
recorded once, never changed). It is the only thing that maps a payment to a workspace. To find an intent from an event,
before the workspace is known, `billing-topup-intent-directory-repository.ts` (read only, instance level) looks it up by
payment, checkout or intent id, only for the adapter that made it.

## Applying an event

`applyBillingEvent(db, { provider, event })` runs **one database transaction per event**:

1. **Claim** the event id in `billing_webhook_events` (id, outcome, order; no payload). A repeat is `duplicate_ignored`.
   Only `intent_unresolved` lets the same event id be handled again, because the top-up may be known on redelivery.
2. **Resolve** the intent: by the payment, then the checkout, then our own intent id recorded in the event, and every
   other field must agree. An event that names another intent than the payment belongs to, or another payment than the
   one recorded, resolves to nothing: `intent_unresolved`, no change, answered 200. The intent row is locked (Postgres
   `FOR UPDATE`, SQLite one writer), so every event about one payment is applied one after the other.
3. **Order**: a refund or dispute state older than the last one applied is `stale_ignored`.
4. **Bound**: a credit is at least 10 USD and at most the amount of the intent; a refund or dispute is at most what the
   intent credited. Otherwise `amount_rejected` and nothing is written.
5. **Write**: `payment.succeeded` is a `top_up` keyed by the **payment** (D14: two events for one payment credit once, and
   the same payment with another amount is `amount_conflict`) and the intent becomes `paid`; `payment.failed` marks a
   pending intent `failed`; `refund.updated` `pending`/`approved` is a `refund` and a dispute `opened`/`lost` a
   `chargeback`, keyed by the refund or dispute and written **even beyond the unspent balance** (it goes negative and the
   claim refuses the workspace with `balance_negative`); `rejected`/`reversed` and `won` write a `correction` that reverses
   the debit once (`nothing_to_reverse` when there is none yet). A dispute is debited when it opens, because that is when
   the provider takes the money, and when it is lost, whichever is seen first: one `chargeback`.
6. The outcome (`BILLING_EVENT_OUTCOMES`) is recorded with the event id in the same transaction.

Not handled here: cumulative refunds over one payment are bounded per event, not in total; rows of
`billing_webhook_events` are never pruned (they are a few bytes each; the journal key is the second idempotency layer, so
a prune after the provider's retry window is safe and left to a follow-up).

## The webhook route

`POST /api/billing/webhook` (`webhook-handler.ts`, wired in `shared.ts`) is public (`src/auth/access.ts`), runs on Node,
and is the same for every provider. Order: guard (billing off, or the active adapter has no webhook, is the 404 of a path
that does not exist, before the body is read and before any billing table is touched), a raw body limited to 256 KiB (413),
`adapter.verifyAndParseWebhook` over the exact bytes (401 for a missing, wrong, altered or old signature and 400 for a signed
body the adapter cannot read, both with an **empty body**), then `applyBillingEvent` (200 and `{ "outcome": "<code>" }`).
Anything that throws is 500 with an empty body and nothing applied; the provider redelivers. The log names a code only
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
