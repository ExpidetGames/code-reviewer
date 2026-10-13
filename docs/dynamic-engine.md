# Dynamic Review engine: what runs, what is enforced, what was found

Issue #197 runs the **unmodified stock** `anomalyco/opencode` v1.19.0 as one headless server per
Dynamic Review job. There is no fork, no patch and no plugin (the lead decisions of 2026-10-12
superseded the review-mode patch of the [#85 research](spike/85-opencode-dynamic-review.md)). The
engine is shielded from the outside instead: [#196](dynamic-checkout.md) strips every discovery input
from the export, trusted runner code writes the engine config, the model is reached only through a
runner-owned proxy that holds the only credential, and the proxy enforces the epic's bounds.
`runner/README.md` ("Dynamic Review engine") describes the modules; this page records the decisions
and the findings that only the real binary showed.

## The pinned executable

`runner/opencode-pin.json` names release, tag, source commit, licence and, per platform, the archive
size and SHA-256 and the executable's SHA-256. `runner/scripts/fetch_opencode.py` is the only way an
executable gets onto a machine: https only, size and digest checked before anything is unpacked, one
regular file, the pinned version reported. Another architecture needs its own pinned artifact; the
amd64 digest is never reused. The runner image build reads the same pin (#202, which also owns the
licence and provenance audit of the binary inside `make check-licenses`). Nothing at run time
downloads anything.

## Where each bound is enforced

| Bound | Where | How |
|---|---|---|
| 600 s whole job | adapter watch + proxy | the watch ends the run at the deadline; the proxy refuses calls after it |
| 30 model calls, 120,000 tokens | proxy | reserve before forwarding, settle from the provider's usage, retries count |
| request/response bytes | proxy | refused before forwarding / before the engine gets the answer |
| 200 tool calls | proxy | counted in the provider's answer; the call over the bound is not handed to the engine |
| 64 KiB per result, 4 MiB cumulative, 100 distinct files | proxy | audited in the next request's history, before it is forwarded |
| what a read can reach | engine config + export | default-deny permissions, read-only export; reads outside the export are denied |

The audit reads the model requests, not the engine's session: the pinned server answers its own
session list with HTTP 400 once a JSON-schema format is stored (the defect of #85, still present in
v1.19.0 and pinned by an engine test).

## Found against the real binary

Part 1 shipped against a protocol fake; the real binary showed these, all fixed in part 2a:

- The agent config `tools: {"*": false}` removed **every** tool, `StructuredOutput` included.
- The engine always streams (`stream: true`); the proxy now asks the provider for the whole answer
  and returns a short event stream afterwards.
- The message answer is `{info: {structured}, parts}`, not a top-level `structured`.
- `OPENCODE_CONFIG_DIR` makes the engine install `@opencode-ai/plugin` from the package registry into
  that directory; only `OPENCODE_CONFIG` (the file) is set.
- Without a `rg` on its `PATH` the engine downloads ripgrep from GitHub on the first grep. The adapter
  refuses to start without one; the image must carry it (#202).
- A health request before the listening marker can hang; polls use short timeouts.
- The contract schema has only `$defs`; the engine's `StructuredOutput` tool needs an object root, so
  the engine gets a self-contained object schema (`dynamic_review/schema.py`).
- Plugins load lazily, on the first tool use. The unsanitized hostile tree executes its plugins (kept
  as the control of the engine suite); the sanitized export does not.

## Accepted and open

- Nested `AGENTS.md` files are attached by the stock engine to a read result as a system reminder.
  That is untrusted data in a read-only run; the fixed core says so; the engine suite records it.
- Part 2b of #197 and #202 still owe: the dedicated unprivileged uid under `prepared_checkout`, the
  per-job network boundary and its direct-network-denial proof, port ownership and process-group
  reuse (deployment), config readability across uids, and advertising `opencode` after the real
  startup self-check. Until then `capabilities.py` stays fail-closed and no Dynamic job reaches a
  runner.
