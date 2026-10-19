# The models.dev catalog

The catalog of the providers and models a job can use, **read from models.dev at run time, once a day, into the
database** (#548, part of epic #420; design: #544). Every new model of a provider we support used to cost an app release,
because the lists, prices and limits were kept by hand; this module replaces that for the providers the pinned OpenCode
can drive with a static key (about 210 of the 232 that models.dev lists). **The catalog is empty until the first fetch,
and nothing reads it yet** (the consumers are #549, #550, #553, #554 and #555), so a workspace sees no change. Everything
that comes from models.dev is untrusted data.

| File                                                  | Role                                                                                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wire.ts`                                             | The four wire families (`openai-chat`, `openai-responses`, `anthropic-messages`, `google`), the key header of each and the reasons a provider is left out |
| `opencode-providers.ts`, `opencode-providers.v1.json` | The supported providers: the app's copy of `contracts/opencode-providers.v1.json` (the image holds `app/` only; a test compares the two)                  |
| `settings.ts`                                         | `MODELS_DEV_URL` and `MODELS_DEV_FETCH`                                                                                                                   |
| `fetch.ts`                                            | One request: size cap before parsing, time limit, no redirect, a stable code per failure (`errors.ts`)                                                    |
| `parse.ts`                                            | The strict tolerant schema; the filters; the reduced rows                                                                                                 |
| `upstream-url.ts`                                     | The address check, trust on first use and the block on change                                                                                             |
| `plan.ts`                                             | What a fetch writes (new, changed, unlisted, returned) and the guard                                                                                      |
| `service.ts`, `shared.ts`, `startup.ts`               | The fetch end to end, with a lock; the sweep and the timer of a long-lived server call `refreshIfDue`                                                     |
| `job-entry.ts`                                        | `buildJobModelEntry`: the secret-free entry of one provider and one model for a job (`contracts/job-model-entry.v1.json`)                                 |
| `generic-adapter.ts`                                  | The provider adapter built from catalog rows, with a best-effort key test per family                                                                      |
| `catalog.ts`                                          | The stored types                                                                                                                                          |

The tables are `models_dev_providers`, `models_dev_models` and `models_dev_fetch_state` (migration
`20261019200000_create_models_dev_catalog`, `src/db/README.md`); the repository is the instance level
`src/db/repositories/models-dev-repository.ts`. The catalog is not customer data: no workspace owns a row. A member never
sees a model id from here (principle 2 of #420); the admin screens (#554) escape every string they show.

## When it runs

- **Hosted (serverless):** the cron sweep (`src/dispatch/sweep.ts`, step `models_dev`, every 2 hours) asks
  `refreshIfDue`. There is no cron of its own.
- **A long-lived server (Docker, Coolify):** a timer (`startup.ts`) asks at the start and every hour, in production only.
- `refreshIfDue` fetches when the last success is more than **23 hours** old and the last failure more than **an hour**
  old, so a tick every two hours gives about one fetch a day and a restart does not fetch again. The day is kept in
  `models_dev_fetch_state`, so every instance sees the same one; a database try-lock (`MODELS_DEV_LOCK`) lets one run work
  and the others answer `already_running`.
- `refresh()` fetches now. It is what the admin's "fetch now" action will call (#554: the route and the button; this issue
  has the service function only), also for a model that is newer than the last fetch (#555).

| Variable           | Meaning                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MODELS_DEV_URL`   | Where the catalog is read from; default `https://models.dev/api.json`. An `http` or `https` address without credentials; anything else keeps the default and warns. A mirror for an instance that cannot reach it. |
| `MODELS_DEV_FETCH` | `off` (also `false`, `0`, `no`) switches the fetch off: no call, no row, no timer, nothing changes for any workspace.                                                                                              |

## What is stored

- **Only supported providers** (`contracts/opencode-providers.v1.json`: SDK, wire family, key header, and for a provider
  that states no address the address of its SDK) **and only models with `tool_call: true`**: the pinned engine does not
  enforce that flag (spike #546), so the catalog does. Cloud-IAM providers (Bedrock, Vertex, Azure, SAP, Cloudflare,
  Snowflake), OAuth providers (GitHub Copilot, GitLab) and providers whose SDK is installed at run time (venice, aihubmix,
  merge-gateway, qvac, watsonx, salad-cloud) are `excluded` with a reason, as are two bundled SDKs with a wire of their own
  (Cohere, the Vercel AI Gateway) and three providers whose address needs an account value. A provider that models.dev adds
  later is unknown and ignored until the file is derived again (`pnpm opencode-providers:derive --from <api.json>`). A
  unit test fails while the commit in the file is not that of `runner/opencode-pin.json`: a pin bump is the moment to
  derive it again.
- **Not a language model** (a model with a `type`: embedding, image, video, speech, rerank) and **a model that carries a
  `provider` of its own** (another SDK or address, which would change the wire or where the key goes) are skipped and counted.
- **A reduced row:** ids, name, family, limits (context, output, input), `reasoning`, `temperature`, `attachment`,
  `modalities`, `status`, `cost` (input, output, cache read, cache write, context tiers) as exact decimal strings of USD per
  million tokens, `last_updated` and `interleaved` (where the model carries its reasoning in a tool loop; the engine needs it
  to hand the reasoning back). Descriptions and the rest are dropped.
- **Untrusted data:** the body is read with a size cap (24 MiB) before it is parsed; a model that does not fit the schema is
  skipped and counted, never half written; a body that is not a usable catalog (not an object, or not one usable model of a
  supported provider) fails as a whole. Names are one line of printable text of at most 120 characters (control and
  invisible characters become a space), kept as text with any markup in it. The log carries counts and codes only.

## Never deleted

A provider or model that is gone from the latest fetch is **unlisted**: `unlisted_at` is set and the last known row stays, so
a job still gets its per-job entry from our database. A returning one clears it; `first_seen_at` is kept. For the screens
that come later: the managed key shows "no longer listed" and the model stays usable until the admin disables it (its
confirmed price stays valid); an own-key workspace keeps its selection and sees a warning; if the provider has retired the
model, the first call fails with a model-not-found answer and the run ends with a stable error code and no retry (that code
is #550's). models.dev `status: deprecated` is stored (`upstream_status`) and shown as a warning; the job entry writes it as
`active` because the pinned engine drops `deprecated` and `alpha` models.

## The fetch guard

A fetch that fails (no answer, a status other than 200, a redirect, too large, not JSON), does not parse or would unlist more
than **10 %** of the listed models (or of the listed providers) is **not applied**. The old rows stay, `models_dev_fetch_state`
records `last_status = failed` and `last_error` (one of `MODELS_DEV_FETCH_ERROR_CODES`) and a line with the code is logged.
The share is `UNLISTED_SHARE_LIMIT` in `plan.ts`. There is no "enabled" or "selected" model yet (#549, #554), so the guard
looks at everything listed; when those exist the guard should count them first. `refresh({ acceptLargeRemoval: true })`
applies a fetch the guard refused: for an admin who has looked at what would go (#554). A small catalog is guarded as
strictly: the loss of one provider out of six is more than a tenth.

## The address of a provider

The address models.dev states (`api`; for a provider with none, the default of its SDK from the supported file) decides where
a **real key is sent**, so it is untrusted (`upstream-url.ts`):

1. **Safe:** https only, no credentials, no query or fragment, a real host name, and neither a private, loopback or
   link-local address nor a name that resolves to one (every address of the name is looked up; one private address refuses
   it). The supervisor that holds the key must check the address it connects to again (#550): a name can change what it
   resolves to later.
2. **Trust on first use:** the first safe address of a provider is stored as `trusted_url`.
3. **A change blocks:** a later different address, or one that is refused, sets `url_state = url_changed` and keeps
   `trusted_url`; the new text waits in `pending_url`. The provider is unusable (`isUsable`; `buildJobModelEntry` refuses it
   with `provider_url_blocked`) **for the managed key and for an own key** until an admin confirms the new address (the
   confirmation is #554; the override file of #549 can pin an address). Going back to the trusted address unblocks. A first
   address that is refused is `rejected`. A name that does not resolve one day is inconclusive: a trusted address stays.

## The entry of a job

`buildJobModelEntry(provider, model)` (`job-entry.ts`) returns what `contracts/job-model-entry.v1.json` describes, or a stable
refusal (`provider_unsupported`, `provider_url_blocked`, `model_not_of_provider`, `entry_invalid`): the provider id, `npm`, the
wire family and key header from the supported file (never from models.dev), the **upstream** address (kept by the supervisor;
the engine only gets the loopback address of the proxy), and the model entry (`name`, `status`, `tool_call`, `reasoning`,
`temperature`, both limits, `modalities`, `interleaved`). No key, no price, no other model. A model models.dev no longer lists
is still served (the last known entry). The runner reads the entry and builds the engine's provider block with
`runner/src/code_reviewer_runner/dynamic_review/job_model_entry.py` (not wired into a job yet: that is #550); the real pinned
engine accepts that block (`runner/tests/engine/test_engine_opencode_job_entry.py`).

What the spike found and the entry follows: `npm` is always set (without it the engine speaks Chat); `limit` has both
`context` and `output` or neither; `deprecated` and `alpha` are dropped by the engine (written as `active`), `beta` runs; the
engine's own `cost` is not used, so the entry has no price (the ledger reads the raw usage).

## The generic adapter

`createGenericAdapter(provider, models)` (`generic-adapter.ts`) is the data half of what `src/llm/providers/` asks of an
adapter: id, name, SDK, family, key header, the trusted address, the model list (unlisted and deprecated ones marked, not
hidden), `checkModelId`, `priceOf` and `testKey`: a `GET <address>/models` with the key in the header of the family (and
`anthropic-version` for Messages), no redirect followed, the outcome `accepted`, `rejected`, `not_verified` (404, 405, 501:
"not verified" is an answer, not a failure), `unreachable` or `provider_error`, never a word the provider said. It is not in
the registry: the registry's ids and secret names are slugs of `^[a-z][a-z0-9_]{1,31}$` and these ids have hyphens. OpenRouter
and Anthropic keep their adapters until #556.

## Tests

`parse.test.ts`, `upstream-url.test.ts`, `plan.test.ts`, `job-entry.test.ts`, `generic-adapter.test.ts`, `fetch.test.ts`,
`settings.test.ts`, `startup.test.ts`, `opencode-providers.test.ts` (unit); `service.integration.test.ts` (SQLite and
Postgres, against the fake `fakes/models-dev/` with a real database); the repository and migration tests in `src/db/`; the
contract tests `integration-tests/compatibility/job-model-entry-contract.integration.test.ts` and
`runner/tests/contract/test_job_model_entry_contract.py`. No test reaches the internet.
