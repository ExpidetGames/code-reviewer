# Billing

The optional billing module of the app (ADR 0005, `docs/decisions/0005-providers-model-catalog-and-paddle-billing.md`,
epic #421): billing with Paddle Billing as Merchant of Record. Server-only: every source file imports
`server-only`, and a test (`server-only.test.ts`) fails when a client component reaches the module.

#436 added the building blocks (client, schemas, webhook verifier); #437 added the settings in the admin portal and
the switch; #438 added the plans, their versions and the Free plan; #439 links and validates Paddle prices for a version. No webhook route, checkout, subscription table or sweep
exists yet; later issues of the epic add them, and each starts with `isBillingOn` / `guardBillingRoute` (below).

| File                               | What it is                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `paddle-client.ts`                 | A thin typed `fetch` client of the Paddle API. Not the Paddle SDK (ADR 0005, 2.10): about ten endpoints, easier to fake, no dependency. |
| `paddle-schemas.ts`                | Our own response schemas (zod): only the fields we read. Unknown fields are dropped, an answer that does not fit is refused.            |
| `webhook-verify.ts`                | The pure check of the `Paddle-Signature` header.                                                                                        |
| `settings.ts`                      | The instance setting `billing_settings` and the rules for what may be saved (pure).                                                     |
| `public-url.ts`                    | Whether an address is one Paddle can reach: https, no credentials, no loopback, private, link-local or local name (pure).               |
| `settings-service.ts`              | What the admin page reads and changes: settings, the two secrets, the connection check, the notification destination, the switch.       |
| `admin-http.ts`, `admin-errors.ts` | The handlers of `/api/admin/billing` and their stable error codes.                                                                      |
| `enabled.ts`                       | `isBillingOn` and `guardBillingRoute`: the first question of every billing route, page and sweep step.                                  |
| `enabling-copy.ts`                 | What the admin is told before switching billing on.                                                                                     |
| `webhook-events.ts`                | The event types the notification destination subscribes to, and the webhook path.                                                       |
| `shared.ts`                        | The wiring of the running server (database, secret store, Paddle's address for the environment, `BETTER_AUTH_URL`).                     |
| `plans-service.ts`                 | The plans, their versions and the Free plan: what the plans page reads and changes (#438), below.                                       |
| `plans-http.ts`                    | The handlers of `/api/admin/billing/plans` and their order of checks.                                                                   |
| `plan-rules.ts`                    | The pure rules for a plan, its display fields and the terms of a version (stable codes in `plan-errors.ts`).                            |
| `plan-entitlements.ts`             | From a plan version to the entitlements it writes; cannot build a payload without `modelAccess`.                                        |
| `price-rules.ts`                   | The pure check of a Paddle price against the slot of a version, and the integer comparison of amounts (#439), below.                    |
| `price-view.ts`                    | The cached price next to the entered amount, the drift, and whether a version is sellable (pure).                                       |
| `price-errors.ts`                  | The stable codes of a refused link and their HTTP status.                                                                               |
| `prices-service.ts`                | Links a Paddle price to a slot of the current version and refreshes the cache. Reads from Paddle, never writes (#439).                  |

## The client

```ts
const client = createPaddleClient({
  apiKey,
  baseUrl: paddleBaseUrl("sandbox"),
});
```

- **Base URL** is injected: `paddleBaseUrl("sandbox" | "live")`, or the address of the fake (`fakes/paddle`) in a
  test. `paddleKeyEnvironment(apiKey)` reads the environment from the key prefix (`pdl_sdbx_` is sandbox,
  `pdl_live_` is live) and from nothing else of the key. When the base URL is Paddle's own, the key must belong to
  that environment: `createPaddleClient` throws `environment_mismatch` otherwise (a sandbox key against the live
  address, the reverse, or a key of unknown prefix). Any other address (the fake) takes any key.
- **Endpoints:** products and prices (create, get, list, patch), transactions (create), subscriptions (get, list,
  patch, preview, cancel), customer portal sessions (create), notification settings (create, get, list, delete). Wire names
  are Paddle's (`snake_case`), so a request body is what the Paddle docs show.
- **Time limit:** 10 seconds for one request, all of it (`timeoutMs`). No redirect is followed. **Size limit:** a
  body is read in chunks and dropped once it passes 2,000,000 bytes (a larger `content-length` is refused without
  reading); the call fails with `invalid_response` (for an error status, with its status code and no `paddleCode`).
- **429:** retried after `Retry-After`, at most `maxRateLimitRetries` times (default 2) and only when the wait is
  at most `maxRetryAfterSeconds` (default 30); otherwise `rate_limited` with `retryAfterSeconds`. **Nothing else is
  retried.** Paddle has no idempotency keys: after `timeout`, `network_error` or `server_error` on a create, list
  first (a price has no `custom_data` filter, so list by product and match `custom_data` yourself, ADR 0005, 2.11)
  and only then create again.
- **Errors** are `PaddleClientError` with a stable `code` (`PADDLE_CLIENT_ERROR_CODES`), the HTTP `status`,
  Paddle's own `paddleCode` when it is a plain identifier (`subscription_locked_renewal`) and `retryAfterSeconds`.
  They never hold a response body, a header or the API key; the UI translates the code to copy.
- **Money guardrail (ADR 0005, 2.11):** `updatePrice` refuses, before anything is sent, a PATCH of `unit_price`,
  `unit_price_overrides`, `billing_cycle`, `trial_period` or `tax_mode` (`price_field_immutable`). Allowed:
  `name`, `description`, `custom_data` and `status: "archived"`. Any other field or status is refused too. The wire
  body is a fresh object with only these keys, each read once, so what is checked is what is sent. This is **the
  app's policy, not a Paddle behaviour**: Paddle documents the PATCH of those fields as accepted (research S1 leaves
  open whether it locks them for a price in use), and the fake accepts them too. The caller still has to check that
  no live subscription uses a price before it archives it.
- **Untrusted input:** every response is parsed with our schema (`paddle-schemas.ts`); a field we do not list is
  never passed on.
- **The API key** is sent as the bearer token and used for nothing else. It is never logged and never in an error.

## The webhook verifier

`verifyPaddleSignature({ header, rawBody, secret, now, toleranceSeconds? })` returns `{ ok: true, timestamp }` or
`{ ok: false, code }` with one of `secret_missing`, `signature_missing`, `signature_malformed`,
`signature_mismatch`, `timestamp_out_of_tolerance`, `tolerance_invalid`.

- The header is `ts=<unix seconds>;h1=<hex>`; `h1` may appear more than once (Paddle sends two while a secret is
  rotated) and one valid value is enough. Unknown keys are ignored.
- `h1` is the HMAC-SHA256 of `<ts>:<raw body>` with the secret of the notification destination. Pass the body
  exactly as it arrived (`await request.text()`), before any JSON parse.
- Every candidate is compared with `timingSafeEqual`, none is skipped after a match.
- The signature is checked **before** the age, so a header made without the secret learns nothing about the
  clock.
- **Tolerance.** The default is 5 minutes either way (`PADDLE_SIGNATURE_TOLERANCE_SECONDS`) and is an explicit
  parameter (`toleranceSeconds`): the caller (#441) can change it without touching the verifier. A non-finite or
  negative value is refused (`tolerance_invalid`) rather than accepting every age. The default is right only if Paddle
  signs each retry with a fresh `ts`. **That is unverified (research S3)** and must be checked in the sandbox before
  go-live (#441, #448): make the endpoint answer 500 once and compare the `ts` of the two tries.
  - Replay of a processed event is not stopped by the clock but by the dedupe on `event_id` (#441).
  - If the retries keep the `ts` of the first try, the fallback is to pass a wider `toleranceSeconds` that covers
    Paddle's retry window. The signature still binds the body and the secret, and the `event_id` dedupe stops a
    replay, so a wide window costs no safety. Until then a retry after more than 5 minutes would be refused with
    `timestamp_out_of_tolerance`, exactly the outage case retries exist for.
- An empty secret is refused (`secret_missing`): a signature made with an empty key is no signature.

## Billing is off unless it is configured (#437)

Billing is on when `billing_settings.enabled` is true **and** the credentials are complete (an API key, a webhook
secret, the client-side token). Until then it is inert:

- `isBillingOn(db, secrets)` reads one instance setting and, only when the switch is on, whether the two secrets are
  stored **and readable**: a secret that cannot be decrypted (another `APP_SECRET`) counts as missing, because billing
  could neither call Paddle nor verify a webhook. It calls nobody. **Every later billing route, page and sweep step calls it first.**
- A billing route (the webhook, checkout, the plan page's data) wraps its handler in `guardBillingRoute({ isOn,
notFound }, handler)`: while billing is off it answers Next.js's own 404 of a path that does not exist, and neither
  the handler nor any billing table nor Paddle is reached.
- The admin routes below configure billing, so they work while it is off, for the instance admin only. A self-hoster
  who never opens the page sees no change, and nothing calls Paddle. There is no environment variable (`.env.example`
  is unchanged).

### The settings

| Where                               | What                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| instance setting `billing_settings` | `environment` (`sandbox` default, or `live`), `clientToken` (public by design), `graceDays` (0 to 90, default 7), `enabled`                        |
| secret `paddle_api_key`             | Encrypted in `secrets` (`SECRET_NAMES`), write-only; the page shows configured, unreadable or missing and the last four characters of a long value |
| secret `paddle_webhook_secret`      | The same; entered by hand or stored from Paddle's answer to the creation of the notification destination                                           |

Routes (all `Cache-Control: no-store`, errors `{ "error": <code> }`, codes in `admin-errors.ts`):

- `GET /api/admin/billing`: the view (never a secret), including `ownKeyWorkspaces`, the count of workspaces that hold a
  stored own key and have no entitlements row of the operator.
- `PUT /api/admin/billing`, exactly one of `{ settings }` (the two secrets are optional there; an empty one keeps the
  stored one), `{ removeSecret: "apiKey" | "webhookSecret" }`, `{ enabled: boolean }`.
- `POST /api/admin/billing/check`: one `GET /products?per_page=1` with the stored key. Answers `{ ok: true }` or
  `{ ok: false, error }` with `api_key_missing`, `api_key_unreadable`, `paddle_key_rejected`, `paddle_rate_limited`,
  `paddle_unreachable` or `paddle_unavailable`.
- `POST /api/admin/billing/notification-destination`, body `{}` or `{ "recreate": true }`: makes sure the notification
  destination exists, with `BETTER_AUTH_URL` plus `/api/billing/webhook` and the handled events (`webhook-events.ts`),
  and that its `endpoint_secret_key` is the stored webhook secret (it goes into no answer). Steps, in order:
  1. The address must be public: https, no credentials, no loopback, private, link-local or local host, else
     `webhook_url_not_public` (nothing is sent to Paddle). There is **no opt-out**; a test injects a public-looking
     address (`BILLING_TEST_PUBLIC_URL` in the admin harness) and talks to the fake Paddle.
  2. A stored webhook secret refuses it with `webhook_secret_exists` (use `recreate`). Billing on refuses `recreate`
     with `billing_disable_first`.
  3. One create at a time: a lease (instance setting `billing_destination_lock`, 60 s, taken over when it ran out)
     serializes it, and a request releases only the lease it took (one taken over after it ran out is left alone). A second
     request meanwhile gets `webhook_destination_in_progress`.
  4. Paddle is listed first (`GET /notification-settings`). **Unverified assumptions, sandbox check S9 in #448:** that
     each item of the list carries `endpoint_secret_key` (the single GET does), and that the list is unpaginated. The
     client follows `meta.pagination.next` when a page says `has_more` (up to 20 pages, then it refuses with
     `invalid_response`, shown as `paddle_unavailable`), so a destination of ours on a later page is found and not
     created twice. A destination with our address is **adopted** (its secret is stored, nothing is created), which
     also repairs a lost answer. The addresses are compared in one spelling (lower-case host, no default port, no
     trailing slash), also `BETTER_AUTH_URL`. **Fail-safe if the list leaves the secret out:** nothing is adopted and
     nothing is written; the answer is `webhook_destination_exists` (also when there are several), and `recreate`
     repairs it, because the create answer carries the secret. Destinations of other addresses are never touched.
  5. `recreate` first touches the `billing_settings` row (a compare-and-set, so a switch-on racing it makes one of the
     two answer `billing_settings_changed`), then deletes every destination of our address, removes the stored secret,
     creates one and stores its secret. If it fails half way there is no stored secret (billing cannot be switched on) and a retry creates.
  6. If the secret could not be stored after Paddle created the destination, the answer is
     `webhook_secret_not_stored` (503) with the `destinationId`, and a fixed line is logged with the id. A new try
     adopts that destination, so it is never orphaned.

Rules:

- **Environment and key.** `pdl_sdbx_…` is a sandbox key, `pdl_live_…` a live key, anything else is refused
  (`api_key_invalid`). A key of the other environment is refused with `billing_environment_mismatch`, also when the
  environment is switched under a stored key of the other one (send the new key in the same request). A stored key that
  cannot be read does not let the environment switch through (`api_key_unreadable`): enter the key again.
- **One environment for every credential.** The client-side token starts with `test_` (sandbox) or `live_` (live) and
  is refused for the other environment (`client_token_environment_mismatch`). Switching the environment forgets the
  stored webhook secret (and so the destination's identity), after the guarded write went through, unless a new secret
  comes in the same request; create the
  destination again for the new environment. Switching on re-checks the stored key and the token against the
  environment (`billing_environment_mismatch`).
- **Two admins.** Every write of `billing_settings` is conditional on the row as it was read. A request that finds the
  settings changed meanwhile writes nothing and answers `billing_settings_changed`; reload and retry. Saving never
  writes `enabled` from an old read. Switching on enables exactly the settings it checked, and removing a secret counts
  as a change; switching off retries and always wins. Not covered: a key or webhook secret saved in the instant after
  another tab switched billing on, before the secret write of the save lands, is not checked again (the page offers the
  connection check at any time).
- **Enabling** needs a stored, readable API key, a stored webhook secret, a client-side token **and a connection check
  that passes now** (it is made at that moment, not remembered). Otherwise `billing_incomplete` with `missing`, a list of
  `api_key_missing`, `webhook_secret_missing`, `client_token_missing`, `connection_check_failed`. Switching off is always
  possible.
- **While on**, the environment and the credentials stay: changing the environment or removing a secret is refused with
  `billing_disable_first`, and the client-side token cannot be emptied. Rotating a key or a secret is allowed; a new
  API key is checked against Paddle first and is refused (`paddle_key_rejected`, …) without replacing the old one.
- **The notice** (`enablingNotice`): enabling puts workspaces without a subscription on the Free plan, which is managed;
  the own key is then not used, and the jobs of a workspace that holds a stored own key end `own_key_requires_plan` until
  it buys an `own` plan or deletes the key (ADR 0005, M19). The page shows the count. Until billing writes entitlements of
  its own (a later issue), every `workspace_entitlements` row is the operator's, so "no manual row" is "no row".
- **The operator can decrypt the secrets** by design (ADR 0001, 2.7). Live and sandbox have separate destinations and
  secrets; the page warns when the environment is switched.
- **Logs.** Nothing here logs a key, a secret or a Paddle answer; a failure logs a fixed line with no detail.

## Plans and plan versions (#438)

The operator sells **plans** (`billing_plans`) and a plan's terms are **versions** (`billing_plan_versions`, migration
`20261018120000_create_billing_plans`, `src/db/README.md`). Both tables are instance level (`billing-plans-repository.ts`,
`billing-plan-versions-repository.ts`; classified in `scoping.test.ts`). Nothing here is read or written while billing is off:
the plans page shows a notice, the data routes answer the 404 of a missing path (`guardBillingRoute`, after the admin check),
and `default_entitlements` stays the operator's. Instance admin only.

**Data model.** A plan: `plan_key` (unique, chosen once), `name`, `description`, `sort`, `kind` (`free`, `paid`, `contact`),
`offered`, `popular`, `contact_target`, `archived_at`. A version: `number`, `role` (`current` or `legacy`), `key_mode`
(`managed` or `own`), `limits` (the four limits of the entitlements), `model_access` (a managed version: `{ catalogEntries }`,
`null` inside it is every released entry; `NULL` for an `own` version), `monthly_amount_minor` and `yearly_amount_minor` (USD
minor units, tax inclusive, `NULL` for none). Later issues add the Paddle price links to a version (#439, #440) and the
subscriptions that pin one (#441).

**Why the two tables reference users.** `billing_plans.updated_by` and `billing_plan_versions.created_by` say who last changed
a plan and who made a version: the audit trail of a price or a limit that customers were sold, which the operator will want to
read back when a subscriber asks why the terms are what they are. They are foreign keys to `users` with `on delete set null`,
like `model_catalog_entries.updated_by`, so deleting an account never deletes a plan or a version; the account merge moves them
to the surviving account (`github-signin/merge.ts`, and `merge.integration.test.ts` fails for a user column that is not listed
there). `created_by` is the one column of a version that may change after it was written (the merge and the deletion of a user
rewrite it), which is why the guard below names it.

**A version is the sold unit.** Saving the price, the limits, the key mode or the model access creates the next version
(`createNext`: the previous current one becomes `legacy` in the same transaction); a version is never updated except for that
role, and the repository offers no other update (a unit test pins the list of its functions). The **database enforces it too**:
migration `20261018140000_protect_billing_plan_versions` adds triggers that refuse a delete and an update of any column but
`role` and `created_by` (message `billing_plan_versions_immutable`), for whichever app instance or SQL writes. A test updates
every column the table has and fails for one the trigger does not protect, so a later issue that adds a column to the table
(#439, #440) has to extend the trigger (SQLite lists the frozen columns; the Postgres trigger compares the whole row without the mutable ones, so a column that must stay frozen needs no change, and a column that must be mutable needs a migration that replaces `billing_plan_versions_guard()`, as `20261018160000_create_billing_plan_prices` does for the two price links). The caller states the number of
the version it saw (`basedOnVersion`): another number means somebody saved meanwhile (`plan_changed`), and two writers that read
the same version cannot both win (a partial unique index on the one `current` version per plan and the unique `(plan, number)`).
Terms equal to the current version are refused (`plan_version_unchanged`). In short: **versions are immutable except `role`, and the price
links, which may be relinked until a subscription uses the version (enforced in #441/#442)**; a link is replaced, never cleared (below).
The page asks for a confirmation that names the
version and says that existing subscribers keep theirs, and names a change of key mode.

**Edited in place (no new version):** `name`, `description`, `sort` (the display order: ascending, ties by plan key, every kind),
`offered`, `popular` and the `contact_target` of an Enterprise plan. At most one plan is `popular`, and only a `paid` one: setting
it clears the old one in the same transaction (the answer names the plan that lost it, the page asks before it moves the badge),
and a partial unique index plus a check make the database refuse a second one or a Popular Free plan
(`popular_requires_paid_plan`). A `contact` plan cannot be `offered` without an https link or a `mailto:` address
(`contact_target_required`, `contact_target_invalid`).

**Key mode** (ADR 0005, M18). `own_plan_requires_paid_plan`, `model_access_requires_managed_plan` (an `own` version has no model
access, the table checks it too), `cost_limit_requires_managed_key` (the existing code: no operator cost limit next to `own`),
`free_plan_key_mode_fixed`, `plan_key_mode_invalid`. The form hides the model list and the operator cost limit for `own`, starts
its run limits **unlimited** (empty field, `null`; a form default, not an amount) and keeps every limit and the own-key cost limit
editable. The plans page warns (non-blocking) when workspaces with a stored own key exist and no `own` plan is offered
(not archived); that count is the one of the billing page.

**Prices** are admin data: typed as dollars and cents (`parseUsdToMinor`, at most two decimals, shared by the form and its tests
in `src/admin/ui/plan-money.ts`), stored as integers in minor units. A paid version needs a monthly price (a positive integer);
the yearly price is optional, **an amount and not a discount** (the plan screen computes "save N%" from the two, #443), and no
yearly price means no yearly option; there is no `yearly_enabled`. A price is at most `PRICE_MAX_MINOR` (1,000,000 USD in cents,
`plan-money.ts`): the columns are `integer`, which Postgres holds as int4 (at most 2,147,483,647), and a larger amount is
refused by the service as `plan_price_invalid` before the database could answer "out of range". A `free` or `contact` plan has no price
(`plan_price_not_allowed`), a bad amount is `plan_price_invalid`. No amount, limit or price is a constant of the code; the seeded
Free limits are the starting values of an editable version. #439 must refuse a Paddle price whose amount differs from the
entered one and #440 must create the price from it.

**The Free plan.** Seeded the first time billing is switched on (`enable`, called by the switch in `settings-service.ts` inside the
transaction that flips it: if it cannot be written nothing is switched on and the request fails `unavailable`): kind `free`, key mode `managed` (fixed), 10 Diff and
2 Dynamic runs per month, `modelAccess` `[]` until the operator picks entries, no price, never deleted or archived, no checkout.
Its **current version is written to `default_entitlements` with the marker `source: billing`** on enabling, on every new Free
version and when the Free plan is renamed (the plan label is the name), in the same transaction as the change. The period start
is the first day of the current UTC month and never moves back; **the monthly rollover of the Free period is not written by
this issue**: it is #465 (until it exists, Free usage is counted from the month in which the default was last written). The writer is `setBillingDefaultEntitlements`, whose argument type requires `modelAccess`
(`plan-entitlements.ts` throws for a managed version without one), so billing never relies on "an omitted `modelAccess` keeps the
stored one": a paid to Free or Free to paid write replaces the list, and an `own` version states `{ catalogEntries: null }`
(nothing reads it). The default is a fallback for workspaces without a row; a `manual` workspace row is never touched.

**While the billing switch is on, a write to the default through the operator API is refused** `409 entitlements_default_managed_by_billing`
(`switch.ts` reads the switch alone, since the operator API may not reach the secret store; the portal has no such write; a
future one must refuse it the same way). **Switching billing off** removes a default that billing wrote (marker `billing`) and
leaves one the operator wrote; the plans stay. Enabling again re-writes the Free default. **Enabling replaces a default the
operator had, and switching off does not bring it back** (the instance has no default then, which is unlimited); the enabling
notice says so (`enabling-copy.ts`).

**A default with the marker never outlives a switched off billing** (review of #462, N2, N3). Everything that writes the default
takes the same lock (`lockDefaultEntitlements`, an advisory transaction lock on Postgres; SQLite's transactions are
serialized) and reads the switch under it:

- Switching on is one transaction: the switch is flipped and the Free plan seeded with its default (`plans.enable(adminId,
transaction)`). A crash or a failure in between leaves billing off and nothing seeded; a repeated enable that fails changes
  nothing (billing stays on with the default it had).
- Switching off is one transaction: the switch is flipped and a default with the marker removed (`plans.release(transaction)`),
  also when billing was already off and a marker was left behind. A failure in between keeps the switch on.
- `setBillingDefaultEntitlements` reads the switch in its own transaction and writes nothing (returns `false`) while it is off, so
  a Free save that was in flight when billing was switched off cannot leave the marker behind.
- The operator API write reads the switch in its transaction too (`setDefaultEntitlementsUnlessBilling`), after the early check
  of the request, so a switch-on in between is refused with the 409 and its default is not overwritten by an unmarked one.

**Enterprise** is a `contact` plan: name, text, contact target, no versions, no price, no checkout (`contact_plan_has_no_versions`).
**Archive** hides a plan from new subscribers (and clears `offered` and `popular`; the Free plan cannot be archived). A plan with
versions is not deleted (`plan_has_versions`: its subscribers bought them), an Enterprise plan is; the Free plan never
(`free_plan_not_deletable`).

**Routes** (`plans-http.ts`; the files are `src/app/api/instance-portal/billing/plans/route.ts` and `.../plans/[planKey]/route.ts`,
and the proxy's `/admin` rewrite serves them under the public address `/api/admin/billing/plans`, the page `/admin/billing/plans` is
`src/app/(app)/instance-portal/billing/plans/page.tsx`; all `Cache-Control: no-store`, errors `{ "error": <code>, "field"?, "issues"? }`, a write answers
`{ ok: true, clearedPopular, plans }`):

- `GET /api/admin/billing/plans`: the plans in display order with their versions, the catalog entries to pick from (id, name,
  provider and model for the admin's own view) and the warnings.
- `POST /api/admin/billing/plans`: a `paid` plan with its first terms, or a `contact` plan.
- `PUT /api/admin/billing/plans/:planKey`, exactly one of `{ metadata }`, `{ terms: { basedOnVersion, terms } }`,
  `{ archived: boolean }`, `{ priceLink: { versionNumber, interval, paddlePriceId } }` and `{ refreshPrices: true }` (#439, below).
- `DELETE /api/admin/billing/plans/:planKey`.

Order: admin (401 / the 404 of a missing path), billing on (else the 404 of a missing path), same origin and JSON body, rules.

## Linking Paddle prices (#439)

The first, small way to get a sellable plan (ADR 0005, M5): the operator creates the product and the prices in the Paddle
dashboard and pastes the price ids into the plans page. The version already holds the amounts entered in #438 (a required
monthly price and an optional yearly price, USD, tax inclusive, minor units); the link form has **no amount field**, and the route reads
nothing but `{ versionNumber, interval, paddlePriceId }` (any other key is `price_input_invalid`). The app only **reads** from
Paddle (`GET /prices/{id}`); it never changes a price and never changes an entered amount to fit one. Prices are never deleted.

**Data.** `billing_plan_prices` is the cache of one Paddle price: what Paddle said (interval, frequency, currency, amount as
Paddle's string of minor units, tax mode, overrides, trial days, status) at `snapshot_at`. `paddle_price_id` is unique, a price
belongs to one plan, and any number of versions may share it. `origin`, `intent_id`, `state` and `last_error_code` are
for #440 (the app creating prices); a linked price is `linked` / `ready`. `billing_plans.paddle_product_id` and
`paddle_product_env` are set by the first price that is linked (a conditional write that does not touch `updated_at`), and every
later price must belong to that product and environment. `billing_plan_versions.monthly_price_id` and `yearly_price_id` are
the only columns of a version beside `role` (and the audit `created_by`) that change after it was saved: they say which price a slot is sold with.
A version is linked only while it is the **current** one (`plan_changed` otherwise): a legacy version keeps the prices its
subscribers bought. The statement that writes the link itself says `where role = 'current'` and the service undoes the whole
link transaction (the product binding and a new price row too) when it hit no row, because on Postgres the earlier read of the
role proves nothing once another admin commits: an admin who links while another saves new terms gets `plan_changed`, and the
legacy version keeps what it had. **A link is relinked, never cleared**: the service answers `price_link_not_clearable` to a request
without a price id, and the database refuses a link that becomes empty (message `billing_plan_versions_immutable`, both engines).
Relinking is a compare-and-set on the link the service read (the version's slot before Paddle was asked): two admins relinking one
slot at once cannot overwrite each other, the second gets `price_link_changed` (409) and decides again; a slot that already holds the
price asked for is simply done. Until a subscription uses the version nothing but this app code and the Paddle subscription itself
pins the price a subscriber bought (#441/#442 must forbid relinking a version with live subscriptions).
The identity of a price row (`id`, `plan_id`, `paddle_env`, `origin`, `created_at`) never changes and the Paddle price id is set once
(trigger, message `billing_plan_prices_immutable`; a test names every column as frozen, write once or mutable). A yearly link needs a yearly amount on the version (`price_yearly_not_entered`, answered before Paddle is asked).

**The checks** (`price-rules.ts`) run in a fixed order and report one code, so the same price always gets the same answer:
`price_not_active` (status), `price_not_recurring`, `price_interval_mismatch` (the interval of the slot, frequency 1),
`price_currency_mismatch` (USD), `price_tax_mode_mismatch` (`internal`; `account_setting`, `external` and `location` are refused),
`price_amount_mismatch`, `price_has_overrides`, `price_quantity_unsupported` (the quantity limits must allow a quantity of one:
minimum 1, maximum at least 1; checkout buys one), `price_product_mismatch`. Before them: `price_environment_mismatch` (the plan's
product, the stored price or billing is on the other environment), `price_used_by_other_plan` and `price_not_found` (Paddle's 404).
A mismatch is answered with `entered` and `paddle` (an amount in minor units as text), never by editing either side.
Paddle's text is untrusted: a currency is passed on, cached and shown only when it is three capital letters, anything else is
the placeholder `???` and a currency mismatch. **The amount is compared
as integers**: the entered number and Paddle's string of digits (`"1000"` equals 1000; a decimal point, an exponent, a sign or
a space is no amount, and a number beyond a float's precision keeps every digit). Paddle problems have their own codes
(`api_key_missing`, `paddle_key_rejected`, `paddle_rate_limited`, `paddle_unreachable`, `paddle_unavailable`) and nothing is stored.

**Drift and sellable.** The plans view shows, per slot, the cached price next to the entered amount, with `drift`: the first
rule the cached price breaks now (the same checks on the cache, plus the environment). Refreshing (`{ refreshPrices: true }`,
or later `price.updated`) reads every price of the plan again with `GET` and replaces the cache; a price archived in Paddle, or whose
amount, interval, currency, tax mode or quantity limits no longer fit, shows a drift badge and the version is not `sellable`. A price
that Paddle cannot answer does not stop the others: they are read and cached, and the answer names each price that failed (the code
of the first as `error`, one issue per price with its id as the field); a refused key ends the run, since every read would fail alike.
`sellable` comes from the cache and is stale until the next refresh: **checkout (#443) must read the price from Paddle right before it
opens a checkout** and not trust it. A plan is bound to the first Paddle product and environment it is linked to
(`price_environment_mismatch` afterwards); there is no unbinding, so moving from sandbox to live needs its own step (go-live checklist, #448). A version is
`sellable` when every slot it has an entered amount for is linked to a price without drift; a version without a yearly price needs no yearly price.
The trial is read from the price (months and years count as 30 and 365 days, for display); the app sets none.

## Testing

`fakes/paddle` is the fake Paddle API and the webhook signer; `app/src/test-support/paddle-fake.ts` starts it
(`startTestPaddle`) and points a client at it (`clientFor`). See `TESTING.md`, section 5, and `fakes/README.md`.
No automated test reaches Paddle: the network guard blocks every host but loopback, and a test in this directory
proves it for the real Paddle address.
