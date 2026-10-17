# Billing

The optional billing module of the app (ADR 0005, `docs/decisions/0005-providers-model-catalog-and-paddle-billing.md`,
epic #421): billing with Paddle Billing as Merchant of Record. Server-only: every source file imports
`server-only`, and a test (`server-only.test.ts`) fails when a client component reaches the module.

This directory is started by #436 with the building blocks; no route, table, page or caller exists yet. Later
issues of the epic add the settings, the plan tables, the webhook route, checkout and the sweep.

| File                | What it is                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `paddle-client.ts`  | A thin typed `fetch` client of the Paddle API. Not the Paddle SDK (ADR 0005, 2.10): about ten endpoints, easier to fake, no dependency. |
| `paddle-schemas.ts` | Our own response schemas (zod): only the fields we read. Unknown fields are dropped, an answer that does not fit is refused.            |
| `webhook-verify.ts` | The pure check of the `Paddle-Signature` header.                                                                                        |

## The client

```ts
const client = createPaddleClient({
  apiKey,
  baseUrl: paddleBaseUrl("sandbox"),
});
```

- **Base URL** is injected: `paddleBaseUrl("sandbox" | "live")`, or the address of the fake (`fakes/paddle`) in a
  test. `paddleKeyEnvironment(apiKey)` reads the environment from the key prefix (`_sdbx` is sandbox,
  `pdl_live_` is live) and from nothing else of the key.
- **Endpoints:** products and prices (create, get, list, patch), transactions (create), subscriptions (get, list,
  patch, preview, cancel), customer portal sessions (create), notification settings (create, get). Wire names
  are Paddle's (`snake_case`), so a request body is what the Paddle docs show.
- **Time limit:** 10 seconds for one request, all of it (`timeoutMs`). No redirect is followed.
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
  `name`, `description`, `custom_data` and `status: "archived"`. Any other field or status is refused too. The
  caller still has to check that no live subscription uses a price before it archives it.
- **Untrusted input:** every response is parsed with our schema (`paddle-schemas.ts`); a field we do not list is
  never passed on.
- **The API key** is sent as the bearer token and used for nothing else. It is never logged and never in an error.

## The webhook verifier

`verifyPaddleSignature({ header, rawBody, secret, now, toleranceSeconds? })` returns `{ ok: true, timestamp }` or
`{ ok: false, code }` with one of `secret_missing`, `signature_missing`, `signature_malformed`,
`signature_mismatch`, `timestamp_out_of_tolerance`.

- The header is `ts=<unix seconds>;h1=<hex>`; `h1` may appear more than once (Paddle sends two while a secret is
  rotated) and one valid value is enough. Unknown keys are ignored.
- `h1` is the HMAC-SHA256 of `<ts>:<raw body>` with the secret of the notification destination. Pass the body
  exactly as it arrived (`await request.text()`), before any JSON parse.
- Every candidate is compared with `timingSafeEqual`, none is skipped after a match.
- The signature is checked **before** the age, so a header made without the secret learns nothing about the
  clock. The tolerance is 5 minutes either way (`PADDLE_SIGNATURE_TOLERANCE_SECONDS`): replay is stopped by the
  dedupe on `event_id`, not by the clock, and Paddle's retries may carry the `ts` of the first try.
- An empty secret is refused (`secret_missing`): a signature made with an empty key is no signature.

## Testing

`fakes/paddle` is the fake Paddle API and the webhook signer; `app/src/test-support/paddle-fake.ts` starts it
(`startTestPaddle`) and points a client at it (`clientFor`). See `TESTING.md`, section 5, and `fakes/README.md`.
No automated test reaches Paddle: the network guard blocks every host but loopback, and a test in this directory
proves it for the real Paddle address.
