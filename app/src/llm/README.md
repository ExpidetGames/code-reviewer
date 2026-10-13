# LLM access

Every workspace brings its own LLM key (bring your own key, BYOK; `docs/decisions/0001-editions-setup-and-accounts.md`,
sections 2.7 and 2.8). An Admin or an Owner enters it under **Settings → LLM access** of the workspace
(`/w/:workspace/settings/llm`); removing the key is a danger zone under **Settings → Advanced**. The app
hands the key of the job's own workspace to the runner with every job. The legacy `LLM_PROVIDER` and `LLM_API_KEY`
were imported once into the default workspace by the update of an existing installation (`src/legacy-import/`) and
are not read any more; `LLM_MODEL` and `LLM_MAX_TOKENS` are instance settings.

## Which key a job gets

`resolve.ts` (`resolveWorkspaceLlmAccess`, pure) decides, in the order of the decision record, the first that
applies wins:

1. **The workspace's own key.** Stored encrypted (below), bound to the provider it was entered for.
2. **The operator's key**, if the operator offers "included" usage. A stub that is **off**: the pricing phase fills
   it, the order and the data model leave room for it (`operator` is always `null` on the running server).
3. Otherwise the job fails with `llm_not_configured` and a reason (`no_key`, `key_unreadable`,
   `key_binding_mismatch`).

There is no step for a key in the environment: a key in `LLM_API_KEY` would be spent by every workspace that has not
brought its own. The instance that is updated gets its key into the default workspace by the import instead.

Two cases **fail closed** instead of falling through to the next step: a workspace key that exists but cannot be
read (another `APP_SECRET`, a changed row), and one that was entered for another provider than the one it would be
sent to. Using a different key would spend somebody else's money, and sending the key to another provider would hand
a credential to a party it was not entered for.

`assemble.ts` puts it together over a database (`createWorkspaceLlm`: the key service of a workspace, `accessFor`,
`summaryFor`, `currentKeysFor`); `shared.ts` wires it to the running server. The claim of the runner API calls
`accessFor(job.workspaceId)`, so a job never sees another workspace's key (`integration-tests/http/
runner-api-llm-key.integration.test.ts`).

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

## Rules

- **A missing key is a state, not a crash.** The app starts, the workspace pages show "LLM not configured" with a link to
  the form, and a job fails when it is claimed (below).
- **The claim fails the job with `llm_not_configured`** and does not hand it to the runner. There is no retry loop:
  nothing a retry does can fix a missing key. The key is looked up once per claim; one entered while the app runs
  is used by the next claim, and removing it does not touch a job that runs (the runner has its key already).
- **The key leaves the process only in the claim response** (and to the provider, in the test button).
  `apiKey` is not enumerable on `LlmConfig` and `LlmAccess`, so JSON, spreads and console output leave it out; only
  `revealLlmAccess` hands it out. Issues, statuses and warnings carry names and codes only, never a value.
- **The key of a claim is remembered, encrypted, in the database** (`job_claimed_keys`, `src/runner-api/
claimed-keys.ts`) and not in memory, so any app instance can mask a result after the key was rotated (section 2.10). The
  row goes with its job, and the cleanup removes the rows of jobs that finished a week ago.
- **Masking is best effort.** A text that comes back from a runner (`complete`) is run through
  `maskSecretInText(text, ...keys)` before it is stored. It masks the plain, percent-encoded, JSON-escaped and
  base64 form; a secret that was cut or transformed in another way is not found. Mask with the key that was handed
  out with the claim of that job _and_ the current key of its workspace.
- **Model and token budget per project** are review settings (`src/review-settings`); they replace the model and the
  context window of the access when a job is built. The provider and the key always come from here.

## Testing

`resolve.test.ts`, `config.test.ts`, `access.test.ts`, `startup.test.ts`, `endpoint.test.ts` and
`../instrumentation.test.ts` (unit, no database); `workspace-key.integration.test.ts`,
`key-test.integration.test.ts` (real SQLite, the fake LLM over real HTTP); `ui/*.test.tsx`;
`integration-tests/http/llm-key-route.integration.test.ts` (the real route files: roles, isolation, the request,
the test button, no key in any answer or log), `integration-tests/http/runner-api-llm-key.integration.test.ts` (the
claim: each workspace's own key, no borrowing, no key from the environment, removal, masking across instances) and the
rows for the routes in `workspace-isolation.integration.test.ts`. Journey: `e2e/settings/llm-key.e2e.ts`, and the
review with the workspace key in `e2e/jobs/pull-request-to-review.e2e.ts`.
