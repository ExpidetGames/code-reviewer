# Cost policy of a native job

What the claim decides about the cost of a **native** Dynamic job, one that runs through the passthrough proxy of the runner
(`runner/.../dynamic_review/passthrough/`, design #544, epic #420). The ticket is #553; the billing rules are those of epic
#489: a run is free only when the failure is clearly ours, an unknown AI cost is charged as minutes only, and the managed key is
never used with an unknown price.

| File             | Role                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `catalog-ref.ts` | The minimal map from a selection (registry slug, model id) to the models.dev ids, and the one rule that says which selection is native                                         |
| `policy.ts`      | Pure: the managed policy from the answer of `availability()` (with the cache-read rule), the own policy from a book and a cap. `CostPolicyJson` is `dynamic.cost` of the claim |
| `token-cap.ts`   | The token cap of an own key: bounds (100,000 to 100,000,000), the default 4,000,000, and the reading of a stored value                                                         |
| `service.ts`     | `createNativeCostService`: `refOf` and `policyFor`, over the price service and the instance settings                                                                           |
| `shared.ts`      | The wiring of the running server (the claim imports this, never the price module: `model-prices/visibility.test.ts`)                                                           |

## Who is native

A job is native when its selection names a catalog model: `catalogRefOf` maps the slug of the provider to the provider id of
models.dev (the underscore of a slug is the hyphen of the id; an id with an underscore, or one that starts with a digit, has no
slug) and the provider must be in `contracts/opencode-providers.v1.json` and **not** in the legacy registry (`openrouter`,
`anthropic`). Those two stay on their wires until #556, so nothing about their claim changes. Only a Dynamic job is native (a Diff
job runs PR-Agent). **The registry does not accept a native slug in a selection yet**, so on the running server no job is native
and the claim is the claim of today; the wiring of the passthrough proxy and #555 lift that (below).

## The managed key (we pay)

At claim time, before any key, token or VM exists, `availability()` of #549 is asked. Only a model that is **enabled and has a
confirmed price** passes. Otherwise the job ends `managed_model_unavailable` (the code that already has a member-safe notice; no
provider, model or price is named). The log carries the opaque entry id, the kind and the stable refusal code with the internal
reason (`reason=catalog_price_unconfirmed:price_unconfirmed`); the code is `catalog_price_unconfirmed` for a price that is not
confirmed, stale or not priced, and `catalog_model_unavailable` for everything else. The usage record of the refused job is `void`.
A price check that itself fails (`check_failed`: the database could not be read) is not the model's fault: the job is given back (503
with `Retry-After`, an attempt counted) and tried again, on the Worker's fetch as on the claim.

The confirmed **book** goes into the claim (`dynamic.cost.priceBook`) and is the runner's only price source: never the engine's own
`cost`, never models.dev. An unknown cost ends the run with `dynamic_accounting_failed`, which billing treats as our fault. There is
no token cap. The result is checked once more when it comes back: a managed Dynamic success with no cost is stored as
`dynamic_accounting_failed` (`runner-api/managed-cost-guard.ts`); it can never settle with a null cost.

**Cache reads (decision).** A cache read without a confirmed read price is not priced as input (the upper bound #569 left open),
because the member would be charged a price nobody confirmed. A managed book that sells a cache write but states no cache read, or a
level that drops a read the others state, is refused at claim time (`reason=cache_read_unpriced`); the runner reads the book of a
claim with `strict_cache_read`, so if a read slips by (a provider that caches a model whose book has no cache price at all) the call
is unpriced and the run ends `dynamic_accounting_failed`, which is free. **`cache_control.ttl` stays out of the request schema**: the
pinned engine never sends one, so allowing it would buy nothing and widen what the engine may ask.

## The own key (the user pays the provider)

Free choice; a missing price blocks nothing. The book is the confirmed one when there is one, else the price the catalog states
today (`catalogPrice`), else none. Priced, the ledger and the dollar limit of #540 work as before. When no price is known, or once a
call's cost is unknown, the run is bound by **`maxTotalTokens`** (prompt, cache and completion tokens in all; default 4,000,000, the
instance setting `own_key_max_total_tokens`, changed in the admin portal under Limits) and by the clock. The result reports
`costUsd: null` and billing charges the minutes only. A call with no usage at all still fails the run. The cap is read at every claim.

## Contract

`dynamic.cost` (`DynamicCostPolicy` in `contracts/runner-api.v1.json`) is sent only to a caller that named the claim feature
`dynamic_cost_policy`; a job that carries one and meets a caller without it ends `dynamic_engine_unavailable` before any credential
exists. The runner reads it as strictly as the app writes it. A run stopped by the cap reports `stoppedEarly: "token_limit"`.

## What #555, #571 and the wiring still need

- A native slug must be accepted by the selection (`llm/selection.ts` knows only the registry's providers) and by the settings of a
  project, and the key per native provider must be stored and loaded (`keyFor`); `catalogRefOf` is the map they use.
- The claim must also send the job model entry (`buildJobModelEntry`) and start the native engine; the runner's `build_native_ledger`
  and `PassthroughProxy(prices=policy.book, unknown_cost_ends_run=policy.unknown_cost_ends_run)` are the two joints, and `reasoning`
  of the entry goes to `build_native_ledger(reasoning=...)`.
- #555 says in its screen that the own-key cost limit cannot bind without a price, and shows the token cap (`ownKeyTokenCap` of the
  admin settings read model; a member sees the cap, never a price).
- #554 should show why a managed model is refused beyond "price unconfirmed": the cache-read rule is in the log only.
