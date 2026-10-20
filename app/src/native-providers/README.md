# Catalog providers for a workspace on its own key (#555)

What lets a workspace that brings its own key use **any provider of the models.dev catalog** for Dynamic Review, and pick one
of its tool-calling models. Design: #544 (decision 6: own key, free choice), epic #420. The catalog itself, its daily fetch and the
per-job entry are `src/models-dev/` (#548); what a run costs and what bounds it is `src/native-cost/` (#553); the admin's side is
#554. **Diff Review is not touched**: the Diff model keeps its two providers until #558. A workspace on the operator's key
(`managed`) is given none of this; it picks named entries and never sees a provider or a model id (principle 2 of epic #420).

| File             | Role                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookup.ts`      | Pure and client safe: a catalog provider by its slug (`findNativeProvider`), the slot of its key (`llm_api_key.<slug>`), and `withNativeProviders`, the registry's lookup extended with the catalog |
| `catalog.ts`     | `createNativeCatalogReader`: `providers()` (the offered ones), `providerAvailable`, `models(slug)`, `checkSelection` (the save); the claim builds the per-job entry from the stored row with `native-cost/service.ts` `entryFor` |
| `key-test.ts`    | The "Test key" of a catalog provider: the generic adapter's model-list read at the trusted address, as a class (`accepted`, `rejected`, `not_verified`, `unreachable`, `provider_error`)            |
| `models-http.ts` | `GET /api/w/:workspace/llm-catalog/:provider/models`: the models of one provider for the picker; own key only, the 404 of a missing path for a managed workspace                                    |
| `form-data.ts`   | What the project form is given: the catalog providers the workspace holds a key for, the token cap, whether billing is on (nothing, and nothing read, for a managed workspace)                      |
| `shared.ts`      | The reader on the running server's database                                                                                                                                                         |
| `ui/`            | `CatalogProvidersCard` (LLM access page: search, key form), `CatalogModelPicker` (project settings: search, name, context, price), `OwnKeyCostNote` (the cap and the price source)                  |

## What is offered, what is served

- **Offered** (a provider in the picker, a key may be stored, a project may choose it): in `contracts/opencode-providers.v1.json`
  (so not cloud IAM, not a runtime-install SDK), **not** one of the registry's two (they keep their wires until #556), whose address is
  **trusted** (`url_changed` blocks it until an admin confirms, #554), that models.dev still lists and that has a model. A model is
  offered while models.dev lists it, tool calling being the catalog's own filter.
- **Saved.** A project's Dynamic provider and model are checked against the catalog: a model that is not there (released today,
  before the next daily fetch) or no longer listed is refused with `MODEL_NOT_IN_CATALOG` on the field and nothing is stored; the
  admin's "Refresh now" is the way to get it sooner. The provider's own metadata is not asked: the catalog is the list. A pair that is
  stored already is not checked again by a save that does not touch it.
- **Served.** The claim builds the entry from the stored row, **listed or not** (decision of 2026-10-19 on #548: a model that
  disappears keeps working until the provider retires it; the settings warn, the claim logs it). It fails closed, with no move to
  another model, provider or key, when the row is gone (`llm_model_unavailable`) or the provider cannot carry a key any more
  (`llm_provider_unsupported`: not supported, blocked by `url_changed`, refused, or an address that is not the plain public https one
  in its canonical spelling). Only the key of that provider is revealed (`key_binding_mismatch`/`no_key` otherwise:
  `llm_not_configured`).
- **Where the key goes.** To the address the catalog trusts for the provider and to no other, re-checked by the runner:
  `src/native-cost/README.md`, "Where the key goes". **This needs a security review.**

## What a workspace is told

The name, the context size and, when models.dev states one, the price of a model (as exact decimal text; a price with a part we cannot
read is no price). A run with **no price** is bounded by a token cap (the instance setting `own_key_max_total_tokens`, shown in the
note) and the time limit, and the own-key cost limit does not apply to it; with a price the cost limit applies as before and the cap
bounds the run as well. With billing on, the note adds that a run on the own key is charged for infrastructure minutes only (no rate, no
formula). `src/model-prices/` is not used: the prices shown are models.dev's own, and the confirmed prices of the managed key are
the admin's (`visibility.test.ts`).

## Tests

`lookup.test.ts`, `key-test.test.ts`, `form-data.test.ts`, `ui/*.test.tsx` (component), `catalog.integration.test.ts`,
`workspace-keys.integration.test.ts`, `access.integration.test.ts`, `http.integration.test.ts`, `key-test-service.integration.test.ts`,
`models-http.integration.test.ts` (integration, a real SQLite file; the catalog ones also on Postgres when `TEST_DATABASE_URL` is set),
the claim in `integration-tests/http/runner-api-native-own.integration.test.ts`, the save in
`src/review-settings/native-model.integration.test.ts`, and one journey, `e2e/settings/native-provider.e2e.ts`.
