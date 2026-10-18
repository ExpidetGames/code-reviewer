# Managed model tiers

A workspace whose key mode is `managed` reviews on the operator's own key (`src/llm/README.md`, "The operator's own key").
It does not pick among hundreds of models: it picks a **tier**, `low`, `medium` or `high` (default `medium`), and the
operator decides which model backs each tier. The operator may change those models at any time without any workspace
choosing again, and **a workspace never sees which model a tier is** (epic #268, principle 4; issue #280).

Which models back which tier is operator data. Nothing in this repository names one (the test ids are made up), and the
code has no default for a tier: a tier without a model fails closed.

## The pieces

| File         | Role                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tiers.ts`   | Pure: the tiers and the default, `checkManagedModelTiers` (a write), `readStoredTiers` (lenient read), `modelOfTier`, the operator and portal views, `clampMaxTokens` |
| `errors.ts`  | The codes of a refused configuration that the operator API adds (`model_id_invalid` and the three `DYNAMIC_MODEL_*`)                                                  |
| `service.ts` | `createModelTiersService`: `read`, `modelFor(tier, kind)`, `save` over the instance setting `managed_model_tiers`, with the check of Dynamic models                   |

## The configuration

Instance setting `managed_model_tiers` (`instance_settings`, JSON, no migration):
`{ "low": { "diff": "<model id>", "dynamic": "<model id>" }, "medium": { … }, "high": { … } }`. Each tier and each kind
is optional; the ids are OpenRouter ids validated with the rule of the review settings (`isModelId`, the provider's model-id rule).

**It is written and read through the operator API only**: `GET|PUT /api/operator/v1/model-tiers`
(`src/operator-api/README.md`). A `PUT` replaces the whole configuration. The instance admin portal shows **whether**
each tier has a model per kind (the "Managed model tiers" row of the overview), never an id, and cannot write them.
Nothing else reads the setting except the claim of a job (below).

- **A Dynamic model is checked on write** with the capability module of #269 (`src/llm/model-capabilities.ts`): a model
  without tool calling or tool choice is refused `DYNAMIC_MODEL_TOOLS_UNSUPPORTED`, an unknown one
  `DYNAMIC_MODEL_UNKNOWN`, and one whose metadata cannot be read `DYNAMIC_MODEL_UNVERIFIED`. Unlike the save of a user's
  Dynamic model (a warning), an unverifiable model is **refused** here, because this is operator configuration. Nothing
  is stored on a refusal.
- **A Diff model is checked for existence.** The provider's metadata is read for it too: a model the provider does
  not list is refused `MODEL_UNKNOWN` (a typo would fail every job of the tier with `model_unknown`), while one that
  needs no tool support, or whose metadata cannot be read because the provider is unreachable, is accepted. All
  distinct models of a `PUT` are read at the same time, so a `PUT` waits for one timeout, not one per model.
- The model of a tier is checked on write, but a provider can change later: the run-time check of #279
  (`dynamic_model_features_unsupported`) still applies to every Dynamic job.
- A stored value that this version would not accept (damaged, edited by hand) reads as not configured, so the job
  fails closed instead of running on a model nobody validated.

## What a workspace chooses

The review setting `modelTier` (`low`, `medium`, `high`; `src/review-settings/README.md`) at the workspace default and at
the project level, with the same layering as every other setting: the project's tier over the workspace default over
`medium`. It is a setting like the others in the API and in the stored settings; the **Quality** choice that sets it is described below.
**It only has an effect while the workspace's key mode is `managed`.** For a workspace on its own key (or without
entitlements) `model` and the Dynamic model apply and the tier is ignored.

### The Quality choice (#283, replaced by the catalog chooser in #433)

The tiers had a **Quality** choice, Low, Medium or High, in the settings forms of a managed workspace. Since #433 the
project form shows the **catalog chooser** in its place (an entry per review kind, `src/review-settings/README.md`) and no
control sets `modelTier` any more; the claim still reads the stored `modelTier` until the catalog reaches it (#432), and
the tiers are retired with #434. The copy is in `src/copy/model-choice.ts`, and a test scans it for a model name, a
vendor, a price or a cost. The settings routes return `modelTier` and no model field for such a workspace and refuse a
write that sets one with `MODEL_MANAGED_BY_INSTANCE`.

No form shows the levels any more, so there is no "Not available" level to explain. The tier is still **read at claim**
(below): a level without a model for the kind of review fails the job with `managed_tier_unavailable`. The yes or no per
level and kind (`tierAvailability`, `configuredTiers`) stays on the settings view until #434 retires the tiers.

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
   of a Dynamic job). When a fresh read fails, the window last read for that model (kept a day) is used; when none was
   ever read, the budget is cut to `UNKNOWN_WINDOW_MAX_TOKENS` (100,000, the built-in budget): **a managed job's budget
   is never sent unclamped**, whatever the workspace saved (up to two million). The instance's `LLM_MAX_TOKENS` belongs
   to the instance's own model and is not used for a managed job.
   The claim asks as a claim: an answer that is not `supported` is remembered 45 seconds, so a provider outage costs
   one wait of the 5 second timeout per model per 45 seconds instead of one per claim (`src/llm/README.md`). The settings pages and routes of a managed workspace do not
   check `maxTokens` against the stored model's window either (`operatorsModels` of the settings service): the user
   does not know the model.

## The model never leaves the server

The id of a tier's model goes to the operator API and to the runner (it needs it to call the provider), nowhere else:

- Not in the stored settings of any workspace (the claim swaps the model in the job only), not in any settings answer or
  page, not in the usage record (`model_tier` is a name; the operator API serves only a value that looks like a tier
  name) and not in the plan or usage views.
- **Not in the result of a run.** The runner reports the model it used (`usage.model`) and its log or error may repeat it.
  For a job that ran on a tier (its usage record names one) `usage.model` is **always** set to `null`, whatever the
  runner calls the model, and the ids in any text become `[model]` (the same place that masks credentials, `runner-api/report.ts`): the model the job was handed (remembered with its
  keys, encrypted, `runner-api/claimed-keys.ts`, `modelsOf`) **and every model the operator has configured now**, so the
  result is masked on any app instance, after any change of the tiers, and even if the remembered row cannot be read.
  A run on the workspace's own key reports its model as before. Tokens and calls stay, and the limits are unaffected.
  **The Runs view shows no cost for a run on a tier** (its usage record names one; `costHidden` in the run detail, #283):
  with the tokens it would give a price per token, which tells the model and the operator's pricing. The operator reads
  the cost through the operator API. The link to the comment is not masked: the app builds it from GitHub data, and a
  short id that also occurs in a repository name would break it.
- **Not in a published pull request comment.** The model is the runner's business, and PR-Agent can print it into the
  review comment. The runner sets `config.output_run_details` and `config.output_relevant_configurations` to `false`
  for every job and pins them against a repository's `.pr_agent.toml` (`runner/README.md`). The Dynamic summary and the
  refusal notices never print a model.
- Not in a log line a workspace member can see, and in the server log only where the operator needs it: the claim names
  the tier and the kind (`tier=high kind=diff`), the metadata read of a managed claim logs `model=tier=high` instead of
  the id, the operator API names the tiers that have a model and the result code. The operator's own `PUT` of a model is
  read from the provider and logged by the checker with the id (server log, the operator's).
- Not in error copy: `managed_tier_unavailable` says that the chosen level is not available and that a workspace Owner or
  Admin can choose another quality level in the review settings of the project (and to contact whoever runs the
  instance if none is available), not which model it would be.

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
- **The Quality choice (#283) is additive too**: no migration and no change of a runner-facing API. The settings answers
  gain `modelManagedByInstance` and `tierAvailability` and drop the model fields **for a managed workspace only**; a form
  that does not know the flag (an older cached page) reads the answer as not managed. An app instance of the previous
  release still shows the model fields of a managed workspace; the stored models, the key mode and the level are the
  same data, so the two releases can serve the same database during a rolling deploy. The only visible difference is the
  placeholder in a stored result (`[model]` instead of `[redacted]`).

## Testing

`tiers.test.ts` (unit, including the clamp), `service.integration.test.ts` (real database: save, replace, the three
refusals, nothing stored on a refusal), `integration-tests/http/operator-api-model-tiers.integration.test.ts` (the route),
`integration-tests/http/runner-api-model-tiers.integration.test.ts` (the claim on both paths: the model per tier and
kind, the default, the layering, the closed failure, the workspace on its own key, the clamp, the masking),
`integration-tests/http/model-tiers-privacy.integration.test.ts` (also the settings answers of a managed workspace),
`src/review-settings/*.integration.test.ts` and `ui/*.test.tsx` (the Quality choice, the refusal of a model write, the
views without a model), `src/copy/model-choice.test.ts` (the copy scan), the published Dynamic and Diff comment in
`runner/tests/integration/test_dynamic_review_job.py` and `runner/tests/engine/test_engine_hostile_repo.py`, the contract in
`integration-tests/compatibility/operator-api-contract.integration.test.ts` and the portal row in
`src/admin/http.integration.test.ts` and `src/admin/ui/overview.test.tsx`.
