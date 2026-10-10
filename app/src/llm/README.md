# Shared LLM access

One LLM account serves the whole instance. It is configured with environment variables
(`app/.env.example`); the app hands the key to the runner with every job. A key per project or per
user comes later.

| Variable         | Meaning                                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER`   | Required. `openrouter` (the only provider for now). Not case sensitive.                                                                                                                  |
| `LLM_API_KEY`    | Required. Surrounding whitespace and a trailing line break are ignored; whitespace inside, control characters or over 4096 characters make it invalid.                                   |
| `LLM_MODEL`      | Optional. The model reviews use unless the review settings choose another. Default `deepseek/deepseek-v3.2` (`DEFAULT_LLM_MODEL`; the model comparison ticket recommends the final one). |
| `LLM_MAX_TOKENS` | Optional. The context window of a model PR-Agent does not know (1000 to 10000000). Unset lets PR-Agent decide.                                                                           |

The limits are the ones the runner enforces on `llm.*` of a job (`runner/README.md`), so a value the
runner would refuse shows up as a configuration error instead of as a failed job.

| File         | Role                                                                                                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`  | `loadLlmConfig(env)`: the only place that knows the variable names. Returns a state, never throws: `configured` with the config, or `misconfigured` with issues (`{ code, variable }`, codes in `LLM_CONFIG_ISSUE_CODES`). |
| `access.ts`  | `resolveLlmAccess(state)`: the access of one job, or `{ ok: false, errorCode: "llm_not_configured" }` for the claim. `revealLlmAccess` is the one way to get the key out. `maskSecretInText` masks a secret in a text.     |
| `status.ts`  | `describeLlmStatus(state)`: what the UI may show: provider and model, or the variable names and codes of what is wrong.                                                                                                    |
| `startup.ts` | `checkLlmConfigOnStart`: one `LLM_NOT_CONFIGURED` warning at start (variable names only). Never stops the start.                                                                                                           |
| `shared.ts`  | The running server: `getLlmAccess()` and `getLlmStatus()` read `process.env` on every call, never cached.                                                                                                                  |

## Rules

- **A misconfiguration is a state, not a crash.** The app starts, the settings page (UI ticket) shows
  "LLM not configured" with the variable names from `getLlmStatus()`, and a job fails when it is
  claimed (below).
- **The claim fails the job with `llm_not_configured`** and does not hand it to the runner. There is
  no retry loop: nothing a retry does can fix an environment variable. The claim calls
  `getLlmAccess()` once per claim; the value of the environment at that moment is used.
- **The key never leaves the process except in the claim response.** `apiKey` of `LlmConfig` and
  `LlmAccess` is not enumerable, so JSON, spreads, entries and console output leave it out; only
  `revealLlmAccess` hands it out, for the runner API's claim response. Issues, the status and the
  start-up warning carry variable names and codes only, never a value (a wrong value may be a secret
  pasted into the wrong variable). Nothing stores the key: it is not in the database, not in a job
  row, not in an error text. A text that comes back from a runner (`complete`) is run through
  `maskSecretInText(text, key)` before it is stored.
- **Model and token limit per project** are settings of the review settings ticket; they replace
  `model` and `maxTokens` of the access when a job is built. The provider and the key always come
  from here.

## Testing

`config.test.ts`, `access.test.ts`, `status.test.ts`, `startup.test.ts` and `shared.test.ts` (unit,
no database). The claim, the completion and the settings page that use these functions are tested
with their tickets (runner API, UI).
