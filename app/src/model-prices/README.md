# Catalog prices and enablement

What the admin decides about a model of the models.dev catalog before the **managed key**, which we pay, may use it
(#549, part of epic #420; design: #544, decisions 5 and 7). models.dev prices are community data with errors and gaps, so
**a model is selectable on the managed key only if the admin has enabled it _and_ confirmed its price**. The own key
(BYOK) is not affected: the user pays the provider. **Nothing here is served to a workspace**: a member never sees a raw
provider price, a provider name or a model id (Epic #489, principle 2 of #420; `visibility.test.ts` fails when anything
outside the admin portal imports this module).

| File                                            | Role                                                                                                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `money.ts`                                      | USD per million tokens (an exact decimal text) to **BigInt micro-USD per million tokens** and back. No float; a price finer than one micro-USD is refused, not rounded                  |
| `price-book.ts`                                 | The price book: input, output, cache read, cache write 5-minute and 1-hour, tiers. `null` is "not priced", never zero. JSON form (amounts as decimal strings) for the database and HTTP |
| `overrides.ts`, `model-overrides.v1.json`       | The committed override file (`contracts/model-overrides.v1.json`) and its validated loader                                                                                              |
| `effective-price.ts`, `price-hash.ts`           | `effectivePrice`: precedence, status, sources; the hash of the reference price                                                                                                          |
| `availability.ts`                               | `managedAvailability`: may the managed key use the model, and at which price (what #553 asks at claim time)                                                                             |
| `service.ts`, `admin-view.ts`                   | The service (list, enable, confirm, correct, availability) and the admin's view of a model                                                                                              |
| `admin-http.ts`, `admin-errors.ts`, `shared.ts` | The handlers of the portal routes, their stable codes and statuses, and the wiring of the running server                                                                                |
| `errors.ts`, `confirmation.ts`                  | The stable refusal codes; the type of a confirmation                                                                                                                                    |

The tables are `model_enablements` and `model_price_confirmations` (migration `20261020090000_create_model_decisions`,
`src/db/README.md`), the repositories the instance level `model-enablements-repository.ts` and
`model-price-confirmations-repository.ts`.

## Prices

Every amount is a **whole number of micro-USD per million tokens** (`2.5` USD per million tokens is `2500000`), the unit of
`src/billing/`, held as `bigint` in the process and as a decimal string in JSON, so it survives the wire and the database
exactly. A model that is free is `0`; a cache price the book lacks is `null` and the ledger (#553) fails a call that needs it.
models.dev's `cache_write` is the 5-minute price; models.dev has **no 1-hour cache write**, which comes from the override
file or stays unpriced (and the Anthropic 1-hour TTL stays unused).

**Precedence, field by field: the admin's correction, then the override file, then models.dev.** Each field of a view
says which one it comes from (`price.sources`).

## Status

`effectivePrice` compares the admin's latest confirmation with today's **reference** price (models.dev plus the override file):

| Status        | Meaning                                                                                                                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmed`   | An admin confirmed or corrected the price, and the reference is what it was then.                                                                                                                                                                                                                   |
| `stale`       | The reference changed after the confirmation (input, output, cache read, cache write, a tier, or the override's 1-hour price). **Counts as unconfirmed on the managed key until the admin confirms again** (decided 2026-10-19). `price.book` is the old price, `price.reference.book` the new one. |
| `unconfirmed` | There is a price and nobody confirmed it.                                                                                                                                                                                                                                                           |
| `unpriced`    | models.dev states none (or one that cannot be held exactly) and nobody stated one. An admin can state it with a correction; a later models.dev price then makes it `stale`.                                                                                                                         |

"Confirmed" is a hash of the reference stored with the confirmation, so a change back to the confirmed price is not stale.
`reasoning` and the limits are not part of it (follow-up for #553: the `reasoning` flag changes the request).

## Who may use a model: `managedAvailability`

In this order: the provider and model exist; the provider is supported and its address trusted (`buildJobModelEntry`'s
refusals, so an address that changed blocks the managed key too); the override file does not **block** the model or **retire**
it (`retiresNotBefore`: never offered after that day); the admin **enabled** it; its price is **`confirmed`**. The answer is
`{ selectable: true, book }` with the confirmed book the ledger prices from, or `{ selectable: false, reason }` (internal; a
member is told nothing but that the model is unavailable). A model models.dev **no longer lists** stays selectable until the
admin disables it, and its confirmed price stays valid (decision of 2026-10-19). `service.availability(providerId, modelId)`
reads it from the database.

## Confirming a price

An admin confirms **the price they saw**: the request carries `referenceHash`, the hash of the reference in the view. If the
reference is different now (the daily fetch moved it), nothing is written and the answer is `price_changed`.

- **Concurrency with the fetch.** The confirmation runs in one transaction that first reads the provider's row `FOR UPDATE`
  on Postgres: the lock the fetch holds while it writes (`listProviders({ forUpdate: true })`, #548). A confirmation made while
  a fetch writes waits, then reads what the fetch wrote and is refused with `price_changed`; one that comes first is kept, and
  a price the fetch moves afterwards makes it `stale`. On SQLite every transaction begins `begin immediate`. The fetch never
  writes the confirmation tables, so it cannot overwrite a confirmation. Tested on both engines
  (`service.integration.test.ts`, "a confirmation and the daily fetch").
- **History.** Every confirmation is a new row; the latest counts; the database refuses to change or delete one. Confirming
  again what is confirmed already writes nothing.
- **Correction.** The admin states a whole price book and a reason (one line, 1 to 500 characters), against the reference they
  saw. Sanity bounds: whole micro-USD, at most USD 100,000 per million tokens, up to 8 tiers with ascending `contextOver`.
  A correction of a model models.dev does not price is allowed.

## The "new" flag and enablement

`model_enablements` holds the decision per model; no row means the admin has not decided. **New** is derived: listed, no
decision, and first seen after the first fetch (the models of the first fetch are the starting catalog, not news). Deciding
either way (enable or disable) ends it; the list carries the count for the portal's badge. Enabling a model the override file
blocks is refused (`model_blocked`). Enabling does not need a confirmed price: the two are independent and the model is
selectable when both hold.

## Routes (admin portal, session authenticated, no token API: #420 C8)

As the admin sees them (the proxy rewrites `/api/admin/...` to `/api/instance-portal/...`). Not signed in is 401, signed in
but not an admin a 404, a change from another site 403, not JSON 415, over 64 KB 413; every answer is `no-store`.

| Route                                          | Body or query                                                                                                    | Answer                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `GET /api/admin/catalog-models`                | `provider`, `search`, `priceStatus`, `enabled` (`yes`/`no`/`undecided`), `new=true`, `limit` (max 500), `offset` | `{ models, total, newCount, fetch }` |
| `POST /api/admin/catalog-models/enablement`    | `{ providerId, modelId, enabled }`                                                                               | `{ ok: true, model }`                |
| `POST /api/admin/catalog-models/price/confirm` | `{ providerId, modelId, referenceHash }`                                                                         | `{ ok: true, model }`                |
| `POST /api/admin/catalog-models/price/correct` | `{ providerId, modelId, referenceHash, price, reason }`                                                          | `{ ok: true, model }`                |

A refusal is `{ "error": <code>, "issues"?: [{ field, code }] }`: `request_invalid` 422, `model_unknown` 404, `model_blocked`
409, `price_invalid` 422 (field `price`), `price_missing` 409, `price_changed` 409, `reason_invalid` 422 (field `reason`),
`unavailable` 503. The page translates the codes (#554); an unknown field in a body is `request_invalid`.

Every write that succeeds writes **one audit line** to the server's log after it is stored:
`model prices: MODEL_ENABLED|MODEL_DISABLED by=<user> model=<provider>/<model>` and
`model prices: PRICE_CONFIRMED|PRICE_CORRECTED by=<user> model=<provider>/<model> old=<book|none> new=<book> [reason="<json string>"]`.
The prices are the JSON books (micro-USD per million tokens); never a key, never a cookie.

## The override file

`contracts/model-overrides.v1.json`, per provider id and model id, each entry with a one-line `reason` and at least one of
`cacheWrite1hPerMTok` (USD per million tokens as a decimal text), `retiresNotBefore` (`YYYY-MM-DD`) and `blocked: true`.
The loader is strict: an unknown field, a negative or inexact price, a missing reason or a provider that is not in the
supported-provider file fails the start. The app reads its identical copy (`model-overrides.v1.json` here; the image holds
`app/` only) and a test compares the two. It is seeded with the 1-hour cache write of the Anthropic models, and a test
compares those with `contracts/anthropic-models.v1.json` until #556 deletes that list. Editing the file is a normal pull
request. A pinned `baseUrl` per provider (mentioned in #548 C) is **not** part of it yet.

## What is not here

The pages (#554), the claim-time refusal that calls `availability` and the price book in the claim (#553), the "fetch now"
route (#554), the release guard on the named entries of #425, and the confirmation of a changed provider address (#554).
