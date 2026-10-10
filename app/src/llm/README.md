# Shared LLM access

One LLM account serves the whole instance. It is configured with environment variables
(`app/.env.example`); the app hands the key to the runner with every job. A key per project or per
user comes later.

| Variable         | Meaning                                                                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER`   | Required. `openrouter` (the only provider for now). Not case sensitive.                                                                                                                                                                                         |
| `LLM_API_KEY`    | Required. Surrounding whitespace and a trailing line break are ignored; whitespace inside, control characters or over 4096 characters make it invalid.                                                                                                          |
| `LLM_MODEL`      | Optional. The OpenRouter name of the model reviews use unless the review settings choose another, without an `openrouter/` prefix (the runner adds it). Default `anthropic/claude-haiku-5.5` (`DEFAULT_LLM_MODEL`, the recommendation of the model comparison). |
| `LLM_MAX_TOKENS` | Optional. The context window of a model PR-Agent does not know (1000 to 10000000); `contextWindowTokens` in the code. Unset lets PR-Agent decide. It is **not** the token budget of a review: that is a review setting and replaces this value in a job.        |

The limits are the ones the runner enforces on `llm.*` of a job (`runner/README.md`, `job.py`), so a
value the runner would refuse shows up as a configuration error or warning instead of as a failed job.
They are copied by hand; a contract test belongs to the runner API contracts (CR-28).

Only the provider and the key can break the configuration. **A wrong optional variable** (`LLM_MODEL`
that is no model name, `LLM_MAX_TOKENS` that is no number in range) does not stop the reviews: it is
ignored, the default is used, and it is reported as a _warning_ (`LLM_MODEL_INVALID`,
`LLM_MAX_TOKENS_INVALID`) next to a working configuration.

| File         | Role                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config.ts`  | `loadLlmConfig(env)`: the only place that knows the variable names. Returns a state, never throws: `configured` (with the config and the `warnings`) or `misconfigured` (with `issues` for the provider and the key, codes in `LLM_CONFIG_ISSUE_CODES`).                       |
| `access.ts`  | `resolveLlmAccess(state)`: the access of one job, or `{ ok: false, errorCode: "llm_not_configured" }` for the claim. `revealLlmAccess` is the one way to get the key out (`LlmAccessError` `LLM_ACCESS_HAS_NO_KEY` without a key). `maskSecretInText` masks secrets in a text. |
| `status.ts`  | `describeLlmStatus(state)`: what the UI may show: provider and model, or the variable names and codes of what is wrong, plus the warnings.                                                                                                                                     |
| `startup.ts` | `checkLlmConfigOnStart`: one `LLM_NOT_CONFIGURED` warning at start (variable names only), and one `LLM_OPTIONS_IGNORED` warning for a wrong optional variable. Never stops the start. `src/instrumentation.test.ts` pins that the start calls it.                              |
| `shared.ts`  | The running server: `getLlmAccess()` and `getLlmStatus()` read `process.env` on every call, never cached.                                                                                                                                                                      |

## Rules

- **A misconfiguration is a state, not a crash.** The app starts, the settings page (UI ticket) shows
  "LLM not configured" with the variable names from `getLlmStatus()`, and a job fails when it is
  claimed (below).
- **The claim fails the job with `llm_not_configured`** and does not hand it to the runner. There is
  no retry loop: nothing a retry does can fix an environment variable. The claim calls
  `getLlmAccess()` once per claim; the value of the environment at that moment is used.
- **The key never leaves the process except in the claim response.** `apiKey` is not enumerable on
  `LlmConfig` and `LlmAccess` (the same type), so JSON, spreads, entries and console output leave it
  out; only `revealLlmAccess` hands it out, for the runner API's claim response. Issues, the status and
  the start-up warnings carry variable names and codes only, never a value (a wrong value may be a
  secret pasted into the wrong variable). Nothing stores the key: it is not in the database, not in a
  job row.
- **Masking is best effort.** A text that comes back from a runner (`complete`) is run through
  `maskSecretInText(text, ...keys)` before it is stored. It masks the plain, percent-encoded,
  JSON-escaped and base64 form; a secret that was cut or transformed in another way is not found.
  The environment is read on every call, so the key may have been **rotated while a job ran**: mask
  with the key that was handed out with the claim of that job _and_ the current one.
- **Model and token budget per project** are review settings (`src/review-settings`); they replace the
  model and the context window of the access when a job is built. The provider and the key always
  come from here.

## Testing

`config.test.ts`, `access.test.ts`, `status.test.ts`, `startup.test.ts`, `shared.test.ts` and `../instrumentation.test.ts` (unit,
no database). The claim, the completion and the settings page that use these functions are tested
with their tickets (runner API, UI).
