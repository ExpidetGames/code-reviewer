# Managed model tiers

A workspace whose key mode is `managed` reviews on the operator's own key (`src/llm/README.md`, "The operator's own key").
It does not pick among hundreds of models: it picks a **tier**, `low`, `medium` or `high` (default `medium`), and the
operator decides which model backs each tier. The operator may change those models at any time without any workspace
choosing again, and **a workspace never sees which model a tier is** (epic #268, principle 4; issue #280).

Which models back which tier is operator data. Nothing in this repository names one (the test ids are made up), and the
code has no default for a tier: a tier without a model fails closed.

## The pieces

| File                   | Role                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tiers.ts`             | Pure: the tiers and the default, `checkManagedModelTiers` (a write), `readStoredTiers` (lenient read), `modelOfTier`, the operator and portal views, `clampMaxTokens`     |
| `errors.ts`            | The codes of a refused configuration that the operator API adds (`model_id_invalid` and the three `DYNAMIC_MODEL_*`)                                                      |
| `service.ts`           | `createModelTiersService`: `read`, `modelFor(tier, kind)`, `save` over the instance setting `managed_model_tiers`, with the check of Dynamic models                      |

## The configuration

Instance setting `managed_model_tiers` (`instance_settings`, JSON, no migration):
`{ "low": { "diff": "<model id>", "dynamic": "<model id>" }, "medium": { … }, "high": { … } }`. Each tier and each kind
is optional; the ids are OpenRouter ids validated with the rule of the review settings (`MODEL_NAME_PATTERN`).

**It is written and read through the operator API only**: `GET|PUT /api/operator/v1/model-tiers`
(`src/operator-api/README.md`). A `PUT` replaces the whole configuration. The instance admin portal shows **whether**
each tier has a model per kind (the "Managed model tiers" row of the overview), never an id, and cannot write them.
Nothing else reads the setting except the claim of a job (below).

- **A Dynamic model is checked on write** with the capability module of #269 (`src/llm/model-capabilities.ts`): a model
  without tool calling or tool choice is refused `DYNAMIC_MODEL_TOOLS_UNSUPPORTED`, an unknown one
  `DYNAMIC_MODEL_UNKNOWN`, and one whose metadata cannot be read `DYNAMIC_MODEL_UNVERIFIED`. Unlike the save of a user's
  Dynamic model (a warning), an unverifiable model is **refused** here, because this is operator configuration. Nothing
  is stored on a refusal. A Diff model is not checked.
- The model of a tier is checked on write, but a provider can change later: the run-time check of #279
  (`dynamic_model_features_unsupported`) still applies to every Dynamic job.
- A stored value that this version would not accept (damaged, edited by hand) reads as not configured, so the job
  fails closed instead of running on a model nobody validated.

## What a workspace chooses

The review setting `modelTier` (`low`, `medium`, `high`; `src/review-settings/README.md`) at the workspace default and at
the project level, with the same layering as every other setting: the project's tier over the workspace default over
`medium`. It is a setting like the others in the API and in the stored settings; the form for it is #283.
**It only has an effect while the workspace's key mode is `managed`.** For a workspace on its own key (or without
entitlements) `model` and the Dynamic model apply and the tier is ignored.

## At claim

For a job that runs on the operator's key (`runner-api/claim.ts`, `checkJob`, on both delivery paths: the legacy claim
and the first fetch of a Worker):

1. The project's tier is read from its effective settings (`medium` if none) and noted in the usage record as
   `model_tier`: the **name**, never the model.
2. The model of that tier for the job's review kind replaces `model` (Diff) or the Dynamic model, and the workspace's
   fallback model is dropped. A tier without a model for the kind fails the job with the stable code
   **`managed_tier_unavailable`**: no move to another tier, and not to the instance's `LLM_MODEL` either. The job ends
   before any credential exists; its record is void (nothing was consumed).
3. The capabilities of a Dynamic job are read for the tier's model (#279), as for any Dynamic model.
4. **The token budget is clamped.** The workspace's `maxTokens` stays the workspace's, and is cut to the context window
   of the tier's model when the provider's metadata states one (`clampMaxTokens`; the same read serves the capabilities
   of a Dynamic job). Without a stated window the budget is sent as it is. The instance's `LLM_MAX_TOKENS` belongs to the
   instance's own model and is not used for a managed job. The settings pages and routes of a managed workspace do not
   check `maxTokens` against the stored model's window either (`operatorsModels` of the settings service): the user
   does not know the model.

## The model never leaves the server

The id of a tier's model goes to the operator API and to the runner (it needs it to call the provider), nowhere else:

- Not in the stored settings of any workspace (the claim swaps the model in the job only), not in any settings answer or
  page, not in the usage record (`model_tier` is a name; the operator API serves only a value that looks like a tier
  name) and not in the plan or usage views.
- **Not in the result of a run.** The runner reports the model it used (`usage.model`) and its log or error may repeat it.
  The model a job was handed is remembered with its keys, encrypted (`runner-api/claimed-keys.ts`, `modelsOf`), so it is
  masked in the stored result whichever app instance serves the completion and whatever the operator changed since:
  `usage.model` becomes `null` and the id in any text becomes `[redacted]`. Tokens, calls and cost stay, so the Runs
  page and the limits are unaffected.
- Not in a log line: the claim names the tier and the kind (`tier=high kind=diff`), the operator API names the tiers that
  have a model and the result code.
- Not in error copy: `managed_tier_unavailable` says that the chosen level is not available, not which model it would be.

`integration-tests/http/model-tiers-privacy.integration.test.ts` configures tiers with ids no other test uses, runs
managed Diff and Dynamic jobs, and searches every answer a member can read for any of them.

## Mixed versions

- The setting, the route and the review setting are additive: no migration, no change of the runner API, the Worker API
  or the Dispatcher API (the model is the `llm.model` / `dynamic.model` the job always had).
- **Upgrade every app instance before setting any workspace to `managed`, and before saving tiers** (as for #276). An
  instance of the previous release ignores `managed_model_tiers` and the key-mode rules above: a managed workspace's job
  would run on the instance default model it was pinned to (#276) or on the workspace's own settings, and does not know
  the tier. It also drops `modelTier` from the settings it saves from a form that does not carry it.
- A runner or Worker of the previous release gets the same job input; only the value of `llm.model` differs.

## Testing

`tiers.test.ts` (unit, including the clamp), `service.integration.test.ts` (real database: save, replace, the three
refusals, nothing stored on a refusal), `integration-tests/http/operator-api-model-tiers.integration.test.ts` (the route),
`integration-tests/http/runner-api-model-tiers.integration.test.ts` (the claim on both paths: the model per tier and
kind, the default, the layering, the closed failure, the workspace on its own key, the clamp, the masking),
`integration-tests/http/model-tiers-privacy.integration.test.ts`, the contract in
`integration-tests/compatibility/operator-api-contract.integration.test.ts` and the portal row in
`src/admin/http.integration.test.ts` and `src/admin/ui/overview.test.tsx`.
