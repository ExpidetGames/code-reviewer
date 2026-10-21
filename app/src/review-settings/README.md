# Review settings

What a review can be tuned by, with sensible built-in values, global defaults for the whole workspace
and overrides per project. The settings end up in the runner job (`llm.model`, `llm.maxTokens`, `env`)
through one pure function. On a workspace whose key mode is `managed` (the operator's own key, `src/llm/README.md`)
the model, token budget and Dynamic model are stored but **not used**: the instance chooses the model, and the form
shows a note instead of those fields (#276).

## Layers

From weakest to strongest: **built-in values** (`settings.ts`, with the model from `LLM_MODEL`, see
`src/llm/README.md`), **global defaults** (`app_settings`, key `review_defaults`, one set per workspace: changing them in one workspace
does not touch another, and a workspace that never saved any uses the built-in values) and the **overrides of
one project** (`projects.settings`). A layer only holds the fields somebody changed, the rest is
inherited when the settings are read (`resolveReviewSettings` in `effective.ts`, which also says where
each field comes from). So a changed global default reaches every project that does not override the
field, and a built-in value that changes later (the default model, after the model comparison) reaches
everybody who did not choose one. Resetting a project (`DELETE`) removes its overrides.

A save **replaces the whole set** of its layer: a field left out is inherited again. Every person on the
allow list may change both layers (no admin role in the MVP); `app_settings.updated_by` records who saved
the global defaults last.

| Field               | Meaning                                                                                                                                                                 | Built-in value                                 | Limits                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| `provider`          | The provider of `model` (#430): a provider of the registry (`src/llm/providers/`), stored by its id. A workspace default that a project may override. Own key mode only | the default provider (`openrouter`)            | an id of the registry (`PROVIDER_UNKNOWN` otherwise)             |
| `model`             | The model (as the provider spells it, no prefix); the key is not a review setting but the workspace's own (`src/llm/`)                                                  | `LLM_MODEL`, else `anthropic/claude-haiku-5.5` | the pattern the runner accepts                                   |
| `fallbackModel`     | Tried when the model fails; `null` = none                                                                                                                               | none                                           | same pattern                                                     |
| `extraInstructions` | Project rules for the model, free text                                                                                                                                  | none                                           | 4000 characters, no control characters                           |
| `maxFindings`       | The most findings one review lists                                                                                                                                      | 5                                              | 1 to 30                                                          |
| `maxTokens`         | Token budget of a review (`llm.maxTokens`)                                                                                                                              | 100000 (PR-Agent's own: 32000)                 | 8000 to 2000000, not above the model's context window (if known) |
| `largePrChunking`   | Review a large pull request in chunks instead of leaving files out                                                                                                      | on                                             | boolean                                                          |
| `inlineKeyIssues`   | Also post every finding as an inline comment                                                                                                                            | off                                            | boolean                                                          |
| `autoReviewOnOpen`  | Review when a pull request is opened, reopened or marked ready                                                                                                          | on                                             | boolean                                                          |
| `autoReviewOnPush`  | Review again when commits are pushed                                                                                                                                    | on                                             | boolean                                                          |
| `allowedCommands`   | The comment commands people may use (`review`; the removed commands became `[]` on upgrade)                                                                             | `["review"]`                                   | a subset of `["review"]`, no duplicates                          |

The limits are `REVIEW_SETTING_LIMITS`; `validate.ts` checks every field and reports each problem as
`{ field, code }` with a stable code (`REVIEW_SETTING_ISSUE_CODES`), never with the value.
`parseStoredOverrides` reads what is stored and drops any field this version would not accept, and
stored text that is not JSON at all reads as no settings (a `[db] APP_SETTING_UNREADABLE` or
`PROJECT_SETTINGS_UNREADABLE` warning names the setting or the project, never the text), so old,
damaged or hand-edited data cannot make a review fail, the project list or a page. The next save
replaces it.

The token budget must fit into the context window of the models the saved settings would use (model and
fallback model, counted in the model's own tokens, only for models the price table knows):
otherwise the save is refused with `EXCEEDS_MODEL_CONTEXT` on `maxTokens` (or on the model, when the
request only changed the model). A combination that a later change of another layer made too large is
not blamed on an unrelated save; `cost.exceedsContext` lists it for the UI. **For a workspace on the operator's key**
(key mode `managed`, #280) none of this applies: the stored model is not the one that runs and the user does not know
the one that does, so the save does not check `maxTokens` against a model and `cost.exceedsContext` is empty; the claim
cuts the budget to the window of the catalog entry's model (`src/model-catalog/README.md`, "The token budget of a managed
job").

**The quality level `modelTier` is gone (#434).** The tiers Low, Medium and High were turned into catalog entries
(`20261018170000_migrate_model_tiers_to_catalog.ts`, `src/model-catalog/README.md`, "Migrated from the tiers") and are no
setting any more: a request that carries `modelTier` is refused as an unknown field (`400 UNKNOWN_FIELD`, `field` is the name,
never a value), and a stored `modelTier` is read by nothing (`parseStoredOverrides` knows the fields of the table above
only). It stays in the stored JSON until a later migration removes it; **a save of the Diff group of a project or of the
defaults replaces that group as a whole, so the member goes with the first save of its row** (the migration has already
copied its meaning into `catalogEntryDiff` and `catalogEntryDynamic`).

## A workspace on the operator's key chooses a catalog entry, not a model (#283, #433)

For a workspace whose key mode is `managed` (`operatorsModels` of the service, read on every call) the models are the
operator's and the workspace never sees them (`src/model-catalog/README.md`):

- **The views carry no model.** `getGlobalSettings`, `getProjectSettings` and the answer of a save have no `model`, no
  `fallbackModel` and no Dynamic model: not in `effective`, `overrides`, `builtIn`, `inherited`, `sources` or
  `dynamic`. `cost` is `null` (the estimate would be for a model that is not used). They add
  `modelManagedByInstance: true`. Other workspaces get `modelManagedByInstance: false` and the views exactly as before.
- **A write may not set a model.** A body with `model` or `fallbackModel` (and, for a project, `dynamicModel`, also
  `null`) is refused `400 REVIEW_SETTINGS_INVALID` with an issue `{ field, code: "MODEL_MANAGED_BY_INSTANCE" }` for
  every such field, judged on the names before any value, and nothing is stored.
- **Stored models are kept.** The models a workspace saved on its own key stay stored: a save from a managed
  workspace carries them through (the defaults replace their layer as a whole, so the service puts the stored
  `model`/`fallbackModel` back; the Dynamic model is a project-only field that a save already keeps). The workspace
  gets them back if it returns to its own key.
- **The form** shows the catalog chooser in place of the provider, model, fallback model, Dynamic model, model
  suggestions and cost estimate (see "The settings form" below); the Low/Medium/High choice of #283 is gone from it
  (#433, and the setting itself with #434). The token budget stays. The form reads everything from the view (`managed`, `catalogChoices`), so a save that
  changes the key mode adapts the next answer.
- **The instance admin is not special inside a workspace (decision).** An instance admin who is a member of a managed
  workspace gets the same stripped view and the same refusal as its other members: the view depends on the workspace's
  key mode, never on the user. The operator sees and sets which model backs each catalog entry in the instance admin portal, not inside a
  customer workspace. The admin's view of a workspace on its own key (the admin's usual one) is unchanged.
- **Fail closed for display.** The models are hidden whenever the key mode is anything but `own`, so a workspace whose
  entitlements cannot be read (`unreadable`) also shows no model field and no estimate, and refuses a model write; its
  jobs fail closed in that state too.
- **A reset keeps the stored models.** `DELETE` on a project removes every override but the models saved on the
  workspace's own key (`model`, `fallbackModel`, Dynamic model), like a save does.

## The address pinned for a catalog provider (#588)

A project that selects a provider of the models.dev catalog (own key, #555) gets one more stored field, `dynamicProviderAddress`: the
address the catalog trusted for that provider when it was selected. It is written by the server only (a request that names it is
`UNKNOWN_FIELD`) and the claim sends the key to exactly that address (`src/native-cost/README.md`, "Where the key goes"). No table, no
migration: it is one more key of `projects.settings`.

- **When it is written** (`provider-pin.ts`, `pinAfterSave`): when the save leaves the project with a catalog provider that it did not have
  (selecting, or changing the provider), and when the request carries `confirmProviderAddress: true`, the action behind "Confirm the new
  address" on the settings page (`PROVIDER_ADDRESS_NOT_PINNABLE` when there is no catalog provider or the catalog trusts no address
  for it). Every other save keeps the pin, whatever the catalog trusts now; a model change alone does not move it. Going back to a
  provider of the registry removes it; a managed workspace's saves carry it through; a reset on the own key clears it.
- **What the view says** (`ProjectDynamicView.providerAddress`): `pinned`, `current` (what the catalog trusts now) and a state:
  `pinned`, `unpinned` (a selection from before pins; its first review pins it), `changed` (reviews are refused until confirmed) or
  `unavailable` (the catalog trusts no address for the provider now). The form shows it as small read-only text, with the
  confirmation checkbox only for `changed`.
- **Legacy selections.** Not re-selected: that would stop reviews of running customers. The first claim pins
  (`adoptProviderAddress`, a compare-and-set inside the settings write), at the address it is about to send the key to, which is
  the trust the selection had until then.
- **Who may move it.** A Member saves the settings of a project (`change_project_settings`), but writing or moving the pin is for the
  roles that manage the workspace's LLM key (`manage_llm_key`, Owner and Admin; `provider-pin.ts`, `pinMoveNeedsRight`). The route
  passes the right (`canManageLlmKey`, from the role) to `updateProjectSettings` and `resetProjectSettings`; left out, the actor may
  not. A save that would **drop or replace a pin that is not the address the catalog trusts now** (the confirmation, a reset, going back
  to the registry or to another provider) or **write a pin that differs from one another project of the workspace holds for the
  provider** (selecting it in a second project, or a model-only save of a selection from before pins) is refused for anyone else with
  `PROVIDER_ADDRESS_CONFIRM_FORBIDDEN` (403) and stores nothing. The first pin of a provider in a workspace, and every save that
  leaves the pin as it is, need no right. The claim adopts a legacy selection's address only when no other project of the workspace
  pinned another one; else it holds to that pin and the job is refused (`provider_address_changed`). The form shows the confirmation
  checkbox only to those who may confirm, and tells everyone else that an Owner or Admin must. A confirmation on its own leaves the
  Diff overrides of the project alone. Known and accepted: a stored pin of a shape no address has is dropped when read, and an older
  instance that saves during a rolling deploy does not know the field and drops it (the next claim adopts it again).

## Provider and catalog entry per kind (#430)

Additive fields of the same settings JSON (ADR 0005, 2.7): no table, no migration, every setting stored before them stays
valid. Two families sit side by side and only the one that matches the workspace's key mode is used.

| Field                                     | Layers                          | Meaning                                                                                                      |
| ----------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `provider`                                | workspace default and project   | The provider of the Diff `model`. Absent: the default provider (`openrouter`), so legacy JSON resolves to it |
| `dynamicProvider`                         | project only (`null` clears it) | The provider of `dynamicModel`                                                                               |
| `catalogEntryDiff`, `catalogEntryDynamic` | project only (`null` clears it) | Managed mode: the opaque id of the catalog entry for that kind. **No workspace default** (decision C3)       |

- **Validation** (`validate.ts`, pure, stable codes, no value echoed): a provider must be in the registry
  (`PROVIDER_UNKNOWN`); a model is held to the model-id rule of the provider the same request names (`provider` for
  `model` and `fallbackModel`, `dynamicProvider` for `dynamicModel`), else the default provider's. An entry id is only
  checked for its shape (`INVALID_TYPE`, `EMPTY`, `TOO_LONG`, `INVALID_FORMAT`); `dynamicProvider` and the entries are
  unknown fields of the workspace defaults.
- **The entry checks** (`catalog-selection.ts`, the service, managed workspaces only): the entry must exist
  (`CATALOG_ENTRY_UNKNOWN`), be released (`CATALOG_ENTRY_NOT_RELEASED`: a draft or a retired one), serve the kind of the
  setting (`CATALOG_ENTRY_KIND_MISMATCH`) and be allowed by the plan (`CATALOG_ENTRY_NOT_ALLOWED`, `modelAccess` of
  #428), in that order. Every refused kind is named. A model name is never an entry id: it is refused like any
  other id that is no entry.
- **Who may write what.** A workspace on the operator's key may not write `provider`, `model`, `fallbackModel`,
  `dynamicProvider` or `dynamicModel` (also not to the workspace defaults): `MODEL_MANAGED_BY_INSTANCE`, as for the models
  before. A workspace on its own key never reads the catalog, so it **may not select an entry**: the write is refused
  `CATALOG_ENTRY_OWN_KEY_MODE` (decided against "stored inactive": an entry would be stored unchecked and the catalog
  would have to be read to check it); `null` is allowed, it clears an entry stored while the workspace was managed.
- **A save keeps what it does not set.** The Diff group is replaced as a whole by a request that carries a Diff field,
  as before; the project-only fields, the other kind's fields and the other key mode's family are merged and kept. A
  managed save puts the stored `provider`, `model` and `fallbackModel` back, and keeps `dynamicModel` and
  `dynamicProvider`; an own-key save never touches the entries. A **reset** (`DELETE`) keeps the other family too: the
  own-key models and providers while managed, the catalog entries while on the own key.
- **Views.** On the operator's key the views carry no `model`, `provider`, `dynamicModel` or `dynamicProvider` (a test
  searches every key and a sentinel value). The project view adds `catalogSelection` (the entry id per kind, `null`: none,
  the instance default applies at the claim) and `catalogChoices`, per kind the entries that serve it:
  `{ id, name, description, available, reason }`. A released entry that the plan does not allow is listed locked
  (`reason: "CATALOG_ENTRY_NOT_ALLOWED"`, C4); a retired one is listed locked (`CATALOG_ENTRY_NOT_RELEASED`) only while the
  project has it selected (C5); a draft never. The choices are built from the member entries, which have no provider or
  model. Both are `null` on an own key; the stored entries are not shown there.
- **Effective resolution** (`effective.ts`): `provider` layers like any Diff field (project over workspace default over the
  built-in default provider, with its source); `dynamicProvider` and the entries are the project's or the built-in value
  (`null` for the entries). `resolveForRepository` returns them for the claim, which hands the entry of the job's kind to the model
  selection resolver (#432, `runner-api/claim-selection.ts`): `toRunnerSettings` is unchanged.
- **The Dynamic metadata check** (#269) asks the adapter of the provider the project selected (`dynamic-check.ts`): the
  model of the request at the provider of the request, else the stored one, else the default; a request that only
  changes the provider asks again about the stored model at the new provider.
- The model a provider other than the default would use when no
  layer sets one is the claim's business (#432): the views show the model of the layers.

## The settings form: provider, model and catalog entry (#433)

`ui/settings-form.tsx` is one form for the workspace defaults and for a project. What the Model card (Diff Review) and
the Review kind card (Dynamic Review) show depends on the key mode of the workspace, read from the view:

| Key mode | Per review kind                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Sent when changed                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| own      | a **provider select** (`ui/provider-select.tsx`: the registered providers, `llmProviderDescriptors`) next to the **model** field, with the suggested models of the chosen provider as its datalist (one `<datalist>` per provider and review kind) and as a list to pick from under the field (`ui/suggested-models-select.tsx`); a provider may suggest fewer models for Dynamic Review (`dynamicSuggestedModels`, `suggestedModelsFor`): Anthropic leaves out the models a Dynamic Review cannot use (#532); the cost estimate of Diff Review prices the model with the chosen provider's table (`cost.ts`, `estimateReviewCost(settings, prices?, providers?)`) | `provider`, `model`, `fallbackModel` (Diff group, workspace defaults and project); `dynamicProvider`, `dynamicModel` (project, `null` when put back to the shipped value) |
| managed  | the **catalog chooser** (`ui/model-choice.tsx`): a radio list of the entries of `catalogChoices[kind]` in the order of the view (`sort_order`), label = name, text = description, nothing else; the project's selection comes from `catalogSelection`. The workspace defaults show a note instead (no workspace-level default entry, decision C3)                                                                                                                                                                                                                                                                                                                  | `catalogEntryDiff`, `catalogEntryDynamic` (project-only; `null` takes the choice back)                                                                                    |

- **Locked and unusable entries.** An entry that the plan does not allow is listed disabled with "Not included in your plan"
  and a link "Manage plan" to the plan page of the workspace (`/w/<slug>/settings/plan`, which exists for every workspace;
  its "Manage plan" button is shown to Owners and Admins only). A retired entry the project still has chosen is badged "No
  longer available" without a link. The entry in force stays selectable even when unusable, and a status note says
  reviews would not start until another is chosen (decision C5: no silent fallback). A choice is taken back with "Reset to
  default", which means "the default of this instance".
- **Both kinds keep their choice.** The two entries (and the typed provider and model of each kind) are held side by side
  in the form state (`dynamic-form-state.ts`: `catalogEntries`, `dynamicProvider`), so switching the kind loses neither.
- **A managed workspace never receives a provider or a model.** The view has none; the form has no control for them, no
  datalist and no estimate, and `project-save.ts` sends neither (a test plants a sentinel where a leak would sit and
  searches the DOM and every request body). An untouched form still sends nothing; a changed form sends only the changed
  groups, and the project-only entries travel in the project request.
- **A model belongs to its provider.** Choosing a different provider clears the model (and the Diff fallback model) typed
  for the old one, because a model id means something only at its provider; the person names it again, with the
  suggestions and the cost estimate of the new provider (the estimate waits for a model). Choosing the same provider again
  changes nothing, and "Reset to default" on the provider takes its models back with it (`form-state.ts` `setProvider`,
  `dynamic-form-state.ts` `setDynamicProvider`). The server checks each model against the rule of the provider named in the
  same request, so a mismatched pair is also refused there.
- **A provider without a stored key (decision C7).** A page of a workspace on its own key passes `keyedProviders`
  (`keyed-providers.ts`, from `keyServiceFor(workspaceId).statusAll()`: a readable key counts, an unreadable one does not);
  a managed workspace gets no list and its statuses are not read (`keyedProvidersFor`, a page test pins it). A provider without one is
  marked "no key yet" in the select and can still be chosen; the chosen one shows a warning with a link to the LLM
  access page. The warning is for the kind that is shown (Diff or Dynamic) and never appears on the operator's key.
- **Copy.** Every code a save can answer with has a sentence in `ui/messages.ts` (`describeIssue`), including
  `PROVIDER_UNKNOWN`, the four `CATALOG_ENTRY_*` codes and `CATALOG_ENTRY_OWN_KEY_MODE`; the chooser's own words are
  `src/copy/model-choice.ts`, scanned by a test for model, vendor, price and cost words (the sentences about the plan are
  the one place that says "plan").
- **The claim reads the entries (#432).** A managed job runs on the entry the project chose for the kind of the job, else
  the instance default of that kind, and the usage record names the entry. A tier stored earlier (a managed workspace that
  chose High under #283) is no longer read by the claim; it stays in the settings until #434 migrates it, and the form
  neither shows nor changes it.

## From settings to a runner job

`toRunnerSettings(settings)` (`runner-settings.ts`) returns `{ llm: { model, maxTokens }, env, fallbackModels }`:

| Setting              | Runner job                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`, `maxTokens` | `llm.model`, `llm.maxTokens` (the provider and the key come from the LLM configuration, `src/llm`)                                                                                                                |
| `extraInstructions`  | `PR_REVIEWER__EXTRA_INSTRUCTIONS`, `PR_DESCRIPTION__...`, `PR_CODE_SUGGESTIONS__...`, `PR_QUESTIONS__...` (left out when empty)                                                                                   |
| `maxFindings`        | `PR_REVIEWER__NUM_MAX_FINDINGS`                                                                                                                                                                                   |
| `largePrChunking`    | `PR_REVIEWER__ENABLE_LARGE_PR_CHUNKING=true` (left out when off: PR-Agent's own value is off)                                                                                                                     |
| `inlineKeyIssues`    | `PR_REVIEWER__INLINE_KEY_ISSUES=true` (left out when off: PR-Agent's own value is off)                                                                                                                            |
| `fallbackModel`      | `fallbackModels` (in the contract, but the app **does not send it** in the MVP: no fallback chain is decided)                                                                                                     |
| triggers, commands   | nothing: the app is the only trigger. The webhook handler's trigger policy asks `isAutomaticReviewEnabled(settings, "opened" or "updated")` (CR-31) and the comment handler `isCommandAllowed(settings, command)` |

The result holds only `PR_*` variables the runner lets through (`RUNNER_ENV_KEY_PATTERN`, defined in
`src/runner-api/contract.ts`, is the runner's own allowlist and the one in the contract file) and the two `llm` fields. It never receives the LLM key or a Git token, so it cannot
contain them. The names are PR-Agent 0.47.0's: `runner-settings.test.ts` reads
`fixtures/pr-agent-0.47.0-configuration.excerpt.toml` (verbatim lines of that release's
`configuration.toml`) and checks that every variable exists there with the kind of value we send, and
that the switches we leave out when off really are off by default.

**Names, and when PR-Agent is upgraded:** copy the lines named in the header of the fixture from the
`pr_agent/settings/configuration.toml` of the new release (PyPI package `pr-agent`, for example the
installed one in `runner/.venv/lib/python3.13/site-packages/pr_agent/settings/`) into the fixture,
change the version in its file name, and fix what the test reports. Check the new release's Dynaconf
behaviour for free text again (next section): the table in `runner-settings.test.ts` is what 0.47.0 does.

### Things to know

- **Free text is interpreted by PR-Agent's settings loader.** PR-Agent reads its environment through
  Dynaconf. Measured against PR-Agent 0.47.0 / Dynaconf 3.3.5: a value that starts with
  `@format {env[OPENROUTER__KEY]}` or `@jinja ...` is **evaluated** against the process environment (the
  LLM key and the GitHub token are in it) and the result goes into the prompt; other `@` converters change
  the type or abort the run; a text that is only a number, a date, a quoted string, a list or `true`,
  `false`, `inf`, `nan` becomes that value instead of text (also when it is only the _first token_:
  `true` followed by a line break and a line `foo = 1` is read as the boolean). `protectFromSettingsParser`
  puts one line break in front of a text that starts with anything but a letter, or whose first token is
  `true`, `false`, `inf` or `nan`; any other text is passed on exactly as it is. A runner test with the real PR-Agent should pin the same
  table (the engine suite).
- **The environment wins over a repository's `.pr_agent.toml`.** The runner keeps the variables in the
  process environment, and PR-Agent re-applies the environment after merging a repository file. So the
  precedence "global < project < repository file" holds only for keys this module leaves out: the
  project rules (when empty), the switches (when off) and everything not listed above. A value that is
  always sent (`maxFindings`, project rules, switches that are on) cannot be changed by the repository
  file. To give the repository file the last word, the runner would need to apply these options as typed
  settings (`get_settings().set(...)`) instead of environment variables.
- **`llm.maxTokens` is not yet the token budget.** The runner passes it as `config.custom_model_max_tokens`
  (the context window of a model PR-Agent does not know). PR-Agent then clamps that to
  `config.max_model_tokens`, which is 32000 unless set (`algo/token_budget.py`, `get_max_tokens`). The
  runner has to set `CONFIG__MAX_MODEL_TOKENS` from `llm.maxTokens` as well, otherwise a budget above
  32000 has no effect.
- `LLM_MAX_TOKENS` (`src/llm`) is not used here: the budget is a review setting now. It stays as the
  instance's hint for the context window of a model PR-Agent does not know (`contextWindowTokens`), and
  the budget of a review replaces it in a job.

**The built-in model is visible to members.** The built-in value of `model` is the instance's `LLM_MODEL` (or the
recommended default), and a member sees it in this form as "built-in value" (decided with #144: a model name is no
secret). The provider and the key are not review settings: they are the workspace's LLM access (`src/llm/README.md`).

## Cost guard

`estimateReviewCost(settings)` (`cost.ts`) answers what a typical review is expected to cost with the
model (and the fallback model) and lists the warnings: `above_limit` when the estimate is above **0.10 USD**,
the customer's limit (exactly 0.10 does not warn), and `cost_unknown` for a model the price table does
not know. `warn` is true when there is any. It never blocks a setting; the UI shows the warnings.

The price per model is a small static table (`src/llm/providers/openrouter/model-pricing.ts`, behind the provider's adapter, USD per million tokens from OpenRouter's
model list, with the day it was read, the same prices the model comparison used); the model comparison
ticket keeps it up to date. A review is assumed to send 30000 tokens (the size of a large pull request, never
more than the budget) and get 3000 back, in one call. The prompt is multiplied by the model's
`inputTokenFactor`: PR-Agent cuts the diff in its own tokens, and a Claude model counts the same diff as
1.4 times as many (45k against 32k, measured in the model comparison). That puts the estimate for
Claude Haiku 5.5 (the default model) at 0.006 USD (0.0051 measured for the large pull request), for Gemini 3.8
Flash at 0.034 (0.035 measured on average) and for Claude Sonnet 5.5 at 0.114 USD, above the limit, like the
one large review that was measured (0.1004 USD): Sonnet is the quality alternative for a single project and
shows the warning. `upperUsd` of an estimate is the most a review can cost with the model: the whole
budget as the prompt, and every call that chunking a large pull request allows (three); it is shown
and never warns. `exceedsContext` lists the models whose context window is smaller than the budget.

## Routes

All of them belong to the workspace in the address (`src/workspaces/README.md`): the defaults are the defaults
of that workspace (`app_settings` is per workspace), every member reads them and changing them needs an
Admin or an Owner (`manage_review_defaults`); the settings of a project are read and changed by every member
(`change_project_settings`). They are protected by the proxy (401, 403 and the answer of a missing path for
a workspace that is not the person's) and by `withWorkspace(...)` (called first). A change must come from
this site (`Sec-Fetch-Site`/`Origin`), be `application/json` and at most 64 KB.

| Route                                                                  | Does                                                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/w/:workspace/review-settings`                                | the global defaults: `overrides`, `effective`, `sources`, `builtIn`, `cost`, `modelManagedByInstance`, `limits`, `updatedAt`, `updatedBy`        |
| `PUT /api/w/:workspace/review-settings`                                | body `{ "settings": { ... } }`, replaces the global defaults                                                                                     |
| `GET /api/w/:workspace/repositories/:repositoryId/project/settings`    | the project's `overrides`, `effective`, `sources`, `inherited`, `cost`, `limits`, and on the operator's key `catalogChoices`, `catalogSelection` |
| `PUT /api/w/:workspace/repositories/:repositoryId/project/settings`    | body `{ "settings": { ... } }`, replaces the project's overrides                                                                                 |
| `DELETE /api/w/:workspace/repositories/:repositoryId/project/settings` | removes the project's overrides                                                                                                                  |

A repository that was never activated can be read (the defaults, `projectId` null, `active` false) and
saved: the first save creates its project with `active = 0`, so the settings are in place when it is
activated; reviews still start only for active projects (webhook intake, manual start and claim are
unchanged). A reset of such a repository writes nothing.

Refusals are `{ "error": <code> }` (`errors.ts`): `400 REVIEW_SETTINGS_INVALID` (plus
`"issues": [{ "field", "code" }]`), `400 REVIEW_SETTINGS_REQUEST_INVALID` (not JSON, or no `settings`
object), `403 REVIEW_SETTINGS_CROSS_SITE_REQUEST`, `413 REVIEW_SETTINGS_BODY_TOO_LARGE`,
`415 REVIEW_SETTINGS_CONTENT_TYPE_UNSUPPORTED`, `404 REVIEW_SETTINGS_PROJECT_NOT_FOUND` (there is no such
repository, or the platform no longer lists it and it has no project). The settings pages (below) call these routes from the browser.

## The project-only settings: review kind, Dynamic model and skill (#194)

A project also selects the one review kind it runs (#193). These fields live in the same
`projects.settings` JSON as the Diff overrides but are **project-only**: the global defaults and the
built-in layer never hold them (`validateReviewSettingsPatch` reports them as `UNKNOWN_FIELD`), so a
review kind can never become a workspace-wide default.

| Field          | Meaning                                                                               | Default                        |
| -------------- | ------------------------------------------------------------------------------------- | ------------------------------ |
| `reviewKind`   | `diff` (the existing PR-Agent review) or `dynamic` (the read-only agent of the epic)  | `diff`                         |
| `dynamicModel` | The model a Dynamic review uses, as the configured provider spells it, kept literally | `deepseek/deepseek-v4.1-flash` |
| `reviewSkill`  | The project's review-skill override, or absent for the shipped default skill          | the shipped default skill      |

`dynamicModel` is a **default, not an allow-list** (#194-T08): any identifier the provider serves is
kept as-is, with no provider rewrite and no routing field. How a configured model is resolved and
whether it can serve the engine's needs is #197's business, not a project setting. `reviewKind` is
independent of the Diff `model`, so each kind keeps its own model and skill across a switch.

**Saving a Dynamic model checks it (#269).** Dynamic Review needs tool calling, so a `dynamicModel` that a
project save sets (a string, not `null`) is looked up in the provider's public model metadata first
(`src/llm/model-capabilities.ts`, before the write, outside the transaction). The outcome decides the save:

| Outcome         | The save                                                                                                                                                              | Where it shows                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `supported`     | goes through                                                                                                                                                          | nothing                                         |
| `unsupported`   | refused, nothing stored: `REVIEW_SETTINGS_INVALID` with the issue `DYNAMIC_MODEL_TOOLS_UNSUPPORTED` on `dynamicModel`                                                 | the sentence next to the model field            |
| `unknown_model` | refused, nothing stored: the issue `DYNAMIC_MODEL_UNKNOWN` on `dynamicModel`                                                                                          | the sentence next to the model field            |
| `unverifiable`  | goes through; the answer carries `warnings: [{ "field": "dynamicModel", "code": "DYNAMIC_MODEL_UNVERIFIED" }]` (the run-time check of the runner proxy still applies) | a warning under the "Saved" message of the form |

Not checked: the Diff `model` and `fallbackModel`, a save that leaves the Dynamic model out or clears it, the
global defaults (they cannot hold a Dynamic model), and a value that is already stored (a stored model is never
re-checked or rewritten). A service built without a `modelCapabilities` checker checks nothing (tests of other
behavior); the running server always passes the real one (`shared.ts`).

**No schema migration.** The fields are JSON inside `projects.settings`, and missing values read as Diff
Review, `deepseek/deepseek-v4.1-flash` and the shipped skill (`resolveProjectDynamicSettings`,
`builtInProjectDynamicSettings`). An existing project therefore behaves exactly as before; a
legacy-data integration fixture pins this (`service.integration.test.ts`, #194-T06). The default is
the id OpenRouter serves, because the name is sent to the provider as it is (#262). One data migration
(`20261014090000_fix_dynamic_default_model`) rewrote a stored `dynamicModel` of the first, wrong
spelling `deepseek-v4.1-flash`, in a project's overrides or the workspace review defaults, to that id.

The skill is **untrusted data**: it is stored as text, bounded to `PROJECT_DYNAMIC_LIMITS.reviewSkillMaxBytes`
(16 KiB of UTF-8, so multibyte characters count as their bytes), refused with a stable code on
forbidden control characters or an unpaired surrogate, and never interpreted. An empty or null value is
an explicit reset to the shipped default, never another project's skill. A provider/model slug
like `deepseek/deepseek-v4.1-flash`, a URL, a permission or a credential is not part of these settings.

`default-skill.ts` is the **reader seam** for the shipped default skill (id, version, hash and text).
Since #198 the text is the canonical asset `contracts/dynamic-review/review-skill.md`, embedded in the
module because the app image ships only `app/` and the three license files; `default-skill.test.ts`
reads the asset and fails when the two differ, so there is never a divergent copy. The service, the
route and the claim share this one seam, and the runner composes the text after its code-owned fixed
core (see `runner/README.md`).

A project save keeps the two groups apart. A request that carries **any** Diff field replaces the
Diff override set as a whole (a field left out is inherited again); a request that carries **only**
project-only fields keeps the stored Diff group, so switching kind, changing the Dynamic model or
resetting the skill removes nothing of the Diff configuration, and an empty request still replaces the
Diff group with nothing (every Diff field taken back to its default). The project-only fields are
always merged over the stored ones, so a request that does not mention them keeps them and a
`reviewSkill` or `dynamicModel` of `""`/`null` clears only that override.

The write goes through `projects.updateSettingsWith` in one transaction. The stored settings are read
under a lock on the workspace-scoped repository row: SQLite already holds the single write lock
(`begin immediate`), Postgres takes the row's `FOR UPDATE` lock before the read, so two instances
cannot lose an update by reading the same settings and writing them back
(`projects-repository.postgres.integration.test.ts`). The same transaction calls `hooks.ts`
`onProjectSettingsChanged`, for a save **and** for a full reset, so #195 can cancel the project's
waiting reviews on a kind change; a rejecting hook rolls the write or the reset back (`#194-T07`). A
full reset (`DELETE`) clears every override, including the project-only fields, and reports the kind
change back to Diff.

`ui/project-save.ts` turns a project form into requests (#200) and keeps those rules in one place: an
**untouched form sends nothing** (an empty request would clear the Diff overrides, so the form says "No
changes to save." instead); the Diff group is sent as a whole, only when it changed; a project-only
field (kind, Dynamic model, skill) is sent only when the person changed it, so a form that was opened
before another client changed the kind, model or skill cannot overwrite the newer value with its stale
one; the skill is reset with `reviewSkill: null` and the Dynamic model with `dynamicModel: null` (the
built-in default applies again), and a custom skill text equal to the shipped text is sent as that
reset, never as a copy. Taking every Diff override back is an **explicit empty request**. One
request cannot both clear the Diff group and carry project-only fields, so a save that does both sends
the empty reset first and the project-only fields second; if the second fails, the first stays saved and
the Review kind card says what was not saved (`adoptCards` takes the saved cards from the answer and
keeps the typed values of the others). Global defaults still use `buildPatch` (`ui/form-state.ts`).

`getProjectSettings` / `resolveForRepository` expose the `dynamic` view: the effective kind, model and
skill, where each comes from, the shipped defaults, whether the skill is the default, the default
skill's identity and the size limit.

## A catalog provider and model for Dynamic Review (#555)

A workspace on its **own key** may choose, for Dynamic Review only, any provider of the models.dev catalog that OpenCode supports
with a static key (`contracts/opencode-providers.v1.json`) and one of that provider's tool-calling models. The catalog is read by
`src/native-providers/` (its README has the whole picture); this module only checks and stores the pair.

- `dynamicProvider` may be a catalog provider's slug (`validate.ts`: `nativeDynamicProvider`; the model is held to the shape of a
  job entry, `isCatalogModelId`), and `dynamicModel` is then required. A provider of the registry keeps its own path, **Diff is
  unchanged** (its fields keep their two providers until #558), and a catalog provider is never accepted for Diff.
- **The save** (`service.ts`: `refuseUnfitNativeChoice`, pure part in `native-choice.ts`) puts the pair to
  `NativeCatalogReader.checkSelection` when the save sets the provider or the model. A model the catalog does not list
  (released today before the next daily fetch, or no longer listed) is refused with `MODEL_NOT_IN_CATALOG` on `dynamicModel`
  and nothing is stored; the admin's "Refresh now" (#554) is the way to get it sooner. A missing model is `EMPTY`. The provider's own
  model metadata is not asked (the catalog is the list), so `checkDynamicModel` skips a catalog provider. A pair that is already
  stored is **not** checked again by a save that does not touch it, so an unrelated save does not fail because a model has left the
  catalog since.
- **Retired later.** A stored model that models.dev stopped listing keeps being served by the claim from its last known row (the
  decision of #548, see `src/runner-api/README.md`, "A catalog model on the workspace's own key"); the picker shows a warning.
  Only a row that is gone fails closed (`llm_model_unavailable`).
- **A workspace on the operator's key never gets this**: it chooses named catalog entries, the save does not read the catalog
  of providers and the form shows no provider or model id (a save naming a provider or a model is refused with `MODEL_MANAGED_BY_INSTANCE`, #283).
- **The form.** The Dynamic card shows the provider (the registry's two and the catalog providers the workspace holds a key for,
  `native-providers/form-data.ts`), then, for a catalog provider, `CatalogModelPicker` (search, name, context, price when known)
  instead of the free-text model field, and `OwnKeyCostNote`: with an unknown price the run is bounded by the token cap and the time
  limit and the own-key cost limit does not apply; with a known price the cost limit applies as before and the price source is shown;
  with billing on the note says that a run on the own key is charged for infrastructure minutes only (no rate, no formula).

## The pages

The workspace settings are sub-pages with a sub-nav (#178). `/w/:workspace/settings` is **General** (the
workspace name, the read-only instance, tenancy and member facts and the one "Needs attention" strip);
`/w/:workspace/settings/review-defaults` holds the form for the global defaults;
`/w/:workspace/settings/llm` holds the workspace key; `/w/:workspace/settings/plan` shows what the operator allows
the workspace and what it has used (#282, listed only for a workspace with entitlements); `/w/:workspace/settings/advanced` holds the
destructive actions (removing the key, resetting every default). A project has its own settings page
(`/w/:workspace/projects/:repositoryId`) next to its "Review now" page (#174). The form
(`ui/settings-form.tsx`) shows the value in force and where it comes from (built-in, global, this project);
changing a field sets it for the layer, "Reset to default" takes it back; a save sends only the fields that
are set and replaces the layer. Since #174 it is three cards (Model, Review, When to review, from
`ui/model-fieldset.tsx`, `ui/review-fieldset.tsx` and `ui/when-fieldset.tsx`) in one form with one footer;
the estimated cost sits in the Model card and resetting the whole project is a separate card at the bottom
whose confirmation is a dialog. `ui/form-state.ts` checks the values with `validateReviewSettingsPatch`
before sending, so a
wrong value is named next to its field with a sentence from `ui/messages.ts` (a code is never shown);
the answer of the server is shown the same way, including `EXCEEDS_MODEL_CONTEXT`, and the first marked
field takes the focus. The estimated
cost updates while typing (`estimateReviewCost`) and shows the `above_limit` and `cost_unknown`
warnings and a token budget above the context window; warnings never block a save. The **fallback
model** is stored but not sent to the runner in the MVP: the form says so next to the field and the cost summary lists it as "not used yet" without an estimate or a cost warning (a context window that is too small still blocks the save, so that warning stays). A form is keyed on the server data, so a page that Next keeps mounted after a navigation starts from fresh data when it is shown again. For a project, the reset asks for a confirmation first; the workspace-wide reset is a danger zone on `/settings/advanced` (an empty patch through the same global route, `ui/reset-defaults.tsx`). A project form has a fourth card, **Review kind** (#200, `ui/review-kind-fieldset.tsx`), above the others
because they follow its choice: exactly one of Diff Review and Dynamic Review (a radio group, never two
checkboxes). With Dynamic Review chosen it holds the Dynamic model (a default, not an allow-list;
`messages.ts` names a bad one, and "Reset to default" puts the built-in model back) and the review skill
(`ui/skill-editor.tsx`): the shipped skill is shown
read-only with its id, version and SHA-256, "Edit skill" starts an override from that text, "Reset review
skill to default" stages the shipped skill again until Save, and a counter shows the UTF-8 bytes against
the 16 KiB limit. The Model card (model, fallback model, token budget and the cost estimate), the chunking
and inline switches and the project rules are PR-Agent's and are not shown for Dynamic Review; their values
stay in the form and are kept when the person switches back (a problem in a field the selected kind does not
show is reported on the card, which says which kind to choose to see it). Dynamic Review has no cost
estimate: the card says so, and the Diff estimate comes back with Diff Review. A switch of the kind is
confirmed in a dialog when the person saves (waiting reviews of the old kind are cancelled, the next review
posts a fresh summary comment, no finding is carried over, #193). "Discard changes" takes every unsaved
change of a project form back.

**The instance gate.** Dynamic Review is only queued while the instance setting `dynamic_review` is on
(`jobs/dynamic-review-gate.ts`, default off). The page reads it with `isDynamicReviewEnabled`
and the card says the truth: while it is off, the Dynamic option carries "Not enabled on this instance yet."
and choosing it shows that reviews of the project fail until an instance admin turns it on (the run ends
with `dynamic_review_disabled`, see `runs/error-copy.ts`). The choice stays **available** so a project can
be prepared before the gate is turned on, like an inactive project can be configured before it is
activated; the card never claims it works. Static text, no live region.

The claim of the runner API and the webhook intake use `service.resolveForRepository(repositoryId)`
(`shared.ts`: `getReviewSettingsService()`), then `toRunnerSettings` and the checks above.

## Testing

`validate.test.ts`, `effective.test.ts`, `runner-settings.test.ts`, `cost.test.ts`, `catalog-selection.test.ts` and
`dynamic-check.test.ts` (unit, pure),
`service.integration.test.ts`, `selection.integration.test.ts` (the provider and catalog selection, a real catalog),
`validate-native.test.ts` and `native-model.integration.test.ts` (#555: a catalog provider and model, the refusal of a model outside the catalog, a managed workspace refused; SQLite), `dynamic-model-check.integration.test.ts` and `http.integration.test.ts` (real SQLite, the metadata from the fake LLM), the repositories' own tests in
`src/db/repositories/`, and in `integration-tests/http/` the proxy in front of the routes
(`review-settings-route.integration.test.ts`) and the real route files
(`review-settings-route-file.integration.test.ts`). The test cases that need the real PR-Agent against the
fake GitHub and the fake LLM (a repository `.pr_agent.toml` takes effect, cannot redirect the LLM) belong
to the engine suite.
