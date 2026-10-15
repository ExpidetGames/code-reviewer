# LLM access

A workspace brings its own LLM key (bring your own key, BYOK; `docs/decisions/0001-editions-setup-and-accounts.md`,
sections 2.7 and 2.8), or, where an operator has set its key mode to `managed`, uses the operator's own key (below). An Admin or an Owner enters it under **Settings → LLM access** of the workspace
(`/w/:workspace/settings/llm`); removing the key is a danger zone under **Settings → Advanced**. The app
hands the key of the job's own workspace to the runner with every job. The legacy `LLM_PROVIDER` and `LLM_API_KEY`
were imported once into the default workspace by the update of an existing installation (`src/legacy-import/`) and
are not read any more; `LLM_MODEL` and `LLM_MAX_TOKENS` are instance settings.

## Which key a job gets

`resolve.ts` (`resolveWorkspaceLlmAccess`, pure) decides by **the key mode of the workspace's effective entitlements**
(`src/workspaces/README.md`, "Entitlements"; `keyModeForJob`), and by nothing else:

1. **`own`, or no entitlements at all** (an instance that never configured any, which is every self-hoster): the
   workspace's own key, stored encrypted (below), bound to the provider it was entered for. **The operator's key is
   never read** for such a workspace, not even when it has no key of its own: the job then fails with `no_key`.
2. **`managed`**: the operator's own key (#276, below), source `operator`. The workspace's own stored key is ignored
   (it stays stored, not deleted) and is **never a fallback**: the entitlement says which key is used. Without a
   readable operator key the job fails with `llm_not_configured` and the reason `operator_key_missing` or
   `operator_key_unreadable`.
3. **Entitlements that cannot be read** (`entitlements_invalid`): it is not known whose key applies, so the job fails
   with `llm_not_configured` and the reason `entitlements_invalid`; nothing is chosen. (The claim has refused such a
   job already, #277; this covers the Worker's fetch, which checks again.)

The reasons of `llm_not_configured` (`LLM_NOT_CONFIGURED_REASONS`): `no_key`, `key_unreadable`,
`key_binding_mismatch`, `operator_key_missing`, `operator_key_unreadable`, `entitlements_invalid`. They are logged
with the job and drive the copy of the pages; they never hold a value.

The input of the resolver is a union on purpose (`keyMode: "own"` carries the workspace's key, `"managed"` carries the
operator's, `"unreadable"` carries neither), so a job of a workspace that is not managed has no place to put the
operator's key and a managed one has none for the workspace's. `assemble.ts` reads only what the mode names.

There is no step for a key in the environment: a key in `LLM_API_KEY` would be spent by every workspace that has not
brought its own. The instance that is updated gets its key into the default workspace by the import instead.

Failures **fail closed** instead of falling through to another key: a workspace key that exists but cannot be read
(another `APP_SECRET`, a changed row), one that was entered for another provider than the one it would be sent to, an
operator key that is missing or cannot be read. Using a different key would spend somebody else's money, and sending
the key to another provider would hand a credential to a party it was not entered for.

`assemble.ts` puts it together over a database (`createWorkspaceLlm`: the key service of a workspace, the operator's
key service, `accessFor`, `summaryFor`, `currentKeysFor`); it reads the effective entitlements with
`readEffectiveEntitlements` (`src/workspaces/effective-entitlements.ts`, the same function the claim's admission
uses). `shared.ts` wires it to the running server. The claim of the runner API calls `accessFor(job.workspaceId)`, so a
job never sees another workspace's key (`integration-tests/http/runner-api-llm-key.integration.test.ts`).

## The operator's own key (#276)

The instance admin stores **one key of the operator's own** for the workspaces whose key mode is `managed`, in the
admin portal (**LLM key**, `/admin/llm`; `src/admin/ui/operator-llm-key-form.tsx`). The provider is OpenRouter.

| File              | Role                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operator-key.ts` | `createOperatorLlmKeyService`: `status`, `save`, `remove`, `forJob`, on the encrypted store of the instance (`src/secrets/`, name `operator_llm_key`) |

- **Storage.** Table `secrets`, AES-256-GCM with a key derived from `APP_SECRET`, additional authenticated data the
  table and the name. Like the workspace key, **whoever holds the database and `APP_SECRET` can decrypt it**; the form
  says so.
- **Write-only.** No answer holds the key. The portal's settings carry the status (`configured`, `unreadable`,
  `not_configured`) and the last four characters of a long key (`GET|PUT /api/admin/settings`, `secrets` and
  `operatorLlmKey`); an empty field saves nothing (`api_key_required`) and the rules for a key are those of the
  workspace key (`checkLlmApiKey`).
- **Only the instance admin writes it.** It is **not a setting of the operator API** (`src/operator-api/`): whoever holds
  that token must not hold the key, and the API has no dependency that could reach the store. Entitlements that name a
  key are refused as unknown fields.
- **The key never reaches** a workspace member, the browser, a log line, a Runs page, a stored result or the
  Dispatcher. It leaves the process on two paths only, and on both it is remembered encrypted in `job_claimed_keys`
  before it leaves, so `maskSecretInText` masks it in the result whichever app instance serves it and after a rotation:
  1. **The legacy claim**: the claim response carries it to the runner, like the workspace key (`claim.ts`).
  2. **The Worker API** (#320): the claim of a Dispatcher carries no key; the **first fetch** of the job with the
     per-job credential mints and reveals it (`buildJobInput`, after `checkJob` resolved the access again). A key
     that was removed or rotated between the claim and the fetch is the one the fetch uses; one that is gone ends the
     job with `llm_not_configured`.
- **The model is the instance's.** While a job runs on the operator's key, the operator chooses the model, never the
  tenant: the review settings' `model`, `maxTokens` and Dynamic model are **not used** (the instance's `LLM_MODEL` and
  `LLM_MAX_TOKENS` are, for Diff and for Dynamic, in the job, in the Dynamic options and in the capabilities read),
  on both delivery paths (`withInstanceModel` in `runner-api/claim.ts`). The settings stay stored and take effect
  again if the workspace goes back to its own key. The settings pages replace the model fields with a note
  (`instanceChoosesModel`). Managed tiers (#280, #283) will replace this.
- **The Worker's fetch asks for the standing again.** A workspace suspended after the claim, or whose entitlements
  became unreadable, gets no key: the job ends with the code of the claim (`runner-api/README.md`). Quotas are not
  counted again.
- **Upgrade every app instance before setting any workspace to `managed`.** An instance of the previous release does
  not know the key mode: it would run a managed workspace's jobs on the workspace's own key and on the workspace's
  model, record them as `own` (outside the cost limit), and not read the list of remembered keys of a job as keys. Nothing leaks, but the
  operator's rules are not applied until every instance is upgraded.
- **Masking.** `currentKeysFor` returns the workspace's own key and, **while the workspace is managed**, the operator's
  current key; the key of the claim comes from `job_claimed_keys`.
- **The usage record says the key that was used.** The claim reserves the record as `own` and `recordKeyMode` sets it
  from the source of the resolved access (`managed` for `operator`), on both paths. The cost limit of #277 watches the
  records whose key mode is `managed` for a workspace whose entitlements say `managed`; since the key mode of the
  entitlements is also what picks the key, the two cannot disagree except in the moment an operator changes the mode
  between the claim's admission and the key lookup, and then the record follows the key that is actually used.
- **The workspace pages.** For a workspace whose key mode is managed (`instanceAccessOf` in `access.ts`), **Settings →
  LLM access** shows no key form to anybody and says that access is provided by this instance (a Member sees the same
  note); when the operator has no usable key it says so and tells the person to contact the administrator of the
  instance. The "LLM not configured" hint of the other pages becomes "LLM access is not available" without a link to a
  form. The routes that save, test and remove a workspace key keep working: the key is only not used while managed.

## The key of a workspace

| File               | Role                                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace-key.ts` | `createWorkspaceLlmKeyService`: `status`, `save`, `remove`, `reveal`, `forJob`, on the encrypted store of the workspace (`src/secrets/workspace-store.ts`)                                                                                                          |
| `http.ts`          | The handlers of `GET\|PUT\|DELETE /api/w/:workspace/llm-key` and `POST /api/w/:workspace/llm-key/test` (the route files are below `src/app/api/w/[workspace]/llm-key/`)                                                                                             |
| `key-test.ts`      | The "Test key" button: one call to the provider (`GET /key` of OpenRouter, which costs nothing), the failure classes, the limits                                                                                                                                    |
| `endpoint.ts`      | The provider's API address. Not configurable by a person; the test stack points it at the fake LLM with `LLM_API_BASE_URL` together with `ALLOW_TEST_LLM_ENDPOINTS=true`, which anything else ignores                                                               |
| `ui/`              | The settings section (`LlmAccessSection`, form), the hint "LLM not configured": `llmAccessAttention` builds it as an `AttentionNotice` so a page can merge it into its one "Needs attention" strip, `LlmAccessNotice` renders it on its own; the copy for the codes |

- **Storage.** Table `workspace_secrets`, AES-256-GCM with a key derived from `APP_SECRET`; the additional
  authenticated data is the table, the **workspace id** and the name `llm_api_key`, so a row copied to another
  workspace does not decrypt. **The operator can decrypt it by design** (the operator holds the database and
  `APP_SECRET`); the settings page says so, and the hosted terms must. This reverses the old guarantee that the
  key is "never stored": a workspace key is persisted, encrypted.
- **Write-only.** No answer holds the key. An Admin or an Owner sees whether it is configured, cannot be read, or
  is missing, and the last four characters of a long key; a **Member sees only whether one exists**. An empty field
  keeps the stored key.
- **Not carried to another provider.** The key is bound to its provider (`binding`). Changing the provider with an
  empty field is refused (`api_key_required_for_new_provider`): a stored key is never sent to a provider or an
  endpoint other than the one it was entered for (the lesson of the SMTP password of #100). The bound provider is
  checked again when the key is used.
- **Who.** `manage_llm_key` (Admin and Owner) sets, tests and removes it; every member reads the state.
- **The rules for a key** are the legacy variable's (`checkLlmApiKey`): surrounding whitespace is ignored,
  whitespace or control characters inside and more than 4096 characters are refused (`api_key_invalid`).
- **Test key.** A key typed into the field is checked as it is and forgotten; with an empty field the stored one is
  checked. The address is the provider's own, redirects are not followed, the time is limited, and the provider's
  words only appear as a cleaned first line (the key removed in every spelling, long opaque tokens blanked). Limited
  per workspace (5 per 10 minutes) and for the instance (60), in `rate_limits`; counters that cannot be read refuse
  the click. **The instance budget is shared**: the workspaces of one person (a multi-tenant instance lets anybody
  create several, 10 by default) can use it up, and the button is then refused for everybody for a while. Nothing
  else is affected. The server also logs `LLM_TEST_ENDPOINTS_ENABLED` at start when the test stack's address switch is
  on. Failure classes: `llm_key_rejected`, `llm_unreachable`, `llm_provider_error`.
- **The model** is not set here. It is the `model` review setting (`src/review-settings`), whose built-in value is
  the instance's `LLM_MODEL` (default `anthropic/claude-haiku-5.5`; a wrong name is ignored with a warning and the
  default is used). **That built-in model name is visible to every member** in the model setting of the review
  defaults, as intended: a model name is no secret (decided with #144).

## The variables

`LLM_PROVIDER` and `LLM_API_KEY` are **legacy**: the update of an existing installation reads them once
(`src/legacy-import/environment.ts`, through `checkLlmApiKey` and the same provider list) and saves the key as the default
workspace's key, bound to the provider; a new instance ignores them, and nothing reads them afterwards. `LLM_MODEL` and
`LLM_MAX_TOKENS` configure the built-in model and the context window of the instance; the import also copies a
`LLM_MODEL` that differs from the default into the review defaults of the default workspace (unless the team chose a
model), so the model survives the removal of the variable.

| Variable         | Meaning                                                                                                                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER`   | `openrouter` (the only provider for now). Not case sensitive.                                                                                                                                                                                         |
| `LLM_API_KEY`    | Surrounding whitespace and a trailing line break are ignored; whitespace inside, control characters or over 4096 characters make it invalid.                                                                                                          |
| `LLM_MODEL`      | The OpenRouter name of the model reviews use unless the review settings choose another, without an `openrouter/` prefix (the runner adds it). Default `anthropic/claude-haiku-5.5` (`DEFAULT_LLM_MODEL`, the recommendation of the model comparison). |
| `LLM_MAX_TOKENS` | The context window of a model PR-Agent does not know (1000 to 10000000); `contextWindowTokens` in the code. Unset lets PR-Agent decide. It is **not** the token budget of a review: that is a review setting and replaces this value in a job.        |

The limits are the ones the runner enforces on `llm.*` of a job (`runner/README.md`, `job.py`), so a value the
runner would refuse shows up as a configuration error or warning instead of as a failed job. They are copied by
hand; a contract test belongs to the runner API contracts (CR-28).

**A wrong optional variable** (`LLM_MODEL` that is
no model name, `LLM_MAX_TOKENS` that is no number in range) does not stop the reviews: it is ignored, the default is
used, and it is reported as a _warning_ (`LLM_MODEL_INVALID`, `LLM_MAX_TOKENS_INVALID`).

| File         | Role                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`  | `readLlmDefaults(env)`: the built-in model (`LLM_MODEL`) and the context window (`LLM_MAX_TOKENS`), a wrong one ignored with a warning; `configuredLlmModel`; `checkLlmApiKey` (the one rule for a key, shared with the key routes and the legacy import). The legacy `LLM_PROVIDER` / `LLM_API_KEY` are not read here (src/legacy-import/ imports them once). |
| `access.ts`  | `LlmAccessResult` (with its `source` or its `reason`), `revealLlmAccess` (the one way to get the key out, `LLM_ACCESS_HAS_NO_KEY` without a key), `maskSecretInText` (masks secrets in a text).                                                                                                                                                                |
| `status.ts`  | `LlmStatus`: what the UI may know about the instance's LLM defaults (the built-in model and the warnings about an ignored option). The key is a matter of each workspace.                                                                                                                                                                                      |
| `startup.ts` | `checkLlmConfigOnStart`: one warning for an optional variable that is ignored (`LLM_MODEL`, `LLM_MAX_TOKENS`) and the notes on the test endpoints. Says nothing about `LLM_PROVIDER` and `LLM_API_KEY`. Never stops the start.                                                                                                                                 |

## Model capabilities

`model-capabilities.ts` asks the provider's public model metadata whether a model can do what Dynamic Review
needs (#269): `GET /api/v1/models/{author}/{slug}/endpoints` of OpenRouter, no key. `checkModelCapabilities`
answers one of

- `supported`: at least one endpoint lists both `tools` and `tool_choice` in `supported_parameters` and does not
  say it cannot force a tool choice (`supports_tool_choice.required` is not `false`, #279);
- `unsupported`: the model exists, no endpoint qualifies;
- `unknown_model`: 404, or a name that is not `author/slug` (no request is made then); a variant suffix such as
  `:free` is dropped for the lookup;
- `unverifiable`: a network error, a timeout, any status but 200 and 404 (a redirect included), an answer that is
  not JSON, over 256 KiB or not shaped like the documented answer. It never throws.

`supported` and `unsupported` carry the capabilities read: `tools`, `toolChoice`, `toolChoiceRequired`,
`responseFormat`, `structuredOutputs`, `maxCompletionTokens` (the largest limit an endpoint states, or null) and,
for the descriptor of a Dynamic job (#279), `smallestCompletionTokens`, `contextLength` (the smallest window,
null if an endpoint states none) and `inputUsdPerMtok` / `outputUsdPerMtok` (the highest prices of the endpoints a
run could use, as exact decimal text per million tokens, moved from OpenRouter's per-token text without a float;
both null when any is missing or not a plain decimal). They come from the endpoints that qualify when there are
any, otherwise from all of them, and always at the bound a reservation needs.

`dynamic-capabilities.ts` (`dynamicCapabilitiesOf`) turns them into the `dynamic.capabilities` of a job
(`DynamicModelCapabilities` in `contracts/runner-api.v1.json`): structured output is tool calling (the pinned
engine returns its findings through a tool call), the output allowance is the smaller of the model's smallest
stated limit, 8,192 tokens and half the window, prices are left out when unreadable, and a model whose metadata
states no window yields no descriptor. Nothing is invented. The claim of a Dynamic job sends it (see
`src/runner-api/README.md`).

The request goes to the provider's fixed address (`endpoint.ts`; the test stack points it at the fake LLM with
the existing switch), sends no credential, follows no redirect, has a timeout and the size limit, and the fetch is
a parameter. **Outbound call:** the app asks `openrouter.ai` (HTTPS 443, no key) on every save of a Dynamic model and on every claim of a Dynamic job whose model is not in the cache (#279); a host that cannot reach it waits at most 5 seconds and gets the `DYNAMIC_MODEL_UNVERIFIED` warning (`docs/deployment-coolify.md`). The log line holds the model id and the outcome class only (`MODEL_CAPABILITY_CHECK`).
`createModelCapabilityChecker` remembers a `supported` answer in memory for five minutes (at most 200 models), so
saving the same model repeatedly asks once; no other outcome is remembered. The settings save is its first user
(`src/review-settings/README.md`, "Saving a Dynamic model checks it"); the run-time enforcement is the runner
proxy's (`dynamic_model_features_unsupported`).

## Rules

- **A missing key is a state, not a crash.** The app starts, the workspace pages show "LLM not configured" with a link to
  the form, and a job fails when it is claimed (below).
- **The claim fails the job with `llm_not_configured`** and does not hand it to the runner. There is no retry loop:
  nothing a retry does can fix a missing key. The key is looked up once per claim; one entered while the app runs
  is used by the next claim, and removing it does not touch a job that runs (the runner has its key already).
- **The key leaves the process only in the claim response** (and to the provider, in the test button).
  `apiKey` is not enumerable on `LlmConfig` and `LlmAccess`, so JSON, spreads and console output leave it out; only
  `revealLlmAccess` hands it out. Issues, statuses and warnings carry names and codes only, never a value.
- **The keys of a job are remembered, encrypted, in the database** (`job_claimed_keys`, `src/runner-api/
claimed-keys.ts`: one row per job, the sealed text is the list of the keys handed out for it, newest last, at most 3, a
  key already known takes no place; a row of the earlier format, one plain key, is still read) and not in memory, so any app instance can mask a result after the key was rotated (section 2.10). The
  row goes with its job, and the cleanup removes the rows of jobs that finished a week ago.
- **Masking is best effort.** A text that comes back from a runner (`complete`) is run through
  `maskSecretInText(text, ...keys)` before it is stored. It masks the plain, percent-encoded, JSON-escaped and
  base64 form; a secret that was cut or transformed in another way is not found. Mask with the key that was handed
  out with the claim of that job _and_ the current key of its workspace.
- **Model and token budget per project** are review settings (`src/review-settings`); they replace the model and the
  context window of the access when a job is built. The provider and the key always come from here.

## Testing

`resolve.test.ts`, `config.test.ts`, `access.test.ts`, `startup.test.ts`, `endpoint.test.ts`, `model-capabilities.test.ts`, `dynamic-capabilities.test.ts` and
`../instrumentation.test.ts` (unit, no database); `workspace-key.integration.test.ts`, `operator-key.integration.test.ts`,
`operator-access.integration.test.ts` (whose key a workspace gets, over a real database),
`key-test.integration.test.ts` (real SQLite, the fake LLM over real HTTP); `ui/*.test.tsx`;
`integration-tests/http/llm-key-route.integration.test.ts` (the real route files: roles, isolation, the request,
the test button, no key in any answer or log; and a managed workspace's settings: no form, the same note for every
role, the routes still working), `integration-tests/http/runner-api-llm-key.integration.test.ts` (the claim: each
workspace's own key, no borrowing, no key from the environment, removal, masking across instances),
`integration-tests/http/runner-api-operator-key.integration.test.ts` (the operator's key on the legacy claim and the
Worker API: delivered, remembered, masked, never to a Dispatcher, the usage record's key mode),
`src/admin/operator-llm-key.integration.test.ts` (the portal's save, status and refusals; who may not) and the rows for
the routes in `workspace-isolation.integration.test.ts`. Journey: `e2e/settings/llm-key.e2e.ts`, and the
review with the workspace key in `e2e/jobs/pull-request-to-review.e2e.ts`.
