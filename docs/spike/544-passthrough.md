# Spike #546: native OpenCode through a plain relay, four wire formats

Study: #544 (maintainer decisions of 2026-10-19). Ticket: #546. Pinned engine: OpenCode **v1.19.0**
(`runner/opencode-pin.json`, executable sha256 `135ac3f8…71fd`, checked before every run).

**Status: part 1 of 2.** Everything that can be proven without a provider key is proven here, against
the real pinned binary and fake providers. There was no real key for this spike, so what only a
real provider can show (its real usage shapes, its real errors, whether real models accept what the
engine sends) is the **live checklist in section 7**. The reusable parts are in the repository:
`fakes/wire/` (generic fakes per format, a strict upstream, a key swapping relay) and
`runner/tests/engine/test_engine_opencode_native.py` (every claim below as an engine test).

## 1. How this was measured

```
OpenCode (pinned binary, closed environment of config.engine_environment, default-deny permissions)
   │  provider.<id> { npm, options.baseURL = relay, options.apiKey = DUMMY }, models.<m> = the entry
   ▼
fakes/wire/relay.py       checks the dummy under the header of the family, swaps in the real key,
   │                      relays the bytes unchanged, keeps a copy of request and answer
   ▼
fakes/wire/upstream.py    strict fake of the provider: only the real key, one path, one model
```

- A six step tool loop (`glob`, `read`, `grep`, `read`, `glob`, `grep`, then a text answer) per
  family, on a provider id and a model id that exist nowhere (`acme-chat/acme-chat-9`, …).
- The turn has no `format`: the engine runs its ordinary loop and ends in text (decision 4 of #544).
- `OPENCODE_DISABLE_MODELS_FETCH=true`, `OPENCODE_PURE=true`, no `OPENCODE_MODELS_PATH` (except in
  the one fallback test), `enabled_providers` limited to the one provider.
- The shapes of the fakes follow the providers' documented formats and what the bundled AI SDKs
  parse. **They are not captured from real providers.**

## 2. Answers

| # | Question | Answer |
|---|---|---|
| 1 | Does the pinned OpenCode resolve a model that is not in its snapshot from the per-job config entry alone, with fetch disabled and no `OPENCODE_MODELS_PATH`? | **Yes, for all four families**, for a provider the snapshot lacks (`npm` + `options.baseURL` + `models.<m>`) and for a model the snapshot lacks under a provider it has (`anthropic`, `openai`, `google`, `deepseek`: no `npm` needed). The fallback `OPENCODE_MODELS_PATH` is **not needed**; it works too, with a smallest valid file recorded below. |
| 2 | What does it send through a pure relay? | One **streaming** POST per step, to one path per family, key in one header. It never sends a non-stream call and never calls `GET /models`. Details in section 4. |
| 3 | Does its own prompt caching (`applyCaching`) arrive unchanged through a pure relay? | **Yes, byte for byte** (sha256 of every request body equal on both sides of the relay, all four families). Whether marks exist is decided by the engine from the SDK and the model id, see section 5. |

Verdict per family (everything below has an engine test):

| Family | SDK in the pin | Through a plain relay | Needs |
|---|---|---|---|
| OpenAI Chat / compatible | `@ai-sdk/openai-compatible` | works | auth swap on `authorization` |
| OpenAI Responses | `@ai-sdk/openai` | works | auth swap on `authorization`; `npm` must be named (a new provider without it speaks Chat) |
| Anthropic Messages | `@ai-sdk/anthropic` | works | auth swap on `x-api-key`; pass `anthropic-version` and `anthropic-beta` through untouched |
| Google | `@ai-sdk/google` | works | auth swap on `x-goog-api-key`; the model and the stream are in the path |

## 3. Model resolution (question 1)

### The entry that works

```json
{
  "provider": {
    "acme-claude": {
      "npm": "@ai-sdk/anthropic",
      "options": { "baseURL": "http://127.0.0.1:<relay>/v1", "apiKey": "<dummy capability>" },
      "models": {
        "acme-claude-9": {
          "name": "Spike model",
          "limit": { "context": 200000, "output": 8192 },
          "tool_call": true,
          "reasoning": false,
          "temperature": true
        }
      }
    }
  },
  "enabled_providers": ["acme-claude"]
}
```

`GET /config/providers` shows the engine's view of it: `status: active`, the limits, `toolcall`,
`api.npm`, `cost` and, for a model with `reasoning: true`, the derived `variants`. That endpoint is
the cheap way for #548 to test an entry without a model call.

### Which fields are needed (tested one at a time, chat family)

| Entry | Result |
|---|---|
| `{}` (what the Dynamic config uses today) | resolves; output cap falls back to **32000**; cost 0 |
| `{ "name": … }` only, or without `limit`, `tool_call`, `temperature`, `reasoning` | resolves, same defaults |
| `limit` with only `context` **or** only `output` | **refused by the config validator** (`ConfigInvalidError`, `Missing key`): state both or neither |
| `tool_call: false` | tools are still sent: **the engine does not gate on the flag**, the catalog filter of #548 must |
| `cost` missing | engine cost is **0, silently** (confirmed); the relay's tee still sees real tokens |
| `status: "deprecated"` or `"alpha"` | the model is **dropped**: `ProviderModelNotFoundError`, HTTP 500, no upstream call. `"beta"` and the default work |
| provider without `npm`, not in the snapshot | defaults to `@ai-sdk/openai-compatible`: Responses/Messages/Google entries silently speak Chat and fail on the key header. **Always write `npm`.** |
| provider in the snapshot (`anthropic`, `openai`, `google`, `deepseek`) | `npm` not needed; the snapshot's SDK is used |

Two surprises for #548:

- **Snapshot status wins over the entry.** `deepseek-v4-flash` is in the pinned snapshot (models.dev
  flags it `deprecated`), and an entry for it under `deepseek` is dropped; the same entry with
  `status: "beta"` runs. models.dev's `status` has to be
  mapped when the entry is generated (emit `beta`/omit the field for `deprecated`, or refuse the
  model), and a catalog model flagged `alpha`/`deprecated` needs a decision, not a silent drop.
- **The output cap is `min(limit.output, 32000)`.** `claude-sonnet-5-5` (limit 128000) is sent with
  `max_tokens: 32000`. An entry without `limit` gets 32000. The ledger's output reservation must use
  the cap the engine will send, not the catalog's `limit.output`.

### The snapshot

The pinned binary embeds a full models.dev snapshot (`anthropic` 20 models incl. `claude-sonnet-5-5`
and `claude-fable-5-1`, `openai` 80, `google` 38, `deepseek` 2). `opencode models` lists only
providers that have credentials or config, so an empty config shows 11 `opencode/*` models; a
provider is listed once it has `options.apiKey`. With a snapshot model, an **empty entry `{}`** keeps
the snapshot's prices and limits (`claude-sonnet-5-5`: input 2, output 10, limit.output 128000),
so an entry for a snapshot model need not repeat them.

### Fallback: `OPENCODE_MODELS_PATH` (not needed)

Works with config `{ "provider": { "<id>": { "options": { "baseURL", "apiKey" } } } }` and this file:

```json
{
  "acme-claude": {
    "id": "acme-claude",
    "name": "Spike",
    "npm": "@ai-sdk/anthropic",
    "env": [],
    "models": {
      "acme-claude-9": {
        "id": "acme-claude-9",
        "name": "Spike model",
        "tool_call": true,
        "limit": { "context": 200000, "output": 8192 }
      }
    }
  }
}
```

`limit` is mandatory in the file (without it the engine fails with a `TypeError` on
`limit.context`), `reasoning` is optional, `api` is not needed.

### Unknown model or provider (question 7)

A turn for a model or provider the config does not name fails **before any upstream call**:
`POST /session/{id}/message` answers **HTTP 500** with `{"name": "UnknownError", "data": {"message":
"Unexpected server error. Check server logs for details.", "ref": "err_…"}}`. The cause is only in the
engine log: `ProviderModelNotFoundError: Model not found: <provider>/<model>` (with "Did you mean"
for near names). #550 can map "500 `UnknownError` and zero upstream
calls for the turn" to one stable code; the text must not be shown (it names the model).

## 4. What the engine sends (questions 2, T08, T09)

Same for every call of every family (`user-agent: opencode/1.19.0 ai-sdk/provider-utils/<v>
runtime/bun/1.3.14`):

- **Always POST, always streaming, one call per step.** No GET (`/models` is never called), no
  non-stream call, no title or compaction call **when the session has a title** (the adapter sets
  one; a session without a title makes one extra, tool-less, streamed call first).
- Headers besides the key (closed set, tested): `accept: */*`, `accept-encoding: gzip, deflate, br,
  zstd`, `connection`, `content-length`, `content-type: application/json`, `host`, `user-agent`,
  and three that carry the session id: `x-opencode-session-id`, `x-session-id`,
  `x-session-affinity`.

| Family | Request line | Key header | Extra headers | Stream | Output cap | Tool choice |
|---|---|---|---|---|---|---|
| chat | `POST /v1/chat/completions` | `authorization: Bearer` | | body `stream: true`, `stream_options.include_usage: true` | `max_tokens` | `tool_choice: "auto"` |
| responses | `POST /v1/responses` | `authorization: Bearer` | | body `stream: true` | `max_output_tokens` | `tool_choice: "auto"` |
| messages | `POST /v1/messages` | `x-api-key` | `anthropic-version: 2023-06-01`, `anthropic-beta: thinking-binding-controls-2026-08-01,structured-outputs-2025-11-13` | body `stream: true` | `max_tokens` | `tool_choice: {"type":"auto"}` |
| google | `POST /v1beta/models/<model>:streamGenerateContent?alt=sse` | `x-goog-api-key` | | **the method name** in the path | `generationConfig.maxOutputTokens` | `toolConfig.functionCallingConfig.mode: "AUTO"` |

Other body fields: Responses adds `store: false` and `prompt_cache_key` (the session id); Messages adds
`thinking: {"type":"adaptive","block_binding":{"prefix_mismatch_behavior":"drop_block"}}` **for any
model, `reasoning` or not**; Google adds `generationConfig.thinkingConfig: {includeThoughts: true,
thinkingLevel: "high"}` only when the entry says `reasoning: true`.

The Google model is in the path (`:streamGenerateContent` is the stream), so #550's allow-list must
pin `models/<the job's model>` and one of the two methods; Messages/Chat/Responses carry the model in
the body, which a pure passthrough does not look at (the upstream rejects another one).

**The relay must not forward `accept-encoding` as it is.** The engine offers gzip, br and zstd. A
provider may compress the answer for that (a test shows it), and a tee that reads the usage then holds
compressed bytes it cannot parse. `fakes/wire/relay.py` sends `accept-encoding: identity` upstream;
#550 must do the same or decode before it parses.

## 5. Usage, and what the engine does with it (T02, T06)

Where the usage sits in the four formats is pinned by `runner/tests/unit/test_wire_formats.py`
(shapes from the providers' documentation; real ones are the live test):

| Family | Non-stream | SSE stream |
|---|---|---|
| chat | `usage.prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens` | last data chunk, `choices: []` (because of `include_usage`) |
| responses | `usage.input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens` | `response.completed` → `response.usage` |
| messages | `usage.input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens` | input and cache in `message_start`, cumulative `output_tokens` in `message_delta` |
| google | `usageMetadata.{promptTokenCount, candidatesTokenCount, cachedContentTokenCount, thoughtsTokenCount}` | `usageMetadata` on the last chunk only |

OpenCode **never uses non-stream**, so the non-stream column only matters for a provider that answers
a streaming request with a plain document, and for the title call if it ever changes.

How the engine itself counts the same upstream usage (first call: prompt 1010 of which 301 cached,
completion 21 of which 6 reasoning, cache write 51 + 8 for 1 h). It is not uniform, and it is not what
the ledger may use:

| Family | engine `input` | `output` | `reasoning` | `cache.read` | `cache.write` |
|---|---|---|---|---|---|
| chat, responses | 709 (prompt − cached) | 15 (completion − reasoning) | 6 | 301 | 0 |
| messages | 1010 | 21 | 0 | 301 | 59 (5 min + 1 h **summed**) |
| google | 709 | 21 (thoughts are separate) | 6 | 301 | 0 |

With a priced entry (`cost: {input: 3, output: 15}`) the engine's first call costs `0.002442`
= `(709·3 + 21·15)/1e6`: its own token counts times the entry's prices, reasoning at the output
price, a cache price only if the entry states one. Without `cost` it is `0`, silently. It knows
nothing of a 1-hour cache price or a charge the provider states. That is the reason for decision 10
of #544: the ledger reads the raw provider usage from the tee and never the engine's `cost`.

## 6. Caching (question 3), retries, thinking

### `applyCaching` through the relay

The body is identical on both sides of the relay in every call of every family. Which marks the
engine adds (the relay does not matter):

| Case | Marks |
|---|---|
| `@ai-sdk/anthropic`, any provider id, any model id (also `acme-…`) | `cache_control: {type: ephemeral}` on `system[0]` and on the **last two messages** (one message → only that one) |
| openai-compatible, model id containing `claude` | `cache_control` on the system message and the last messages (also on `tool_calls[0]`) |
| openai-compatible, any other model id (also `openrouter`, `deepseek` provider ids) | none |
| `@ai-sdk/openai` (Responses) | `prompt_cache_key` = the session id, every call |
| `@ai-sdk/google` | none |

So caching is decided by the SDK and the **model id**, not by the provider id. For the managed
OpenRouter models whose id contains `claude`, marks appear on the Chat family; for DeepSeek/Gemini
the provider caches implicitly and nothing is marked. A model id the engine does not recognise gets
no marks on the Chat family even if the upstream is Anthropic behind a gateway: note it in #548's
catalog notes. "Caching stays demonstrably active" (decision 9) is therefore a property to assert per
family in the live test (cache read/write tokens above 0 on the second call), not a given.

### Faults (T07)

- **One logical call becomes several upstream calls.** After a 429/500/503 or a cut stream the engine
  retries by itself: a persistent 429 makes **6 upstream calls** (1 + 5 retries), then the turn is
  answered (HTTP 200) with an assistant error `{"name":"APIError","data":{"statusCode":429,
  "isRetryable":true,"responseBody":"<the upstream body>"}}`. A 500 without `retry-after` took ~70 s
  to give up in the first measurement. A stream cut after a few events is retried as a whole new call;
  the cut call's usage is never seen, the retry's is.
- The ledger therefore sees more calls than the engine has steps, and **some calls have no usage at
  all** (cut streams). #550/#551 must reserve before each call, settle what is seen, and decide
  what a cut stream costs (a reservation, not zero).
- `responseBody` is the provider's error body verbatim. It can quote the key: the redaction that
  exists must cover it before anything is shown.

### Thinking and the tool loop (question 8)

- The six step loop completes on every family, with thinking on for Messages and Google.
- Anthropic thinking blocks (`thinking` + `signature`) come back **unchanged and first** in every
  later assistant turn; Gemini thought parts and `thoughtSignature` come back with their function
  call. The native SDKs do what #533 had to do in the wire.
- The Fable 5.1 case: `claude-fable-5-1` (in the snapshot, entry `{}`) runs a four step loop against
  the strict Messages rules of `fakes/llm/anthropic_rules.py` (forced `tool_choice` refused,
  `block_binding` needs the beta header, thinking blocks must come back as issued): every call is
  `tool_choice: auto`, `thinking: adaptive` with `block_binding` and the beta header, and no 400.
  That rule set is documented but is a fake; the real API is the live checklist.
- Variants: for `reasoning: true` the engine derives `low/medium/high` (Chat, Responses, Google) and
  `low…max` (Messages, adaptive + `effort`). They apply only when a turn names a `variant`; the
  adapter does not, so the defaults above are what runs.

## 7. Live checklist (needs real keys; runs later via `/review` on the playground)

Each item has to be answered with a scrubbed capture; none of it can be answered by a fake.

1. **A tool loop of ≥ 5 steps per family against the real provider**, relay in front, dummy key in the
   engine: DeepSeek direct and OpenRouter (Chat), OpenAI (Responses), Anthropic (Messages), Gemini
   (Google). Record the real request headers once more (are the extra `anthropic-beta` values
   accepted? does OpenRouter want `HTTP-Referer`/`X-Title`?).
2. **Real usage shapes.** Capture one real non-stream answer and one real stream per family (T10),
   scrubbed of ids, content and account data, as the fixtures of #551. Check in particular:
   - Chat: is `usage` present on the last chunk for DeepSeek and OpenRouter; does OpenRouter add
     `usage.cost` and cached/reasoning details; does DeepSeek use `prompt_cache_hit_tokens`.
   - Responses: `response.completed.response.usage` shape, `input_tokens_details.cached_tokens`.
   - Messages: `cache_creation` split (5 min / 1 h) in `message_start`, `output_tokens` in
     `message_delta`, thinking tokens (`output_tokens_details`), `service_tier`.
   - Google: `usageMetadata` repeated cumulative on several chunks or only the last; `thoughtsTokenCount`
     outside `candidatesTokenCount`; `cachedContentTokenCount`.
3. **Compression.** Does any real provider answer the streaming call with `content-encoding` when the
   engine offered gzip/br/zstd? (The relay forces `identity` anyway; confirm that every provider
   honours it.)
4. **Caching is active.** Second and third call of a loop: cache read tokens above 0 on Anthropic
   (marks), OpenAI (`prompt_cache_key`), DeepSeek and Gemini (implicit); record what the engine
   marks for a Claude model behind OpenRouter.
5. **Real errors.** A wrong key (the relay sends one on purpose), a 429, a 5xx, an overloaded
   Anthropic 529 and a refused request (for example `max_tokens` above the model's limit): status,
   body, `retry-after`, and what the engine surfaces. Does a real 429 body or an auth error quote the
   key?
6. **A real current model absent from the snapshot** (pick one that `GET /config/providers` does not
   list under the provider) through the entry alone, including reasoning/thinking on for the
   Anthropic and the Gemini model, and a model whose models.dev `status` is `deprecated`/`alpha`.
7. **Cut stream against a real provider** (the relay drops the connection after half the events):
   retries, upstream call count, and what the provider bills for the cut call (visible in the
   provider's usage page, not in the answer).
8. Spend stays below the USD 5 of the ticket; keys only from the environment of the relay process,
   never in the report or in a fixture.

## 8. Consequences for the follow-up issues

**#548 (catalog and per-job entry)**

- The per-job entry is as in section 3: `npm`, `options.baseURL`, `options.apiKey`, and the model entry.
  **Always set `npm`.** State `limit.context` and `limit.output` together or leave `limit` out;
  `{}` is valid for a snapshot model. `tool_call` is informational (filter in the catalog, the
  engine does not). Cost is irrelevant to the engine (the ledger prices) and may be omitted.
- Map models.dev `status`: `deprecated`/`alpha` entries are dropped by the engine, so either emit
  `beta`/nothing or do not offer the model.
- Cap `limit.output` at 32000 in the reservation (the engine sends the minimum).
- `GET /config/providers` on the started engine is a cheap validation of a generated entry.
- `OPENCODE_MODELS_PATH` is not needed. Keep the minimal file of section 3 as the documented fallback.

**#550 (passthrough core)**

- Allow-list per family (from section 4): Chat `POST …/chat/completions`, Responses `POST …/responses`,
  Messages `POST …/messages`, Google `POST …/models/<job model>:streamGenerateContent` (query
  `alt=sse`; also `:generateContent` if a non-stream call is ever wanted). No GET is needed.
- Auth swap table of three headers (`authorization: Bearer`, `x-api-key`, `x-goog-api-key`); forward
  `anthropic-version`, `anthropic-beta` and the `x-*session*` headers untouched; send
  `accept-encoding: identity` upstream.
- Count upstream calls, not engine steps: a retry is a new call (up to 6 per logical call), and the
  ledger needs a rule for calls that end without usage.
- "Model unknown" is a 500 `UnknownError` on the turn with zero upstream calls; map it to a stable code.

**#551 (usage parsers and fakes)**

- Start from `fakes/wire/formats.py` and `fakes/wire/upstream.py`: four families, JSON and SSE,
  distinct usage per call, faults (status, cut stream, compression), strict key/path/model. Replace
  the synthetic shapes by the live captures of section 7.
- The engine never needs non-stream, but the provider may still answer a streaming request with a
  document; the parser must read both.
- Chat needs `include_usage`: the engine sends it, so a missing last chunk means a cut stream, not a
  provider without usage.
- The 1 h cache split exists only in the raw Messages usage; the engine's own count sums it.

**#552 (finalization)**: the native SDKs carry thinking blocks and signatures and send `auto`, so the
#533 class of failure does not arise on the plain-text path (proved against the strict fake, to be
confirmed live). **#553 (cost policy)**: "no usage at all" occurs for cut streams, so the rule
"a call without usage fails the run" needs a distinction between a cut stream that is retried and a
completed answer without usage.

## 9. Reproduce

```
uv --directory runner sync --locked
uv --directory runner run python scripts/fetch_opencode.py            # once, needs the internet
OPENCODE_TEST_PATH=<dir holding rg> uv --directory runner run pytest -m engine tests/engine/test_engine_opencode_native.py
uv --directory runner run pytest tests/unit/test_wire_formats.py tests/integration/test_wire_fakes_servers.py
```
