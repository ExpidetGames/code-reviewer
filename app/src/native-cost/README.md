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
confirmed, stale, not priced or incomplete (below), and `catalog_model_unavailable` for everything else. The usage record of the
refused job is `void`, and the job's billing class is `free` (every code of the claim has one). A managed job that is accepted logs
which confirmation priced it (`confirmation=<id> hash=<version>` on its selection line). A price check that itself fails
(`check_failed`: the database could not be read) is not the model's fault: the job is given back (503 with `Retry-After`, an attempt
counted, reason `price_check_failed`, class `free`) and tried again, on the Worker's fetch as on the claim.

The confirmed **book** goes into the claim (`dynamic.cost.priceBook`) and is the runner's only price source: never the engine's own
`cost`, never models.dev. An unknown cost ends the run with `dynamic_accounting_failed`, which billing treats as our fault. There is
no token cap. The result is checked once more when it comes back: the success of a **native** managed Dynamic job that reports a
null cost is stored as `dynamic_accounting_failed` (`runner-api/managed-cost-guard.ts`); it can never settle with a null cost. Whether
a job was native is read from the provider its usage record remembers (`isNativeProvider`), so a job on the legacy wires is unchanged.

**Cache prices (decision).** A cache read without a confirmed read price is not priced as input (the upper bound #569 left open),
because the member would be charged a price nobody confirmed. So "selectable" includes the cache prices, defined once in
`availability()` (`model-prices/availability.ts`): a confirmed book is unpriced (`cache_read_unpriced`) when any level states no
cache read, and a model of the Messages family that states a cache read and no 5-minute write is unpriced too
(`cache_write_unpriced`); the admin states the missing price explicitly in a correction (the input price is its upper bound). The
runner reads the book of a claim with `strict_cache_read` as a second line: a read it has no price for makes the call unpriced and
the run ends `dynamic_accounting_failed`, which is free. **`cache_control.ttl` stays out of the request schema**: the pinned engine
never sends one, so allowing it would buy nothing and widen what the engine may ask.

## The own key (the user pays the provider)

Free choice; a missing price blocks nothing. The book is the confirmed one when there is one, else the price the catalog states
today (`catalogPrice`), else none. **Priced own key = the dollar limit of #540 plus the token cap as a ceiling; unpriced = the
token cap and the clock.** `maxTotalTokens` (prompt, cache and completion tokens in all; default 4,000,000, the instance setting
`own_key_max_total_tokens`, changed in the admin portal under Limits) always applies to an own key, so a free model (a $0 book) or a
cheap one is still bounded. The cap counts every call at the largest of what it states: its counts, the total it states, and
reasoning stated on top of the completion; a call whose usage was not read counts the estimate of its input and the whole output
allowance. The result reports `costUsd: null` when any call is unpriced, and billing charges the minutes only. A call with no usage
at all still fails the run. The cap is read at every claim. The managed key has no cap: the dollar limit binds.

## Contract

`dynamic.cost` (`DynamicCostPolicy` in `contracts/runner-api.v1.json`) is sent only to a caller that named the claim feature
`dynamic_cost_policy`; a job that carries one and meets a caller without it ends `dynamic_engine_unavailable` before any credential
exists. The runner reads it as strictly as the app writes it. A run stopped by the cap reports `stoppedEarly: "token_limit"`.

## A mixed fleet

The feature `dynamic_cost_policy` is named by the caller that runs the job. A runner of the previous release names none and is
never handed a policy; a native job needs the new runner anyway (it needs the passthrough proxy). On the hosted path the
Dispatcher's claim cannot know what its Worker can do: it runs the checks (so a managed model without a confirmed price is refused
before any VM starts), and the Worker's fetch ends a job that carries a policy with `dynamic_engine_unavailable` if the Worker image
is older (a VM was started for nothing, once; nothing ran). The rollout order is therefore: runners and Worker images first, then the
wiring that makes an entry native.

## What #555 did, and what the wiring still needs

- **Done in #555.** The selection accepts a catalog slug for a Dynamic job on the own key (`llm/selection.ts`, `nativeModels`, the
  selection carries `catalog: true`); the project settings store a catalog provider and model for Dynamic Review
  (`review-settings/native-choice.ts`, `MODEL_NOT_IN_CATALOG`); the key per catalog provider is stored and revealed
  (`native-providers/lookup.ts`, `keyFor`); the claim resolves the stored row into the per-job entry (`buildJobModelEntry`, through
  `native-providers/catalog.ts` `resolve`) **before any key is loaded** and fails closed (`llm_model_unavailable` for a row that is
  gone, `llm_provider_unsupported` for a provider that cannot carry a key); the workspace UI shows the token cap and the price
  source (`native-providers/ui/own-key-cost-note.tsx`).
- **The joint the wiring uses.** `ClaimDeps.nativeCatalog` (with `nativeCost`) makes a catalog selection possible: **the running server
  leaves it out** (`runner-api/shared.ts`), so a project that names a catalog provider still fails closed with
  `llm_provider_unsupported` until the wiring of the passthrough proxy passes it, behind its switch. `Checked.modelEntry` holds the
  entry; the job input does not carry it yet, and `buildJobInput` reads no provider metadata for such a job.
- **Still to do by the wiring.** Send the entry (`buildJobModelEntry`'s result) and start the native engine; the runner's
  `build_native_ledger` and `PassthroughProxy(prices=policy.book, unknown_cost_ends_run=policy.unknown_cost_ends_run)` are the two joints,
  and `reasoning` of the entry goes to `build_native_ledger(reasoning=...)`. The caller must also say it can run a catalog model (the
  claim should pass `nativeCatalog` only to a caller that does); a Diff job never takes the path (#558).
- #554: the catalog view already says why a model is refused (`MANAGED_REASON_COPY`, including the two cache reasons); the
  correction form should suggest the input price as the upper bound for a missing cache read (a hint, nothing is filled in).
