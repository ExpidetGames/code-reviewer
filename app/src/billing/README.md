# Billing

The optional billing module of the app (ADR 0005, `docs/decisions/0005-providers-model-catalog-and-paddle-billing.md`,
epic #421): billing with Paddle Billing as Merchant of Record. Server-only: every source file imports
`server-only`, and a test (`server-only.test.ts`) fails when a client component reaches the module.

#436 added the building blocks (client, schemas, webhook verifier); #437 added the settings in the admin portal and
the switch. No billing table, webhook route, checkout or sweep exists yet; later issues of the epic add them, and each
starts with `isBillingOn` / `guardBillingRoute` (below).

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
     serializes it. A second request meanwhile gets `webhook_destination_in_progress`.
  4. Paddle is listed first (`GET /notification-settings`; the list carries each destination's `endpoint_secret_key`, as
     the single GET does). A destination with our address is **adopted** (its secret is stored, nothing is created),
     which also repairs a lost answer. If Paddle sent no secret for it, or there are several, it is refused with
     `webhook_destination_exists`: delete it in Paddle, or use `recreate`. Destinations of other addresses are never
     touched.
  5. `recreate` deletes every destination of our address, removes the stored secret, then creates one and stores its
     secret. If it fails half way there is no stored secret (billing cannot be switched on) and a retry creates.
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
  stored webhook secret (and so the destination's identity) unless a new secret comes in the same request; create the
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

## Testing

`fakes/paddle` is the fake Paddle API and the webhook signer; `app/src/test-support/paddle-fake.ts` starts it
(`startTestPaddle`) and points a client at it (`clientFor`). See `TESTING.md`, section 5, and `fakes/README.md`.
No automated test reaches Paddle: the network guard blocks every host but loopback, and a test in this directory
proves it for the real Paddle address.
