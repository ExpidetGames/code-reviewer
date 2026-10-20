# The models.dev catalog

The catalog of the providers and models a job can use, **read from models.dev at run time, once a day, into the
database** (#548, part of epic #420; design: #544). Every new model of a provider we support used to cost an app release,
because the lists, prices and limits were kept by hand; this module replaces that for the providers the pinned OpenCode
can drive with a static key (about 210 of the 232 that models.dev lists). **The catalog is empty until the first fetch,
and nothing reads it yet** (the consumers are #549, #550, #553, #554 and #555), so a workspace sees no change. Everything
that comes from models.dev is untrusted data.

| File                                                   | Role                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wire.ts`                                              | The four wire families (`openai-chat`, `openai-responses`, `anthropic-messages`, `google`), the key header of each and the reasons a provider is left out                                                                    |
| `opencode-providers.ts`, `opencode-providers.v1.json`  | The supported providers: the app's copy of `contracts/opencode-providers.v1.json` (the image holds `app/` only; a test compares the two)                                                                                     |
| `settings.ts`                                          | `MODELS_DEV_URL` and `MODELS_DEV_FETCH`                                                                                                                                                                                      |
| `fetch.ts`                                             | One request: size cap before parsing, time limit, no redirect, a stable code per failure (`errors.ts`)                                                                                                                       |
| `parse.ts`                                             | The strict tolerant schema; the filters; the reduced rows                                                                                                                                                                    |
| `upstream-url.ts`                                      | The address check, trust on first use and the block on change                                                                                                                                                                |
| `plan.ts`                                              | What a fetch writes (new, changed, unlisted, returned) and the guard                                                                                                                                                         |
| `service.ts`, `shared.ts`, `startup.ts`                | The fetch end to end, with a lock; the sweep and the timer of a long-lived server call `refreshIfDue`                                                                                                                        |
| `job-entry.ts`                                         | `buildJobModelEntry`: the secret-free entry of one provider and one model for a job (`contracts/job-model-entry.v1.json`)                                                                                                    |
| `generic-adapter.ts`                                   | The provider adapter built from catalog rows, with a best-effort key test per family                                                                                                                                         |
| `admin-service.ts`, `admin-http.ts`, `admin-errors.ts` | The admin portal's side (#554): the providers with the state of their addresses, the guarded confirmation of a changed address, "fetch now" with its deadline and limit; the handlers of their routes and their stable codes |
| `catalog.ts`                                           | The stored types                                                                                                                                                                                                             |

The tables are `models_dev_providers`, `models_dev_models` and `models_dev_fetch_state` (migration
`20261019200000_create_models_dev_catalog`, `src/db/README.md`); the repository is the instance level
`src/db/repositories/models-dev-repository.ts`. The catalog is not customer data: no workspace owns a row. A member never
sees a model id from here (principle 2 of #420); the admin screens (#554, `src/admin/catalog-models/`) escape every string they show.

## When it runs

- **Hosted (serverless):** the cron sweep (`src/dispatch/sweep.ts`, step `models_dev`, every 2 hours) asks
  `refreshIfDue`. There is no cron of its own.
- **A long-lived server (Docker, Coolify):** a timer (`startup.ts`) asks at the start and every hour, in production only.
- `refreshIfDue` fetches when the last success is more than **23 hours** old and the last failure more than **an hour**
  old, so a tick every two hours gives about one fetch a day and a restart does not fetch again. The day is kept in
  `models_dev_fetch_state`, so every instance sees the same one; a database try-lock (`MODELS_DEV_LOCK`) lets one run work
  and the others answer `already_running`. **An attempt is recorded before it starts** (`recordAttempt`), so a run the
  platform stops at its function limit leaves a trace and the next try waits an hour instead of repeating at once.
- A new provider whose name did not resolve is `rejected` (and retried): the next sweep, an hour after the attempt, fetches
  again instead of waiting a day, for as long as the provider is less than a day old (`retryProviders` in the summary;
  `RETRY_WINDOW_MS` in `plan.ts`). A provider the committed file gives an address for is trusted at once (see below).
- **One deadline** covers the fetch, the lookups and the write: `DEFAULT_DEADLINE_MS` (90 s) for a long-lived server and
  `MODELS_DEV_BUDGET_MS` (90 s, `sweep.ts`) for the sweep, whose route may run 300 s in all (the check runs take 40 s of it,
  a test keeps the two together within half the limit). The fetch gets what is left up to its own 60 s; the lookups stop
  `WRITE_RESERVE_MS` (10 s) before the deadline and a name not looked up is "did not resolve" (`lookupsSkipped` in the
  summary); the write checks the clock before every batch of 100 rows and, past the deadline, rolls back and fails with
  `models_dev_timeout`: nothing is half written.
- `refresh()` fetches now. It is what the admin's "fetch now" action calls (#554: `admin-service.ts` and
  `POST /api/admin/catalog-fetch`, with a deadline of 45 seconds under the 60 of the route and a limit of 6 in 10 minutes), also
  for a model that is newer than the last fetch (#555). `acceptReasons` names the guard reasons an admin accepted (see below); the page
  asks the admin first.

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
  `modalities`, `status`, `cost` (input, output, cache read, cache write, **reasoning**, **audio** in and out, the older `context_over_200k` and **every
  context tier**, up to 64) as exact decimal strings of USD per million tokens, plus an `unknown` list of the names of any
  price field or tier kind it cannot read (a model with one is not priced for the managed key, #549), `last_updated` and `interleaved` (where the model carries its reasoning in a tool loop; the engine needs it
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
is #550's). models.dev `status: deprecated` and `status: alpha` are stored (`upstream_status`) and shown as a warning; the job
entry writes both as `active` because the pinned engine drops `deprecated` and `alpha` models.

## The fetch guard

A fetch that fails (no answer, a status other than 200, a redirect, too large, not JSON), does not parse or is implausible
is **not applied**. The old rows stay, `models_dev_fetch_state` records `last_status = failed` and `last_error` (one of
`MODELS_DEV_FETCH_ERROR_CODES`) and a line with the code and the reasons is logged. Implausible (`plan.ts`) means:

| Reason (`GuardReason`)   | Code                                 | Trips when                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unlisted_share`         | `models_dev_guard_unlisted_share`    | more than **10 %** of the listed models (or of the listed providers) would be unlisted (`UNLISTED_SHARE_LIMIT`)                                                                                                         |
| `enabled_unlisted_share` | `models_dev_guard_enabled_unlisted`  | at least **3**, and more than **10 %**, of the models an admin **enabled** would be unlisted (`ENABLED_UNLISTED_MIN_COUNT`, #549); they are the ones in use and paid for, so they count even when they are a few of all |
| `growth`                 | `models_dev_guard_growth`            | the listed models would grow by more than **50 %** in one fetch (`GROWTH_LIMIT`); the first fetch into an empty database is exempt                                                                                      |
| `url_changed_share`      | `models_dev_guard_url_changed_share` | the address of more than **10 %** of the providers, and at least 3, would be newly blocked (`URL_CHANGED_SHARE_LIMIT`, `URL_CHANGED_MIN_COUNT`: one or two moving house must reach the admin)                           |
| `provider_size`          | `models_dev_guard_provider_size`     | a provider states more than **2,000** models (`MAX_MODELS_PER_PROVIDER` in `parse.ts`; the largest has 621 today): that provider is not read at all, and the fetch is refused                                           |

The guard counts the models an admin enabled for the managed key first (#549, `model_enablements`): the catalog-wide
share can stay small while the models in use vanish, so `planCatalog` also looks at the enabled ones alone. A refused fetch is `{ status: "failed", code, guard: { reasons, figures } }`: every reason that tripped (fixed order) and the
numbers the guard measured (`GuardFigures`, never a name or an address), `code` being the first reason that is not accepted.
`refresh({ acceptReasons: [...] })` applies a fetch only when **every** reason that trips is named (a large removal, growth, a
mass change of addresses; a provider that was too large is still left out): for an admin who has looked at them (#554). A
reason that is not named, or a new one in the next fetch, refuses it again. A small catalog is guarded as strictly: the loss of one provider out of six is more than a tenth.

## The address of a provider

The address models.dev states (`api`; for a provider with none, the default of its SDK from the supported file) decides where
a **real key is sent**, so it is untrusted (`upstream-url.ts`):

1. **Safe:** https on port 443 only (no other port, however it is written), no credentials, no query or fragment, a real host
   name, an address in the form the job entry accepts (`UPSTREAM_BASE_URL`, checked when it is stored, not first when a job
   is made), and neither a private, loopback, link-local or other special-purpose address (`billing/public-url.ts`: the IANA
   registry, NAT64 `64:ff9b::/96` by the IPv4 address it carries and `64:ff9b:1::/48`, 6to4 `2002::/16` by its IPv4 address,
   `192.0.0.0/24`, `198.18.0.0/15`, the documentation ranges, Teredo and the rest of `2001::/23`) nor a name that resolves to
   one (every address of the name is looked up; one private address refuses it). **That is a verdict of one moment.** A name
   can resolve elsewhere afterwards, so whoever sends the key checks again **on every connection**: connect to the address
   that was vetted, or refuse in the `lookup` hook of the socket (`connect-guard.ts`: `createGuardedLookup`,
   `createGuardedFetch`). The key test of the generic adapter does so; the supervisor of #550 must use the same lookup for the
   connection to the provider.
2. **Trust on first use, seeded from the committed file:** the first safe address of a provider is stored as `trusted_url`.
   A provider that `contracts/opencode-providers.v1.json` gives a default address for (ten, among them openai, anthropic,
   google and xai) is trusted at that address **from the start**; an address models.dev states instead is a change
   (`url_changed`, blocked), not a first sight. A trusted address that is stored stays what it is.
3. **A change blocks:** a later different address, or one that is refused, sets `url_state = url_changed` and keeps
   `trusted_url`; the new text waits in `pending_url`. The provider is unusable (`isUsable`; `buildJobModelEntry` refuses it
   with `provider_url_blocked`) **for the managed key and for an own key** until an admin confirms the new address (the
   confirmation is `admin-service.ts`, #554; the override file of #549 can pin an address). Going back to the trusted address unblocks. A first
   address that is refused is `rejected`. A name that does not resolve one day is inconclusive: a trusted address stays.

**The admin's confirmation and the fetch.** A fetch reads the provider rows, plans and writes in one transaction, and reads
them `FOR UPDATE` on Postgres, so an admin's confirmation (#554) made meanwhile waits and is applied after the fetch instead
of being written over. On SQLite every transaction begins `begin immediate`, which serialises the two. The confirmation
must be a guarded update of the one row in a transaction of its own (`update ... set trusted_url = pending_url, url_state =
'trusted' ... where provider_id = ? and url_state = 'url_changed' and pending_url = ?`, and only when `url_problem` is null);
it needs no other lock, in particular not `MODELS_DEV_LOCK`.

## The entry of a job

`buildJobModelEntry(provider, model)` (`job-entry.ts`) returns what `contracts/job-model-entry.v1.json` describes, or a stable
refusal (`provider_unsupported`, `provider_url_blocked`, `model_not_of_provider`, `entry_invalid`): the provider id, `npm`, the
wire family and key header from the supported file (never from models.dev), the **upstream** address (kept by the supervisor;
the engine only gets the loopback address of the proxy), and the model entry (`name`, `status`, `tool_call`, `reasoning`,
`temperature`, both limits, `modalities`, `interleaved`). No key, no price, no other model. A model models.dev no longer lists
is still served (the last known entry). `npm` is one of the SDKs the pinned OpenCode bundles (`BUNDLED_NPM` in `wire.ts`,
the same list in the contract and in the runner's reader) and `interleaved.field` one of `reasoning_content` and
`reasoning_details` (`INTERLEAVED_FIELDS`); the names are an allow-list because the SDK decides which code the engine loads and
the engine copies the reasoning into whatever field it is given. The runner reads the entry and builds the engine's provider block with
`runner/src/code_reviewer_runner/dynamic_review/job_model_entry.py` (not wired into a job yet: that is #550); the real pinned
engine accepts that block (`runner/tests/engine/test_engine_opencode_job_entry.py`).

What the spike found and the entry follows: `npm` is always set (without it the engine speaks Chat); `limit` has both
`context` and `output` or neither; `deprecated` and `alpha` are dropped by the engine (written as `active` so that the model
still runs; both are **stored as stated and shown as a warning**, `deprecated` and `alpha` in the adapter's model list), `beta`
runs; the engine's own `cost` is not used, so the entry has no price (the ledger reads the raw usage).

**Mapped from the source only.** The families of the SDKs the spike #546 ran against fakes (`@ai-sdk/openai`,
`@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`) are measured. The families of `@ai-sdk/mistral`,
`@ai-sdk/groq`, `@ai-sdk/deepinfra`, `@ai-sdk/cerebras`, `@ai-sdk/togetherai`, `@ai-sdk/perplexity`,
`@openrouter/ai-sdk-provider` and `@ai-sdk/xai` (all `openai-chat` but xai, `openai-responses`) are mapped **only from the
source of the pinned OpenCode** (`src/ci/opencode-providers/derive.ts`); no fake or live run has driven them. They are on the
live checklist (`docs/spike/544-passthrough.md`, section 7, L11).

## The generic adapter

`createGenericAdapter(provider, models)` (`generic-adapter.ts`) is the data half of what `src/llm/providers/` asks of an
adapter: id, name, SDK, family, key header, the trusted address, the model list (unlisted, deprecated and alpha ones marked,
not hidden), `checkModelId`, `priceOf` and `testKey`: a `GET <address>/models` with the key in the header of the family (and
`anthropic-version` for Messages), no redirect followed, the outcome `accepted`, `rejected`, `not_verified` (404, 405, 501:
"not verified" is an answer, not a failure), `unreachable` or `provider_error`, never a word the provider said. The request
goes through the connect guard (above): a name that now resolves to a private address gets no key. It is not in
the registry: the registry's ids and secret names are slugs of `^[a-z][a-z0-9_]{1,31}$` and these ids have hyphens. OpenRouter
and Anthropic keep their adapters until #556.

## Tests

`parse.test.ts`, `upstream-url.test.ts`, `plan.test.ts`, `job-entry.test.ts`, `generic-adapter.test.ts`, `fetch.test.ts`,
`settings.test.ts`, `startup.test.ts`, `opencode-providers.test.ts` (unit); `service.integration.test.ts` (SQLite and
Postgres, against the fake `fakes/models-dev/` with a real database); the repository and migration tests in `src/db/`; the
contract tests `integration-tests/compatibility/job-model-entry-contract.integration.test.ts` and
`runner/tests/contract/test_job_model_entry_contract.py`. No test reaches the internet.
