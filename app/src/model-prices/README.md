# Catalog prices and enablement

What the admin decides about a model of the models.dev catalog before the **managed key**, which we pay, may use it
(#549, part of epic #420; design: #544, decisions 5 and 7). models.dev prices are community data with errors and gaps, so
**a model is selectable on the managed key only if the admin has enabled it _and_ confirmed its price**. The own key
(BYOK) is not affected: the user pays the provider. **Nothing here is served to a workspace**: a member never sees a raw
provider price, a provider name or a model id (Epic #489, principle 2 of #420; `visibility.test.ts` fails when anything
outside the admin portal imports this module).

| File                                            | Role                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `money.ts`                                      | USD per million tokens (an exact decimal text) to **BigInt micro-USD per million tokens** and back. No float; a price finer than one micro-USD is refused, not rounded                                                                                                  |
| `price-book.ts`                                 | The price book: input, output, cache read, cache write 5-minute and 1-hour, reasoning, audio in and out, the older `context_over_200k` tier, and tiers (up to 64). `null` is "not priced", never zero. JSON form (amounts as decimal strings) for the database and HTTP |
| `overrides.ts`, `model-overrides.v1.json`       | The committed override file (`contracts/model-overrides.v1.json`) and its validated loader                                                                                                                                                                              |
| `effective-price.ts`, `price-hash.ts`           | `effectivePrice`: the book, status, sources; the versioned hash of the reference price                                                                                                                                                                                  |
| `availability.ts`                               | `managedAvailability`: may the managed key use the model, and at which price (what #553 asks at claim time), and its JSON form with the stable refusal codes                                                                                                            |
| `service.ts`, `admin-view.ts`                   | The service (list, enable, confirm, correct, availability) and the admin's view of a model                                                                                                                                                                              |
| `admin-http.ts`, `admin-errors.ts`, `shared.ts` | The handlers of the portal routes, their stable codes and statuses, and the wiring of the running server                                                                                                                                                                |
| `errors.ts`, `confirmation.ts`                  | The stable refusal codes; the type of a confirmation                                                                                                                                                                                                                    |

The tables are `model_enablements` and `model_price_confirmations` (migration `20261020090000_create_model_decisions`,
`src/db/README.md`), the repositories the instance level `model-enablements-repository.ts` and
`model-price-confirmations-repository.ts`.

## Prices

Every amount is a **whole number of micro-USD per million tokens** (`2.5` USD per million tokens is `2500000`), the unit of
`src/billing/`, held as `bigint` in the process and as a decimal string in JSON, so it survives the wire and the database
exactly. A model that is free is `0`; a cache price the book lacks is `null` and the ledger (#553) fails a call that needs it.
models.dev's `cache_write` is the 5-minute price; models.dev has **no 1-hour cache write**, which comes from the override
file or stays unpriced (and the Anthropic 1-hour TTL stays unused).

**Every price models.dev states is kept** (`models-dev/parse.ts` stores it, the book holds it, the hash covers it): input,
output, cache read and write, the price of **reasoning** tokens, **audio** in and out, the older `context_over_200k` tier and
**every tier** in the order models.dev lists them (a sanity bound of 64 tiers; the book sorts them by context size, and two
tiers of one size are no single price). **A price we do not understand is not priced from**: a price field we do not know
(`cost.input_video`), a tier of a kind we do not know (`tier_type.time_of_day`), a malformed tier or more than 64 tiers is
recorded in the stored cost's `unknown` list, and such a model is **`unpriced`** until an admin states the price. We cannot
bill what we do not understand, and the managed key is the one we pay. The `reasoning` and the audio prices are kept, hashed
and shown; whether and how the ledger bills them is #553 (the follow-up says so).

**What is priced from is a whole book, not a merge of fields.** The admin's confirmation holds a whole book (a correction
replaces the whole book); the reference an admin is asked to confirm is models.dev's price with the override file's 1-hour
cache write over it. `price.sources` says per field where each amount of the shown book comes from (`catalog`, `override`,
`admin`), for the admin to read; it decides nothing. **Only a `confirmed` price has a `book`** (`EffectivePrice.book` is
`null` for every other status, so nothing that prices a run can read one by mistake); the other statuses show a price to
look at in `display`.

## Status

`effectivePrice` compares the admin's latest confirmation with today's **reference** price (models.dev plus the override file):

| Status        | Meaning                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmed`   | An admin confirmed or corrected the price, and the reference is what it was then.                                                                                                                                                                                                                                                                       |
| `stale`       | The reference changed after the confirmation (any price of the book, a tier, the override's 1-hour price, the model's `reasoning` flag, or a hash of another version). **Counts as unconfirmed on the managed key until the admin confirms again** (decided 2026-10-19). `price.book` of the view is the old price, `price.reference.book` the new one. |
| `unconfirmed` | There is a price and nobody confirmed it.                                                                                                                                                                                                                                                                                                               |
| `unpriced`    | models.dev states none (or one that cannot be held exactly, or one we do not understand: see "Prices") and nobody stated one. An admin can state it with a correction; a later models.dev price then makes it `stale`.                                                                                                                                  |

"Confirmed" is a hash of the reference stored with the confirmation, so a change back to the confirmed price is not stale.
**The hash is versioned**, `v<n>:<sha256>` (`price-hash.ts`). Version 2 covers every price of the book and the model's
`reasoning` flag (it changes the request, spike #546); the limits are not part of it. **A confirmation whose hash is of another
version than the current one is stale** (the first release wrote the bare digest, which counts as version 1): nothing was in
production when the version changed, so the plain rule is that an admin confirms again. Whoever changes what the hash covers
raises `HASH_VERSION`.

## Who may use a model: `managedAvailability`

In this order: the provider and model exist; the provider is supported and its address trusted (`buildJobModelEntry`'s
refusals, so an address that changed blocks the managed key too); the override file does not **block** the model or **retire**
it (`retiresNotBefore`: never offered after that day); the admin **enabled** it; its price is **`confirmed`**. The answer is
`{ selectable: true, book, confirmationId, hashVersion }` with the confirmed book the ledger prices from and the id and hash
version of the confirmation it comes from, or `{ selectable: false, reason }` (internal; a member is told nothing but that the
model is unavailable). A model models.dev **no longer lists** stays selectable until the admin disables it, and its confirmed
price stays valid (decision of 2026-10-19).

`service.availability(providerId, modelId)` reads it from the database and is **the contract of #553**:

- It answers **JSON as it is**: the amounts are decimal strings of whole micro-USD per million tokens (`bigint` exists only
  inside the process), so `JSON.stringify` works and a claim can carry the book as it is.
- A refusal carries a stable `code` besides the internal `reason`: **`catalog_price_unconfirmed`** when the price is not
  confirmed, no longer is, or is not priced (the code of the release guard of #549 E too), **`catalog_model_unavailable`**
  for every other reason.
- **It never throws.** A database that cannot be read (or an override file that is out of step) is a refusal,
  `{ selectable: false, reason: "check_failed", code: "catalog_model_unavailable" }`, with one log line that carries no detail
  (`AVAILABILITY_CHECK_FAILED`): the caller treats anything but `selectable: true` as "the managed key is not used", and a
  transient failure is told apart by the reason `check_failed`.

## Confirming a price

An admin confirms **the price they saw**: the request carries `referenceHash`, the hash of the reference in the view. If the
reference is different now (the daily fetch moved it), nothing is written and the answer is `price_changed`.

- **Concurrency with the fetch.** The confirmation runs in one transaction that first reads the provider's row `FOR UPDATE`
  on Postgres: the lock the fetch holds while it writes (`listProviders({ forUpdate: true })`, #548). A confirmation made while
  a fetch writes waits, then reads what the fetch wrote and is refused with `price_changed`; one that comes first is kept, and
  a price the fetch moves afterwards makes it `stale`. **The wait is bounded on Postgres**: the transaction sets
  `lock_timeout` (5 seconds, `DEFAULT_LOCK_TIMEOUT_MS`), and a fetch that holds its lock for longer ends the confirmation
  with the stable code `fetch_in_progress` (409), nothing written; the admin tries again. On SQLite every transaction begins
  `begin immediate`. The fetch never writes the confirmation tables, so it cannot overwrite a confirmation. Tested on both
  engines (`service.integration.test.ts`, "a confirmation and the daily fetch").
- **History.** Every confirmation is a new row; the latest counts; the database refuses to change or delete one. Confirming
  again what is confirmed already writes nothing.
- **Correction.** The admin states a whole price book and a reason (one line, 1 to 500 characters), against the reference they
  saw. Sanity bounds: whole micro-USD, at most USD 100,000 per million tokens, up to 64 tiers with ascending `contextOver`.
  A correction of a model models.dev does not price is allowed.
- **A row that cannot be read** (edited outside the app, damaged) is neither "no confirmation" nor the row before it: the
  repository hands it out as unreadable, the list shows that model with the warning `confirmation_unreadable`
  (`price.warnings`) and the status `unconfirmed` instead of failing as a whole, `availability` refuses it, and a new
  confirmation repairs it.

## The "new" flag and enablement

`model_enablements` holds the decision per model; no row means the admin has not decided. **New** is derived: listed, no
decision, and first seen after the first fetch (the models of the first fetch are the starting catalog, not news). There are
**three states of a catalog model for the admin**: `new` (no decision, first seen after the first fetch), `enabled` and
`disabled` (the admin looked and does not want it; there is no separate "dismissed"). Deciding either way ends "new"; the
route `enablement/reset` takes a decision back, so the model has none again and is "new" once more (a model of the first
fetch simply has no decision), without touching its price confirmations. The list carries the count for the portal's badge.
Enabling a model the override file blocks is refused (`model_blocked`). Enabling does not need a confirmed price: the two
are independent and the model is selectable when both hold.

## Routes (admin portal, session authenticated, no token API: #420 C8)

As the admin sees them (the proxy rewrites `/api/admin/...` to `/api/instance-portal/...`). Not signed in is 401, signed in
but not an admin a 404, a change from another site 403, not JSON 415, over 64 KB 413; every answer is `no-store`.

| Route                                             | Body or query                                                                                                    | Answer                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `GET /api/admin/catalog-models`                   | `provider`, `search`, `priceStatus`, `enabled` (`yes`/`no`/`undecided`), `new=true`, `limit` (max 500), `offset` | `{ models, total, newCount, fetch }` |
| `POST /api/admin/catalog-models/enablement`       | `{ providerId, modelId, enabled }`                                                                               | `{ ok: true, model }`                |
| `POST /api/admin/catalog-models/enablement/reset` | `{ providerId, modelId }`: take the decision back ("new" again)                                                  | `{ ok: true, model }`                |
| `POST /api/admin/catalog-models/price/confirm`    | `{ providerId, modelId, referenceHash }`                                                                         | `{ ok: true, model }`                |
| `POST /api/admin/catalog-models/price/correct`    | `{ providerId, modelId, referenceHash, price, reason }`                                                          | `{ ok: true, model }`                |

A refusal is `{ "error": <code>, "issues"?: [{ field, code }] }`: `request_invalid` 422, `model_unknown` 404, `model_blocked`
409, `price_invalid` 422 (field `price`), `price_missing` 409, `price_changed` 409, `reason_invalid` 422 (field `reason`),
`fetch_in_progress` 409, `unavailable` 503. The page translates the codes (#554); an unknown field in a body is `request_invalid`.

Every write that succeeds writes **one audit line** to the server's log after it is stored:
`model prices: MODEL_ENABLED|MODEL_DISABLED|MODEL_DECISION_RESET by=<user> model=<provider>/<model>` (a reset that finds no
decision writes nothing) and
`model prices: PRICE_CONFIRMED|PRICE_CORRECTED by=<user> model=<provider>/<model> old=<book|none> new=<book> [reason="<json string>"]`.
The prices are the JSON books (micro-USD per million tokens); never a key, never a cookie.

## The override file

`contracts/model-overrides.v1.json`, per provider id and model id, each entry with a one-line `reason` and at least one of
`cacheWrite1hPerMTok` (USD per million tokens as a decimal text), `retiresNotBefore` (`YYYY-MM-DD`) and `blocked: true`.
The loader is strict: an unknown field, a negative or inexact price or a missing reason fails the start. A provider that is
not in the supported-provider file (any more) is **drift**, not a broken file: the app still starts, the test
`overrideProviderDrift` fails in CI, and until it is fixed every lookup throws a `ModelOverridesError` with the code
`override_file_provider_unsupported` (the price routes answer `unavailable`, `availability` a refusal). The app reads its identical copy (`model-overrides.v1.json` here; the image holds
`app/` only) and a test compares the two. It is seeded with the 1-hour cache write of the Anthropic models, and a test
compares those with `contracts/anthropic-models.v1.json` until #556 deletes that list. Editing the file is a normal pull
request. A pinned `baseUrl` per provider (mentioned in #548 C) is **not** part of it yet.

## What is not here

The claim-time refusal and the price book in the claim are built (#553, `src/native-cost/README.md`): the claim calls
`availability` and refuses with `managed_model_unavailable`; `catalogPrice` gives an own key the confirmed book or else the
catalog's price. How the ledger bills what the book holds is decided (#551, #553): reasoning tokens at the reasoning price (else
the output price), a tier for a prompt strictly above its size (the older `contextOver200k` is the tier of 200,000), audio
**not at all** (a call with audio tokens is unknown, whatever the book says), a cache read at its own price only (the book of a
claim does not price one as input), a cache write at the price of its lifetime. The pages, the "fetch now" route and the
confirmation of a changed provider address are built (#554: `/admin/catalog`, `src/admin/catalog-models/`,
`src/models-dev/admin-*.ts`). **The release guard on the named entries of #425** is still deferred: the map from a registry slug
to the models.dev id exists now (`src/native-cost/catalog-ref.ts`), the guard needs the screens of #555.

**Order of the cut-over.** `availability` is asked only for a **native** selection (a selection that names a catalog model), and the
registry accepts no native slug yet, so shipping #553 refuses no entry that is released today. The cut-over the comment of #549
describes happens when the wiring lets a managed entry name a catalog model: from then on that entry is refused until an admin
has enabled its model and confirmed its price, so the screens of #554 (live) must have been used before that entry is switched.
