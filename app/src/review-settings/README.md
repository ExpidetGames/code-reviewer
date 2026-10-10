# Review settings

What a review can be tuned by, with sensible built-in values, global defaults for the whole instance
and overrides per project. The settings end up in the runner job (`llm.model`, `llm.maxTokens`, `env`)
through one pure function.

## Layers

From weakest to strongest: **built-in values** (`settings.ts`, with the model from `LLM_MODEL`, see
`src/llm/README.md`), **global defaults** (`app_settings`, key `review_defaults`) and the **overrides of
one project** (`projects.settings`). A layer only holds the fields somebody changed, the rest is
inherited when the settings are read (`resolveReviewSettings` in `effective.ts`, which also says where
each field comes from). So a changed global default reaches every project that does not override the
field, and a built-in value that changes later (the default model, after the model comparison) reaches
everybody who did not choose one. Resetting a project (`DELETE`) removes its overrides.

A save **replaces the whole set** of its layer: a field left out is inherited again. Every person on the
allow list may change both layers (no admin role in the MVP); `app_settings.updated_by` records who saved
the global defaults last.

| Field               | Meaning                                                                      | Built-in value                             | Limits                                 |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------- |
| `model`             | The model (as the provider spells it, no prefix)                             | `LLM_MODEL`, else `deepseek/deepseek-v3.2` | the pattern the runner accepts         |
| `fallbackModel`     | Tried when the model fails; `null` = none                                    | none                                       | same pattern                           |
| `extraInstructions` | Project rules for the model, free text                                       | none                                       | 4000 characters, no control characters |
| `maxFindings`       | The most findings one review lists                                           | 5                                          | 1 to 30                                |
| `maxTokens`         | Token budget of a review (`llm.maxTokens`)                                   | 100000 (PR-Agent's own: 32000)             | 8000 to 2000000                        |
| `largePrChunking`   | Review a large pull request in chunks instead of leaving files out           | on                                         | boolean                                |
| `inlineKeyIssues`   | Also post every finding as an inline comment                                 | off                                        | boolean                                |
| `autoReviewOnOpen`  | Review when a pull request is opened, reopened or marked ready               | on                                         | boolean                                |
| `autoReviewOnPush`  | Review again when commits are pushed                                         | on                                         | boolean                                |
| `allowedCommands`   | The comment commands people may use (`review`, `improve`, `describe`, `ask`) | all four                                   | any subset, no duplicates              |

The limits are `REVIEW_SETTING_LIMITS`; `validate.ts` checks every field and reports each problem as
`{ field, code }` with a stable code (`REVIEW_SETTING_ISSUE_CODES`), never with the value.
`parseStoredOverrides` reads what is stored and drops any field this version would not accept, so old or
hand-edited data cannot make a review fail.

## From settings to a runner job

`toRunnerSettings(settings)` (`runner-settings.ts`) returns `{ llm: { model, maxTokens }, env, fallbackModels }`:

| Setting              | Runner job                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`, `maxTokens` | `llm.model`, `llm.maxTokens` (the provider and the key come from the LLM configuration, `src/llm`)                                                                                      |
| `extraInstructions`  | `PR_REVIEWER__EXTRA_INSTRUCTIONS`, `PR_DESCRIPTION__...`, `PR_CODE_SUGGESTIONS__...`, `PR_QUESTIONS__...` (left out when empty)                                                         |
| `maxFindings`        | `PR_REVIEWER__NUM_MAX_FINDINGS`                                                                                                                                                         |
| `largePrChunking`    | `PR_REVIEWER__ENABLE_LARGE_PR_CHUNKING=true` (left out when off: PR-Agent's own value is off)                                                                                           |
| `inlineKeyIssues`    | `PR_REVIEWER__INLINE_KEY_ISSUES=true` (left out when off: PR-Agent's own value is off)                                                                                                  |
| `fallbackModel`      | `fallbackModels` (**not part of the job yet**: the runner pins an empty fallback list; add a field to the contract first)                                                               |
| triggers, commands   | nothing: the app is the only trigger. The webhook intake asks `isAutomaticReviewEnabled(settings, "opened" or "updated")` and the comment handler `isCommandAllowed(settings, command)` |

The result holds only `PR_*` variables the runner lets through (`RUNNER_ENV_KEY_PATTERN` is the runner's
own allowlist) and the two `llm` fields. It never receives the LLM key or a Git token, so it cannot
contain them. The names are PR-Agent 0.47.0's: `runner-settings.test.ts` reads
`fixtures/pr-agent-0.47.0-configuration.excerpt.toml` (verbatim lines of that release's
`configuration.toml`) and checks that every variable exists there with the kind of value we send, and
that the switches we leave out when off really are off by default. **When PR-Agent is upgraded**, copy
the same lines from the new release's file into the fixture (the header of the file says which) and fix
what the test reports.

### Things to know

- **Free text is interpreted by PR-Agent's settings loader.** PR-Agent reads its environment through
  Dynaconf. Measured against PR-Agent 0.47.0 / Dynaconf 3.3.5: a value that starts with
  `@format {env[OPENROUTER__KEY]}` or `@jinja ...` is **evaluated** against the process environment (the
  LLM key and the GitHub token are in it) and the result goes into the prompt; other `@` converters change
  the type or abort the run; a text that is only a number, a date, a quoted string, a list or `true`,
  `false`, `inf`, `nan` becomes that value instead of text. `protectFromSettingsParser` puts one line
  break in front of a text that starts with anything but a letter (or is only one of those words); any
  other text is passed on exactly as it is. A runner test with the real PR-Agent should pin the same
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
- `LLM_MAX_TOKENS` (`src/llm`) is not used here: the budget is a review setting now.

## Cost guard

`estimateReviewCost(settings)` (`cost.ts`) answers what a typical review is expected to cost with the
model (and the fallback model), and sets `warn` when either is above **0.10 USD**, the customer's limit.
It never blocks a setting; the UI shows the warning. The price per model is a small static table
(`model-pricing.ts`, USD per million tokens from OpenRouter's model list, with the day it was read);
the model comparison ticket keeps it up to date. A review is assumed to send 30000 tokens (never more
than the budget) and get 3000 back, one call; that reproduces the cost measured in the model comparison
for gemini-3.8-flash (0.034 estimated, 0.035 measured), and is conservative for deepseek-v3.2 (0.010,
0.007 measured). A model that is not in the table is `unknown_model` and does not warn. Chunked reviews of
very large pull requests (up to three calls) are not counted.

## Routes

Both are protected by the proxy (401/403) and by `requireUser()` (called first). A change must come from
this site (`Sec-Fetch-Site`/`Origin`), be `application/json` and at most 64 KB.

| Route                                                     | Does                                                                                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /api/review-settings`                                | the global defaults: `overrides`, `effective`, `sources`, `builtIn`, `cost`, `limits`, `updatedAt`, `updatedBy` |
| `PUT /api/review-settings`                                | body `{ "settings": { ... } }`, replaces the global defaults                                                    |
| `GET /api/repositories/:repositoryId/project/settings`    | the project's `overrides`, `effective`, `sources`, `inherited`, `cost`, `limits`                                |
| `PUT /api/repositories/:repositoryId/project/settings`    | body `{ "settings": { ... } }`, replaces the project's overrides                                                |
| `DELETE /api/repositories/:repositoryId/project/settings` | removes the project's overrides                                                                                 |

Refusals are `{ "error": <code> }` (`errors.ts`): `400 REVIEW_SETTINGS_INVALID` (plus
`"issues": [{ "field", "code" }]`), `400 REVIEW_SETTINGS_REQUEST_INVALID` (not JSON, or no `settings`
object), `403 REVIEW_SETTINGS_CROSS_SITE_REQUEST`, `413 REVIEW_SETTINGS_BODY_TOO_LARGE`,
`415 REVIEW_SETTINGS_CONTENT_TYPE_UNSUPPORTED`, `404 REVIEW_SETTINGS_PROJECT_NOT_FOUND` (the repository has
no project: it was never activated). The settings page (CR-34) calls these routes, or a Server Function
that calls the service and starts with `requireUser()`.

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
