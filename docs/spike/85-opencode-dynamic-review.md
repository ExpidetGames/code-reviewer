# #85: OpenCode for Dynamic Review

Research date: 2026-10-12. Scope is the binding decisions in [#193](https://github.com/ExpidetGames/code-reviewer/issues/193), its lead comment, and [#120](https://github.com/ExpidetGames/code-reviewer/issues/120). Adoption as an additional engine and the logical default `deepseek-v4.1-flash` are already decided. `/ask`, `/improve`, and `/describe` are being removed; they are outside this spike. Production code, dependencies and behavior are unchanged.

## Recommendation and evidence boundary

Use **anomalyco/opencode v1.19.0** as the pinned integration candidate, with an explicit review-mode patch and a trusted tool-policy boundary. **Stock OpenCode is not ready for activation under this epic.** In particular, a discovered repository plugin executes despite the legacy config/plugin disable flags, project-config disabling does not stop nested rule injection, `steps` is advisory, and event monitoring cannot enforce budgets before execution. Keep Dynamic capability off until #197 proves the patched binary and #202 proves the supported non-root deployment. This is an implementation gate, not a reversal of adoption.

Evidence here distinguishes source inspection, local fake-model/Git experiments, and unresolved deployment/provider validation. No paid model calls, workspace credentials, GitHub installation credentials or environment files were read. No real quality or latency claim follows from scripted answers. Supporting scripts and public catalog observations are in [data/85](data/85/README.md). They are spike artifacts, not the future production test suite.

Read alongside the existing runner lifecycle (`runner/src/code_reviewer_runner/job_loop/process.py`), workspace BYOK (`app/src/llm/README.md`), and [CR-50](cr-50-fair-model-comparison.md). The older model spikes' quality scores carry shared-state confounds; CR-50 corrects those but measures PR-Agent, not Dynamic Review. CR-13's approximately 321 MB/job applies to PR-Agent and must not be used as an OpenCode measurement.

## 1. Engine, API, discovery and enforceable limits

### Upstream, release and packaging pin

The old `sst/opencode` GitHub URL resolves to **[anomalyco/opencode](https://github.com/anomalyco/opencode)**. It is not `opencode-ai/opencode` (the older Go project). The canonical repository is not archived, has default branch `dev`, and had a push on 2026-10-12. Releases v1.18.32 (September 21), v1.18.33 (September 28), v1.18.34 (September 30), v1.18.35 (October 6) and [v1.19.0](https://github.com/anomalyco/opencode/releases/tag/v1.19.0) (October 11) demonstrate current maintenance; they do not guarantee compatibility or an LTS/security SLA.

Pin all three, not just the executable's reported version:

- Tag `v1.19.0`, commit `733b2c627e5aec39cb33cc22373bdce33053ef2c`.
- Linux amd64 glibc archive `opencode-linux-x64.tar.gz`: **60,685,698 bytes**, SHA-256 `7bb9e61ad6feacf2e89c10a6a2c1840e3de4220bb50ba1fc7110f31806076aec`. The downloaded archive matched the release asset digest and `--version` printed `1.19.0`. Extracted executable: **185,747,584 bytes**. Bun is embedded; do not add a separate Bun runtime to the job image merely to run it.
- The eventual patched build's own source/patch/lockfile hashes and artifact SHA-256. Its checksum is necessarily different. Record other architectures separately; never reuse the amd64 digest for arm64.

The [pinned LICENSE](https://github.com/anomalyco/opencode/blob/v1.19.0/LICENSE) is MIT, copyright 2025 opencode. Preserve it and audit bundled runtime/native/JS dependencies and their notices. The present `make check-licenses` audits our app/Python lockfiles, not an externally downloaded executable. #202 must add a binary/Bun-lock provenance audit to that entry point. This spike does not distribute the upstream executable. A floating npm install, latest URL or runtime curl installer is unsuitable.

### Exact headless lifecycle and HTTP contract

[Server documentation](https://opencode.ai/docs/server/), verified against the [pinned serve command](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/cli/cmd/serve.ts), gives:

```text
opencode serve --hostname 127.0.0.1 --port <private-job-port>
```

Use one child process/session per job, a private working directory and allowlisted environment. Bind addresses explicitly; mDNS and browser CORS are unnecessary. `OPENCODE_SERVER_PASSWORD` enables Basic auth, with username `opencode` unless overridden. This is a per-job control capability, not the workspace provider key. The server also exposes shell/config/auth/MCP mutation endpoints: never expose its API to a repository process or other job. Tool permissions alone do not secure the HTTP API.

The adapter should use the pinned generated OpenAPI/SDK definitions, not today's documentation as a mutable contract. Relevant [session group](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts) and [message input](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/session/prompt.ts):

1. Wait for the pinned server listening marker, then poll `GET /global/health`; require `{healthy:true,version:"1.19.0"}` within a short startup deadline. Global health should not carry the directory-selection header.
2. `POST /session` with a supplied, non-default title avoids automatic title generation. For directory-scoped requests use `x-opencode-directory: /repo` (or the `directory` query parameter), pinned by the adapter.
3. `POST /session/{id}/message` with `agent`, `model:{providerID,modelID}`, `parts:[{type:"text",text:...}]` and `format:{type:"json_schema",schema:...}` waits for the assistant result. `POST /session/{id}/prompt_async` returns 204 and can be monitored through status/events instead.
4. The JSON-schema mode installs the non-filesystem **`StructuredOutput`** tool. Valid output is stored in the assistant message's `structured` field. Validate it again in Python against #195's bounded schema. Explicitly allow the exact `StructuredOutput` name: wildcard deny otherwise filters it from the model's tool set, even though the prompt loop creates it. It is not a write tool.
5. `GET /session/{id}/message` exposes tool parts (`tool`, `callID`, state `input/output/metadata`, status and timing) and assistant usage. `/event` and `/global/event` are SSE; `/session/status` reports active sessions. Tool metadata can include automatically loaded rule paths.
6. On cancellation call `POST /session/{id}/abort`, then terminate the entire owned process group with bounded TERM/KILL grace and reap it. `POST /instance/dispose` disposes instance resources, **not the listening process**. Remove private scratch only after children are gone. Reuse the existing runner lease/timeout owner rather than create an independent deadline that resets after checkout.

**Observed API defect:** with a stored JSON-schema user format, `GET /session/{id}/message` returns HTTP 400 on response encoding: `Expected OutputFormatJsonSchema`, at the first user message's format. The prompt POST still returns the final structured assistant result. The probe records this error and audits tool replies at the loopback model boundary; it does not substitute an empty message list. #197 must fix/reconstruct the [Schema.Class format](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/schema/src/v1/session.ts) in the pinned codec or use independently verified SSE/internal policy telemetry. The listed API is not a claim that every stock endpoint is usable. Initial polling before the CLI listening marker stalled in this harness; waiting for that marker before health worked.

`opencode run --format json --model <provider/model>` is the one-shot CLI alternative; its JSON is an event stream, not the neutral findings contract. The epic's server adapter is the better seam for explicit abort/status/error handling.

### Stock controls: useful but incomplete

The trusted launch configuration must set global default-deny permissions before explicit allows:

```json
{
  "permission": {"*":"deny", "read":"allow", "grep":"allow", "glob":"allow", "StructuredOutput":"allow"},
  "enabled_providers": ["review-proxy"],
  "instructions": [], "plugin": [], "mcp": {},
  "lsp": false, "formatter": false, "snapshot": false,
  "share": "disabled", "autoupdate": false,
  "compaction": {"auto":false,"prune":false}
}
```

There is **no separate built-in `list`** in this pin's [tool registry](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/tool/registry.ts). [Read](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/tool/read.ts) handles directories. Amend #193/#196/#197/#198 terminology to **read (including directory listing), grep, glob**; do not silently substitute a shell `ls`. Unknown tools stay denied, including future built-ins. Explicitly disable extra built-in agents in trusted configuration and prevent HTTP/request input from selecting another agent. Do not use the permissive `build` or interactive `plan` agent as a safety policy.

Relevant flags in the pin's [core flags](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/core/src/flag/flag.ts) and [runtime flags](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/effect/runtime-flags.ts):

| Control | What it provides / remaining problem |
|---|---|
| `OPENCODE_DISABLE_PROJECT_CONFIG=true` | Stops project opencode config/directory discovery and root project instruction lookup; does **not** stop nearby instructions attached during reads. |
| `OPENCODE_DISABLE_CLAUDE_CODE=true`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=true` | Stops Claude compatibility/external skill discovery. Config-directory/explicit skill sources and the built-in customization skill remain separate paths. |
| `OPENCODE_PURE=true`, `OPENCODE_DISABLE_DEFAULT_PLUGINS=true` | The legacy plugin layer honors these flags; the newer core/location plugin path still imports project code. Runtime sentinel proves execution. No complete plugin-discovery disable claim is valid. |
| `OPENCODE_DISABLE_MODELS_FETCH=true` | Uses bundled/explicit catalog instead of remote models.dev refresh. Supply exactly one custom proxy provider using bundled `@ai-sdk/openai-compatible`; unknown npm SDKs can otherwise cause package installation. |
| `OPENCODE_DISABLE_AUTOUPDATE=true` | Disables auto-update checks; also set `autoupdate:false`. |
| `OPENCODE_DISABLE_AUTOCOMPACT=true`, `OPENCODE_DISABLE_PRUNE=true` | Disable automatic compaction/pruning; hidden calls still need accounting. |
| `OPENCODE_DISABLE_LSP_DOWNLOAD=true`, `lsp:false`, `formatter:false` | Deny downloads and runtime services; read otherwise warms LSP. |
| `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true`, `OPENCODE_DISABLE_FFF=true`, `snapshot:false` | Disable watcher/native indexing and Git snapshots. Keep every experimental feature off except explicit disable flags. |

**Additional source and runtime blocker:** v1.19.0 also initializes the [core/location Config](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/core/src/config.ts) and [ConfigExternalPlugin](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/core/src/config/plugin/external.ts). That path scans config-directory plugins and imports their modules without checking the legacy project-disable or PURE controls. Module top-level code runs **before** plugin export validation; import/setup errors are ignored. A valid ESM fixture wrote `/scratch/plugin-owned` even with every disable flag and project config disabled. Read-only repository mounts cannot prevent this code from using runtime scratch, direct networking or the proxy capability. Our first CommonJS/readonly-write sentinel could fail before detection; the corrected ESM/writable-scratch sentinel exposes the failure. The safety assertion remains red; no test was weakened.

Configuration remains merged from global/auth/account/managed sources in [Config](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/config/config.ts); [ConfigPaths](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/config/paths.ts) still includes global/home directories. The loader starts dependency installation for config directories. Neither `plugin:[]` nor `instructions:[]` reverses all prior discovery or additive merges. Mounting a fresh empty HOME/XDG and omitting `/etc/opencode` prevents inherited contents, but is not a supported discovery-off switch or proof that no installation is attempted.

Most importantly, [Instruction.resolve](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/session/instruction.ts) walks ancestors of a read file and attaches nearby AGENTS.md under a system-reminder; it has no project-disable guard. Rule files must remain explicitly readable, so deleting them from the export would violate the epic and lose useful evidence. A read's normal text cap also does not cap separately appended rule text. This is a concrete safety/resource conflict, not something a stronger prompt fixes.

### Smallest maintainable integration option

Maintain a small, **review-mode-only** patch against this exact source, with upstreamable tests and upgrade fingerprint guards. The patch must:

1. Guard **both legacy and core/location runtimes** before any file scan/module import; select only the runner-provided, already parsed configuration; bypass global/project/managed/auth/account config, directory discovery and associated dependency installation. Return no custom command/agent/tool/skill directories. Disable all plugin loading, skill discovery, provider discovery, watcher/LSP/formatter/snapshot/share/update paths in that mode. Only explicit bundled proxy provider and shipped primary agent are allowed.
2. Return no automatic instruction system paths or nearby-rule attachments in review mode. Leave built-in explicit `read` behavior intact; its returned content is untrusted evidence.
3. Install an **internal tool-policy seam**, not repository-loaded code: before every allowed built-in call reserve/count activity and authorize canonical paths; after the call, before persistence/model exposure, validate/redact/count complete output, metadata, errors and attachments. No attachments in the initial text-only export. Route policy decisions over a bounded runner-owned IPC channel or enforce them in the sandbox child with runner-owned immutable code. Break/abort on limits rather than return a partial scan as success.
4. Enforce a hard iteration stop independently of the prompt; count final StructuredOutput too. Do not silently fall back on policy failure.

[SessionTools](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/session/tools.ts) already has before/after execution hooks, and [plugins](https://opencode.ai/docs/plugins/) expose them. A single **trusted baked plugin** could supply counters, but PURE suppresses it, it does not remove rule/config discovery, and allowing it requires revising #197's no-plugin requirement. The internal seam plus review-mode guard avoids granting a general plugin surface. This patch is a recommendation, not a compiled/hardened artifact shipped by #85. #197 must prove all branches with the real patched executable before capability activation; if the patch grows into a fork of the agent loop, take that maintenance decision back to the lead.

### Where limits actually belong

[The step loop](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/session/prompt.ts) checks `agent.steps`, then appends a final-step prompt. It does not remove tools or break solely at that threshold. Therefore a scripted model can ignore it; `steps:30` is not the 30-call limit. One step may request multiple tools. A default session title, retries, summaries/compaction or helpers can introduce other model requests.

| Epic bound | Enforcement recommendation |
|---|---|
| 600 s whole job | Monotonic deadline starts before token/fetch/preparation; cap by runner timeout; proxy/read/export/publish inherit remaining time; kill owned group on lease loss/shutdown. |
| 30 calls | Proxy counts every HTTP upstream attempt, including retries and hidden calls. Reject call 31 before sending; do not rely on main-loop/SSE counters. |
| 120,000 input + output tokens | Reserve full serialized input (including tool schemas/history) plus output allowance before each call; reconcile actual prompt/completion/reasoning/cache counters without double-counting detail fields already included in totals. Retries consume reservations. Missing usage is failure, not zero. |
| 200 tools / 100 files | Internal synchronous policy, before dispatch; count failed/unknown attempts and canonical content-bearing file identities. Grep may read many files in one call. |
| 64 KiB/result / 4 MiB cumulative | Count UTF-8 of everything actually delivered, including errors, metadata, paths, reminders and attachments; inspect before model/persistence. No unmarked truncation. |
| Model context/output | Check per-call window separately from cumulative budget; reserve/clamp output by remaining tokens, money and time. |

Events and `/message` permit observation/count reconciliation, **not prevention**; receiving a completed event is too late to enforce pre-read permissions or byte limits. A proxy can reject overlarge message histories before upstream but cannot undo a file read or prevent a child from first accumulating the content in memory. Use both policy and proxy. Tool redaction must not allow an error string/attachment to bypass the normal output path.

Exact DeepSeek tokenization is not provided by this runner's tiktoken model lookup. OpenRouter labels the tokenizer `DeepSeek` without exposing a matching pinned tokenizer revision here. #197 needs a verified local tokenizer or a proven conservative reservation bound and capped output. Treat provider usage as authoritative after the call; fail closed when reservation/accounting cannot be established. Unknown price means `costUsd:null`, not a guessed zero.

## 2. Model route, protocol, limits and public prices

The **logical setting** is `deepseek-v4.1-flash`. The **OpenRouter request model** is **`deepseek/deepseek-v4.1-flash`**, to **`https://openrouter.ai/api/v1/chat/completions`**. The existing BYOK provider remains `openrouter`; PR-Agent's LiteLLM `openrouter/` prefix is not part of the wire model id. Inside OpenCode use a private provider such as `review-proxy/deepseek-v4.1-flash`, bundled `@ai-sdk/openai-compatible` and a local `/v1` base URL. Its key is only a local job capability/dummy, never the workspace key. The trusted proxy supplies the workspace credential, rewrites model/auth/routing, rejects other paths and redirects, and knows the selected endpoint's capabilities.

Primary public sources, fetched without auth: [model catalog](https://openrouter.ai/api/v1/models), [endpoint catalog](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints), and [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection). Selected raw fields are preserved in [catalog-observation.json](data/85/catalog-observation.json). These are observations, not contractual future prices; the public model page and older CR-50 list prices differ, so do not average them together.

- Catalog context: **1,048,576 tokens**, top-provider maximum completion **393,216**; tokenizer **DeepSeek**. Context/output limits vary by endpoint. Text/image input and text output are advertised; our first stage should permit text only.
- Model-wide parameters advertise `tools`, `tool_choice`, `response_format` and `structured_outputs`; endpoint support is narrower. OpenCode JSON-schema mode actually uses **tool calling** rather than relying on upstream JSON-schema constrained decoding.
- Native OpenRouter **`deepseek`** endpoint: 1,048,576 context, 393,216 output; `tool_choice:auto` supported, **`required` and named-function choice not supported**; `response_format` advertised, `structured_outputs` absent. Stock OpenCode sends `tool_choice:required` for its StructuredOutput mode. This route is therefore not verified compatible with that mode.
- Example compatible route **`deepinfra/fp8`**: 1,048,576 context, **131,072 output**, tools, required/named choice and structured outputs advertised. The `open-inference/fp4` endpoint also advertises them. `morph/fp8` and `relace` lack required choice. **Do not let generic OpenRouter routing silently choose an incompatible endpoint.** Capability metadata is not a real-model conformance test.

Public endpoint prices, **USD per 1,000,000 tokens**, observed October 12:

| Endpoint | Input | Output | Cache read | Notes |
|---|---:|---:|---:|---|
| `deepinfra/fp8` | 0.14 | 0.42 | 0.0042 | Compatible advertised tool-choice; proposed initial constrained route, pending conformance/data-policy decision. |
| `open-inference/fp4` | 0.0336 | 1.188 | 0.0336 | Compatible advertised tool-choice; different quantization. |
| `deepseek` | 0.15 or 0.30 | 0.60 or 1.20 | 0.003 or 0.006 | Catalog includes time-of-day/day overrides; required tool choice unsupported. |
| `morph/fp8` | 0.042 | 0.60 | 0.009 | Not compatible with the pinned required-choice mode. |
| `relace` | 0.05 | 0.60 | 0.008 | Same problem; no structured_outputs flag. |

Recommended trusted route policy for the first compatible candidate: `provider.only:["deepinfra"]`, `allow_fallbacks:false`, `require_parameters:true`, then pin/validate endpoint limits and tool-choice support. Pinning this hosting provider is an **explicit recommendation**, not a lead decision or a claim of tested output quality. If this provider is unavailable, return the mapped provider error; do not switch to native DeepSeek or another model invisibly. Alternatively patch output completion to use auto tool choice and validate independently, but that is a different tested transport. API snapshots disagree with headline page minimums; actual charged provider usage is the correct accounting input. Never promise a flat per-review price.

At conservative 0.30 input / 1.20 output, a 60k input + 6k output exploration costs **USD 0.0252**; at the proposed 0.14 / 0.42 route, **USD 0.01092**. Both are assumptions, not measurements. The 120k cumulative token ceiling alone allows **USD 0.144** if all chargeable tokens are output at 1.20/M. The previous **USD 0.10 average** target is neither a Dynamic measurement nor a hard currency bound. Add an operator-owned **money reservation ceiling** and route-price caps if that target must be enforced. Preserve `null` cost for missing verified pricing/usage; do not apply a Diff single-call UI estimate to Dynamic.

## 3. Sandbox deployment and footprint

The runner Dockerfile uses Debian bookworm, uid/gid **10001**, a writable home and tini. Adding bubblewrap does not grant its user permission to create namespaces. [Bubblewrap upstream](https://github.com/containers/bubblewrap) describes a mechanism whose security comes from the caller's mount/namespace policy; a broad `--ro-bind / /` still exposes all readable files. No host HOME, other-job paths or parent proc should be mounted. Required runtime libraries/binary and sanitized tree are read-only; private XDG/HOME/tmp stay writable.

Local host: Linux **6.8.0-124-generic**, Docker **29.2.1**, `kernel.unprivileged_userns_clone=1`, `user.max_user_namespaces=30852`, `kernel.apparmor_restrict_unprivileged_userns=1`; bubblewrap package **0.8.0**, Git **2.39.5** in the runner-derived image. No host sysctls or profiles were changed.

| Actual probe | Result |
|---|---|
| uid 10001, Docker defaults | `No permissions to create new namespace` |
| uid 10001, seccomp unconfined, docker-default AppArmor | `Failed to make / slave: Permission denied` |
| uid 10001, seccomp + AppArmor unconfined | `setting up uid map: Permission denied` |
| Same with SYS_ADMIN added | Still uid-map failure; granting this capability did not solve unprivileged launch. |
| Root diagnostic supervisor, SYS_ADMIN, both profiles unconfined, **without user namespace** | Filesystem/PID bwrap probe can run a uid 10001 child through setpriv. This proves those mounts, not non-root user-namespace support. |

Thus **the intended non-root user-namespace launch is unsupported on this host as configured**. `unshare -Ur` succeeding for the root host process does not prove the uid 10001 container path. Do not advertise capability from root preflight or binary presence. The diagnostic root/SYS_ADMIN configuration is **not a production recommendation or fallback**.

Required supported-host conditions: kernel user namespaces enabled with nonzero quotas; seccomp permitting the actual clone/unshare/mount namespace setup; host LSM policy permitting userns and namespace-local mounts. [Docker's seccomp documentation](https://docs.docker.com/engine/security/seccomp/) explains default restrictions; [Docker's Ubuntu rootless guidance](https://docs.docker.com/engine/security/rootless/troubleshoot/) identifies AppArmor's Ubuntu 24.04+ userns restriction. Prefer dedicated tested seccomp/AppArmor profiles scoped to the runner/bwrap over globally disabling restrictions. This spike does **not** supply a validated minimum production profile or require privileged containers. #202 must test the actual non-root image under named Debian/Ubuntu/Coolify configurations, including rootless/userns-remap where supported, and otherwise fail closed. Coolify delegates to the host Docker/kernel policies; it cannot be assumed to fix them.

Network namespace isolation needs special attention: `bwrap --unshare-net` gives a different loopback from a proxy in the parent. Sharing host networking makes all same-host job proxies reachable. Use a per-job network namespace with trusted proxy transport/bridge or an authenticated narrow local IPC transport, and prove cross-job rejection. The diagnostic uses Docker `--network none` with a local fake inside that container; this is an OS guard for all children, not the future production proxy-only egress policy. Hosted activation still depends on #82.

### Size and RAM

The spike image adds Git, bubblewrap, ripgrep and Python needed by the diagnostic plus the OpenCode executable to an existing runner image. Raw executable is **177.14 MiB**; archive **57.87 MiB**. Initial image inspection: parent manifest `.Size` **198,074,259 bytes**, spike **302,931,623 bytes**, compressed-content delta **104,857,364 bytes (100.00 MiB)**. `docker image ls`/the containerd store reports a different size convention (unpacked content plus shared/packed data); do not confuse archive/manifest size with runtime writable footprint. This exploratory package set is not a final reproducible release image.

The completed pinned-binary injection run used **11 model calls and 11 tool calls**, took **5.81 seconds**, and sampled a peak engine RSS of **596.57 MiB** (20 ms sampling, stock binary with the root diagnostic supervisor). Three checks passed and the plugin non-execution safety assertion **failed**; [raw counters](data/85/probe-observation.json). This is a completed stock trace with a reproduced security failure, not a successful production job or a capacity distribution. These are fake-model operational numbers, not real-model latency. Whole-job cgroup peaks and worst-case jobs remain unmeasured. Sampling process RSS excludes checkout page cache, proxy/runner memory and transient helper RSS; do not call it a whole-job maximum. The full 64 MiB export/4 MiB tool budget and concurrent jobs are not validated by a tiny injection fixture. Start with **one Dynamic job at a time**, provision at least **1 GiB per Dynamic slot plus the runner/other engine reserve** as an unvalidated conservative operational proposal, and run the bounded worst-case/cgroup OOM matrix in #202 before increasing concurrency. Do not change the epic's envelope based on a canned answer.

## 4. Checkout/ref edge cases

[GitHub installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation) supports HTTP Git with an installation token and contents permission. [GitHub PR checkout guidance](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/checking-out-pull-requests-locally) documents base-repository `refs/pull/<n>/head`, including inactive/fork PRs. The head ref is the PR head, not `refs/pull/<n>/merge` and not a PR-supplied fork clone URL.

Local [Git probes](data/85/test_checkout.py), using separate fork/base/object repositories and `file://` protocol transport, prove:

- Pushing a fork commit into the base's `refs/pull/85/head`, then fetching it with `--no-tags --depth=1 --filter=blob:none`, gives the exact expected SHA and one visible commit. `rev-list --objects --missing=print` shows missing blob objects until trusted `cat-file` hydration.
- Filtering requires server `uploadpack.allowFilter`; unsupported servers may ignore the filter. These probes do not prove a real GitHub installation's private-fork authorization or GHES configuration. No installation token was available to this spike; do not conflate public/docs/protocol evidence with a live credential test.
- An orphan force push replaces the ref and can leave no merge base. Two endpoint trees can still be compared with two-dot diff; a three-dot comparison fails. Once the old ref/reflog is removed and garbage collected in the fixture, the old SHA is unavailable. A depth-one current-head fetch must not be assumed to retain it.

Trusted preparation should initialize an empty private bare object store and use fixed Git argv/config: no inherited config/credential helpers, terminal prompts, hooks, alternates, URL rewriting, filters, textconv, recurse-submodules or LFS. Supply credentials through a transient FD/credential broker or askpass implemented by trusted runner code; never tokenized URL/argv/config or an agent-mounted credential file. Use the trusted base repository identity from the contract. Fetch only `refs/pull/<validated number>/head`, verify it equals the queued SHA, and reject stale/deleted/unavailable heads with stable classification. Branch rename/deletion must not cause fallback to the default branch or a newer head. Re-check live PR/lease/head before publication.

[Partial clone documentation](https://git-scm.com/docs/git-clone) describes deferred blobs; **blobless/shallow is not a byte quota**. A small tree can reference a huge allowed-looking blob. Enforce download and disk limits during fetch **and every hydration**, including retries, objects/temp packs and API responses. Git's progress stderr is not a trustworthy hard byte counter. Use a trusted capped transport/disk quota/cgroup deadline boundary; pack expansion also needs a bound. Validate tree modes/paths and blob sizes before reading allowed blobs; `ls-tree -rz` and `cat-file --batch-check/--batch` avoid checkout filters. Hydrate only authorized object ids, then remove all Git state before agent launch. No lazy fetch can occur in the exported tree because it has no `.git`.

The image's Git 2.39.5 and host Git 2.43.0 do not support the modern global `--no-lazy-fetch` option. Do not document that switch for bookworm unless Git is deliberately upgraded/pinned and tested. For those versions, prevent lazy network access by removing/disabling the promisor remote and blocking protocols outside explicit trusted hydration. Network/disk quota enforcement remains necessary even if a future Git supports the switch.

**Change #196's previous-head algorithm:** GitHub's [compare endpoint](https://docs.github.com/en/rest/commits/commits#compare-two-commits) is documented as a merge-base/three-dot comparison, not an arbitrary endpoint tree diff. For force-pushed/diverged heads it is not reliable incremental evidence by itself. It also bounds file lists to 300 and omits some patches; a 200 response does not establish completeness. Fetch both exact commits/trees under the same quota and calculate a trusted two-dot diff if available; otherwise declare full review, retain findings not affirmatively reassessed, and do not infer resolution from absence. Keep the base-to-head PR diff and prior-to-current endpoint diff distinct in metadata. Test renamed files, deleted files, missing old SHA, empty/orphan divergence, compare truncation, GHES no-filter behavior, stale ref races and quota exhaustion.

## 5. Prompt injection: what can and cannot be proved

The [probe](data/85/probe.py) constructs hostile root and nested AGENTS.md asking to ignore review, write a file and leak a key, plus an opencode config declaring permissive tools and a plugin that would write a sentinel. Its loopback SSE model deliberately requests an explicit rule read, an adjacent source read, directory listing, external read, shell/bash, write, webfetch, task and an unknown tool, then StructuredOutput. No real provider key exists; routing config contains only a dummy local value.

**Observed result:** root AGENTS.md was not automatically promoted and remained explicitly readable; reading an adjacent file **did automatically attach nested AGENTS.md**. The only offered tools were read/grep/glob/StructuredOutput. All six forbidden tool attempts returned unavailable-tool results; the external read of an existing runtime text file was refused by permission policy; directory read and structured completion succeeded; checkout hashes were unchanged, but the automatically imported plugin wrote its sentinel into writable private scratch. The root-supervised bwrap checks denied writes, hid the outside sentinel and parent PID, and reaped the engine. Basic auth used only a dummy job capability. This proves the built-in tool permission boundary under the scripted injection, **not** the automatic-code/instruction boundary or production unprivileged launch. The overall launch is unsafe: permissions on model tools do not apply to imported plugin code.

The key boundary is architectural: provide **no workspace/GitHub/runner/lease secret** to OpenCode, its env, readable runtime files, proc view or tools. A denied exfiltration attempt cannot steal an absent key. The runner-owned model proxy holds the real key outside that boundary. A scripted fake demonstrates deterministic permission behavior, not that a real model will resist instructions to approve everything. Schema validation does not establish truthful/comprehensive review quality either.

The pin has source- and runtime-proven plugin execution and nested rule-promotion paths even with project-config disabled. Therefore a stock invocation cannot meet the epic's complete prompt-boundary claim. The production acceptance test must run twice: stock demonstrates the regression, review-mode patched binary proves no automatic rule/config/plugin/skill loading while explicit AGENTS.md reads still work. Include hostile tool output/metadata/errors and files whose rule text exceeds the normal read result cap. Preserve files and immutable authority; do not hide the rule fixture or relabel the system reminder as harmless.

For read-only and external denial, combine tool policy, exported filesystem mounts, isolated parent proc, absence of secrets and OS egress guard. Built-in grep/glob invoke trusted fixed ripgrep argv internally; this is distinct from model-selected shell execution. No repository-defined `rg --pre`, hooks, build/test/dependency commands or arbitrary HTTP may run. Add malicious gitignore/config/attributes cases and supervise helper processes too. Hosted network restrictions remain #82; a denied `webfetch` is not proof of proxy-only egress.

## 6. Concrete recommendations for every child

| Issue | Recommendation / required addition |
|---|---|
| [#194](https://github.com/ExpidetGames/code-reviewer/issues/194) | Keep logical `deepseek-v4.1-flash`; provider slug/endpoint belongs in trusted adapter, not project settings. No secret/URL/permission controls. Unsupported engine/model is visible and never reinterpreted as Diff. |
| [#195](https://github.com/ExpidetGames/code-reviewer/issues/195) | Claim capability only after the same uid/namespace/patch/API/proxy preflight used for launch. Include declared full/incremental mode and exact head/base/prior SHAs in the bounded contract. Add stable sandbox/config/policy/accounting/checkout-incomplete failures. Resolve the no-non-review-command wording with the lead decision. |
| [#196](https://github.com/ExpidetGames/code-reviewer/issues/196) | Treat blobless as optimization; hard-bound transfer/hydration/pack expansion. Replace unconditional API incremental comparison with exact endpoint tree diff or declared full mode. Test missing prior SHA, compare completeness and actual Git version. Non-root host fails closed. Read directory listing replaces separate list. Live private fork/GHES cases remain a rollout validation task. |
| [#197](https://github.com/ExpidetGames/code-reviewer/issues/197) | Own review-mode guards for **both** runtime graphs, discovery/instruction patch and synchronous tool-policy seam; patch hashes/upgrade guards; real-engine regression tests. Enforce steps/calls/tokens/results outside prompt/SSE. Pin compatible OpenRouter tool-choice route; proxy counts retries/hidden calls and validates usage. Prove tokenizer reservation and authenticated cross-job endpoint isolation. No production stock invocation. |
| [#198](https://github.com/ExpidetGames/code-reviewer/issues/198) | Deliver core through the trusted primary agent/system API, never OpenCode instructions/skills discovery. Rule reads are demarcated data; no repository respect clause granting authority. Use read-directory vocabulary. Keep literal skill/output/re-review contract and planned Codex/Google/PR-Agent notices. |
| [#199](https://github.com/ExpidetGames/code-reviewer/issues/199) | State compatibility is a concrete blocker: PR-Agent normalization derives ids from path/body and discards P0–P3, confidence/evidence; its reconciliation caps resolved history and can resolve by absence. Add pinned preservation/identity/reconciliation hooks and fixtures for both directions, or gate switching. Validate opaque ids and priority/confidence without lossy defaults. |
| [#200](https://github.com/ExpidetGames/code-reviewer/issues/200) | Use actual model/route data and null/unknown estimate; multi-call cost is not a single Diff quote. Explain that skill cannot alter permissions. Remove the obsolete unresolved non-review-command policy from acceptance language. |
| [#201](https://github.com/ExpidetGames/code-reviewer/issues/201) | Require patched real-engine journey plus OS guard, capable routing and limits preserving prior comment; do not fake away missing prerequisites. Cover declared full mode on force push and gated kind switching. Only automatic/manual `/review` remains in product scope. |
| [#202](https://github.com/ExpidetGames/code-reviewer/issues/202) | Add checksum/source/patch/dependency provenance audit to make check-licenses; offline uid 10001 preflight. Publish tested host seccomp/AppArmor/userns profiles and negative cases. No root/SYS_ADMIN diagnostic fallback. Measure bounded worst-case/concurrent RSS plus cgroup peaks, then decide slots. Document compatible route/prices as observations, currency reservations, #82 hosted egress gate, unknown tokenizer/state blockers. |

Installed PR-Agent 0.47.0 source `pr_agent/algo/review_finding_state.py` establishes the #199 conflict: `normalize_finding` creates a new normalized object with only finding id/state/body/path/lines; `_retained_findings` defaults to 20 resolved entries; `reconcile_review_findings` handles current findings through that normalization. The parser/serializer accepting extra fields alone is not a lossless round-trip through a subsequent Diff review. No production compatibility hook is added by this spike. Also the epic's 65,000-character comment limit and 64 KiB completion HTTP bound are separate: multibyte UTF-8, hidden state and JSON escaping need byte-based reservation tests.

**Proposed epic edits:** name the verified upstream/pin; make the review-mode patch and compatible required-tool-choice route explicit gates; use the three actual repository tools including directory reads; correct the previous-head diff algorithm; record this host as unsupported pending validated profiles; keep state switching gated; distinguish tokenizer/context/cumulative/currency budgets; remove the non-review open question resolved by the October 12 lead comment. Keep the existing resource limits until worst-case measurements support a revision. Do not expand execution or introduce another engine/provider/key store.

## 7. Real-model measurement plan and remaining open points

[measurement_plan.py](data/85/measurement_plan.py) prepares a seeded, balanced **24-trial** follow-up: the same three CR-50 PR fixtures, four first-review repetitions each, Dynamic and Diff with the same DeepSeek model. It also emits blinded visible result captures, excluding model/engine/cost/provenance. It has **no model/GitHub execution command**. Execution needs the secure adapters/export fixtures first; pointing an unpatched stock agent at live PRs is not an acceptable benchmark shortcut.

Freeze the historical heads/settings and private scoring key before execution; CR-50 is three PRs, **not 50 PRs**. Add a separate labeled set of real missed/invented findings once maintainers supply approved cases; no cases are invented here. Run with publication disabled, isolated empty finding state per trial, immutable core/shipped skill hashes, same route/provider where possible, no fallback, recorded content/omissions. Archive prompt/tool trace, proxy attempts/usage, wall time, peak process/cgroup memory, outcome and strictly validated findings; keep private mappings/scoring key out of git. Blind-score found/borderline/missed, false positives and additional valid issues using the existing criteria; remove hidden state/timestamps that leaked run order in CR-50. Cost/latency include failed/repeated runs; partial/limit-failed reviews count as failures, not complete successes. Re-review/state compatibility gets its own hermetic suite rather than shared live comments contaminating quality trials.

Estimated **24-trial** model spend, assuming 60k input + 6k output per trial and no cache benefit:

- Proposed compatible route 0.14/0.42: **USD 0.26208**, or **USD 0.301392** with 15% margin.
- Conservative CR-50-style 0.30/1.20: **USD 0.6048**, or **USD 0.69552** with 15% margin.
- Entire 120k allowance charged at 1.20/M: **USD 3.456**, or **USD 3.9744** with 15% margin. A **USD 4 reservation ceiling** would cover this explicit price-capped 24-trial scenario; it is not authorization to run. At the proposed 0.42 maximum token price the analogous ceiling is USD 1.2096 before margin.
- Twelve Dynamic-only trials halve those numbers. Additional cases, scorer calls, provider fees, retries beyond the reserved attempt plan and different prices need separate reservation. No quality/cost claim is made without the run.

Outstanding: compiled review-mode patch conformance (including the currently failing plugin safety probe); exact tokenizer reservation; actual provider tool-choice/usage/pricing conformance with a workspace key; non-root supported-host profiles and worst-case RAM/concurrency; installation-token private fork and named GHES versions; compatible state hooks/history preservation; end-to-end cleanup/lease/publication test. No key was read or real call run for these. #197/#202 must close the technical gates, and a later manually authorized measurement supplies quality/runtime evidence. The adoption decision itself is not reopened.


## 8. Checks and preserved failures

- `TEST_MAX_WORKERS=1 make verify`: green on the issue worktree, Node 24.21.0,
  pnpm 10.17.0 and Python 3.13.14. App unit: 2,941 passed; runner unit: 788 passed;
  app host integration: 2,649 passed; runner integration/contract: 130 passed;
  license check: 563 npm / 145 Python installed packages, 807 lockfile entries.
  Three existing non-root permission checks skip locally as allowed, enforced in CI.
  The standard local run also skipped 14 optional Postgres cases without TEST_DATABASE_URL.
  All four Postgres-enabled files were then run against an owned disposable Postgres 18:
  **17 focused tests passed**, including the 14 previously optional cases. No DB/container
  belonging to another task was used, and the disposable container was removed.
- Offline local Git checks: 2 passed; measurement-plan/blinding checks: 2 passed.
  Prototype ruff and its separate strict pyright configuration: green.
- Pinned stock engine under OS network guard: 3 checks passed, **1 safety assertion failed**
  because a discovered ESM plugin executed. This expected research finding is preserved as a
  failing assertion, not changed to allow execution, skipped, or hidden behind a fake engine.
  Built-in tool restrictions, explicit reads, structured return, read-only/PID mounts and
  owned-engine cleanup were exercised; non-root user-namespace activation was not proved.
- Initial four-worker verification encountered existing test timeouts under host contention;
  the single-worker run passed without changing tests. No build, browser, dev server, model
  benchmark, GitHub installation-token operation or production Dynamic job was run.

No prototype is imported by production. The deliberately red stock-engine safety probe is a
reason for the review-mode patch/preflight gate in #197/#202, not permission to ship that launch.
