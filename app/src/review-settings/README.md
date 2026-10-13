# Review settings

What a review can be tuned by, with sensible built-in values, global defaults for the whole workspace
and overrides per project. The settings end up in the runner job (`llm.model`, `llm.maxTokens`, `env`)
through one pure function.

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

| Field               | Meaning                                                                                                                | Built-in value                                 | Limits                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| `model`             | The model (as the provider spells it, no prefix); the key is not a review setting but the workspace's own (`src/llm/`) | `LLM_MODEL`, else `anthropic/claude-haiku-5.5` | the pattern the runner accepts                                   |
| `fallbackModel`     | Tried when the model fails; `null` = none                                                                              | none                                           | same pattern                                                     |
| `extraInstructions` | Project rules for the model, free text                                                                                 | none                                           | 4000 characters, no control characters                           |
| `maxFindings`       | The most findings one review lists                                                                                     | 5                                              | 1 to 30                                                          |
| `maxTokens`         | Token budget of a review (`llm.maxTokens`)                                                                             | 100000 (PR-Agent's own: 32000)                 | 8000 to 2000000, not above the model's context window (if known) |
| `largePrChunking`   | Review a large pull request in chunks instead of leaving files out                                                     | on                                             | boolean                                                          |
| `inlineKeyIssues`   | Also post every finding as an inline comment                                                                           | off                                            | boolean                                                          |
| `autoReviewOnOpen`  | Review when a pull request is opened, reopened or marked ready                                                         | on                                             | boolean                                                          |
| `autoReviewOnPush`  | Review again when commits are pushed                                                                                   | on                                             | boolean                                                          |
| `allowedCommands`   | The comment commands people may use (`review`; the removed commands became `[]` on upgrade)                            | `["review"]`                                   | a subset of `["review"]`, no duplicates                          |

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
not blamed on an unrelated save; `cost.exceedsContext` lists it for the UI.

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

The price per model is a small static table (`model-pricing.ts`, USD per million tokens from OpenRouter's
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

| Route                                                                  | Does                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /api/w/:workspace/review-settings`                                | the global defaults: `overrides`, `effective`, `sources`, `builtIn`, `cost`, `limits`, `updatedAt`, `updatedBy` |
| `PUT /api/w/:workspace/review-settings`                                | body `{ "settings": { ... } }`, replaces the global defaults                                                    |
| `GET /api/w/:workspace/repositories/:repositoryId/project/settings`    | the project's `overrides`, `effective`, `sources`, `inherited`, `cost`, `limits`                                |
| `PUT /api/w/:workspace/repositories/:repositoryId/project/settings`    | body `{ "settings": { ... } }`, replaces the project's overrides                                                |
| `DELETE /api/w/:workspace/repositories/:repositoryId/project/settings` | removes the project's overrides                                                                                 |

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

| Field          | Meaning                                                                               | Default                   |
| -------------- | ------------------------------------------------------------------------------------- | ------------------------- |
| `reviewKind`   | `diff` (the existing PR-Agent review) or `dynamic` (the read-only agent of the epic)  | `diff`                    |
| `dynamicModel` | The model a Dynamic review uses, as the configured provider spells it, kept literally | `deepseek-v4.1-flash`     |
| `reviewSkill`  | The project's review-skill override, or absent for the shipped default skill          | the shipped default skill |

`dynamicModel` is a **default, not an allow-list** (#194-T08): any identifier the provider serves is
kept as-is, with no provider rewrite and no routing field. How a configured model is resolved and
whether it can serve the engine's needs is #197's business, not a project setting. `reviewKind` is
independent of the Diff `model`, so each kind keeps its own model and skill across a switch.

**No SQL migration.** The fields are JSON inside `projects.settings`, and missing values read as Diff
Review, `deepseek-v4.1-flash` and the shipped skill (`resolveProjectDynamicSettings`,
`builtInProjectDynamicSettings`). An existing project therefore behaves exactly as before; a
legacy-data integration fixture pins this (`service.integration.test.ts`, #194-T06).

The skill is **untrusted data**: it is stored as text, bounded to `PROJECT_DYNAMIC_LIMITS.reviewSkillMaxBytes`
(16 KiB of UTF-8, so multibyte characters count as their bytes), refused with a stable code on
forbidden control characters or an unpaired surrogate, and never interpreted. An empty or null value is
an explicit reset to the shipped default, never another project's skill. A `deepseek-v4.1-flash`-like
provider/model slug, a URL, a permission or a credential is not part of these settings.

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
`reviewSkill` of `""`/`null` clears only that override.

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
one; the skill is reset with `reviewSkill: null`, and a custom text equal to the shipped text is sent as
that reset, never as a copy. Taking every Diff override back is an **explicit empty request**. One
request cannot both clear the Diff group and carry project-only fields, so a save that does both sends
the empty reset first and the project-only fields second; if the second fails, the first stays saved and
the Review kind card says what was not saved (`adoptCards` takes the saved cards from the answer and
keeps the typed values of the others). Global defaults still use `buildPatch` (`ui/form-state.ts`).

`getProjectSettings` / `resolveForRepository` expose the `dynamic` view: the effective kind, model and
skill, where each comes from, the shipped defaults, whether the skill is the default, the default
skill's identity and the size limit.

## The pages

The workspace settings are sub-pages with a sub-nav (#178). `/w/:workspace/settings` is **General** (the
workspace name, the read-only instance, tenancy and member facts and the one "Needs attention" strip);
`/w/:workspace/settings/review-defaults` holds the form for the global defaults;
`/w/:workspace/settings/llm` holds the workspace key; `/w/:workspace/settings/advanced` holds the
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
`messages.ts` names a bad one) and the review skill (`ui/skill-editor.tsx`): the shipped skill is shown
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
(`jobs/dynamic-review-gate.ts`, default off until #202). The page reads it with `isDynamicReviewEnabled`
and the card says the truth: while it is off, the Dynamic option carries "Not enabled on this instance yet."
and choosing it shows that reviews of the project fail until an instance admin turns it on (the run ends
with `dynamic_review_disabled`, see `runs/error-copy.ts`). The choice stays **available** so a project can
be prepared before the gate is turned on, like an inactive project can be configured before it is
activated; the card never claims it works. Static text, no live region.

The claim of the runner API and the webhook intake use `service.resolveForRepository(repositoryId)`
(`shared.ts`: `getReviewSettingsService()`), then `toRunnerSettings` and the checks above.

## Testing

`validate.test.ts`, `effective.test.ts`, `runner-settings.test.ts`, `cost.test.ts` (unit, pure),
`service.integration.test.ts` and `http.integration.test.ts` (real SQLite), the repositories' own tests in
`src/db/repositories/`, and in `integration-tests/http/` the proxy in front of the routes
(`review-settings-route.integration.test.ts`) and the real route files
(`review-settings-route-file.integration.test.ts`). The test cases that need the real PR-Agent against the
fake GitHub and the fake LLM (a repository `.pr_agent.toml` takes effect, cannot redirect the LLM) belong
to the engine suite.
