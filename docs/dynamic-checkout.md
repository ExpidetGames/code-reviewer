# Bounded Dynamic Review checkout

Issue #196 supplies trusted preparation in
`runner/src/code_reviewer_runner/dynamic_review/`. It launches no OpenCode engine and does not
advertise `opencode`, enable the instance gate, compose a prompt or publish a comment. Those
boundaries are #197–#202. The default runner image runs as its existing non-root runner user; the
`dynamic` image target run by `compose.dynamic.yml` supplies the root supervisor and the dedicated
engine user (#202) that this preparation is used under.

## Integration and lifetime

After validating the claimed job, the root supervisor uses `prepared_checkout` with a dedicated
unprivileged `AgentIdentity(uid, gid)` and a parent **inside the job process's fresh working
directory**. Keep its context open until the engine and every owned helper have ended:

```python
with prepared_checkout(job, Path.cwd() / "dynamic", identity) as (content, lifetime):
    # #197 supplies the trusted engine adapter, config, proxy and process supervision.
    # content.export is read-only; content.root / "evidence.json" is read-only evidence.
    # lifetime.environment is the clean starting environment; runtime is private scratch.
    ...
```

`run_dynamic_job` consumes the result through its `prepare` seam (#197, see
[the engine page](dynamic-engine.md)): the model is given `content.diff`, the title and body from
`content.metadata` (`{"title", "body"}` JSON, otherwise the body), the incremental diff when
`content.comparison` really is incremental, `content.prior_state` and the skipped/omitted paths, and
a finding may only point at a path in `content.files`.

`prepare_job_content`/`prepare_content` alone produce a **private trusted intermediate**, not an
agent launch authorization. `PreparedJob.seal` removes write permission, verifies ownership and
rejects symlinks, hardlinks and special files. An actual-uid, isolated Python probe opens every
exported file for reading, fails if any export directory cannot be read (directory-walk errors are never skipped),
verifies that write opens and directory creation are denied, and
verifies that a private root file and the credential-bearing parent's proc environment are
unreadable. Its deadline comes from the same preparation lifetime. Missing root/user/group,
unclean ancestors or managed discovery, a failed probe or an occupied identity fails closed
with `dynamic_isolation_self_check_failed`.

The public seam requires the supervisor's root-owned `cr-job-*` working directory, initially
`0700`. After reserving the identity, it temporarily grants only that primary group traversal
(`0710`) through the working directory, without listing or write access, and restores the original
mode/group on every unwind. This lets the actual user reach the sealed export without opening
another job's parent. Arbitrary/shared working directories are refused.

Files are root-owned `0440`; directories are root-owned `0550`; the job boundary is root-owned
`0710` with the job's primary group. Per-container uid **and** gid leases are exclusive, including
across different job parents. Concurrent slots therefore need distinct dedicated users and
primary groups. Small root-only leases under `/run/code-reviewer-checkout-users` persist to avoid
unlink/flock races; they hold no repository data or credentials. The engine must be started with
that uid/gid and **no supplementary groups**, without inheriting credentials or open parent fds.

Fresh HOME, XDG config/data/cache/state and scratch directories are outside the read-only tree,
owned by the job user with `0700`. The environment begins with only these paths and a fixed PATH.
No inherited provider/auth/account, Git, proxy, skill or `OPENCODE_CONFIG*` variable is copied.
Only #197's trusted runner-generated engine settings may be added. Root-owned ancestors must
contain no engine config/skill directories or rule files. `/etc/opencode` must be absent, including
an empty inherited managed directory; no managed/credential file is read to inspect it.

Preparation exceptions, timeout and cancellation remove only the newly created private
preparation directory. The lifetime context removes export/runtime/scratch on every unwind,
including engine failure. #197 must end its process group before leaving it. Keep the parent under
the existing job-loop `SubprocessLauncher` working directory: its collector kills the owned group
and removes that directory after forced termination too, when Python cannot run a `finally`.
The integration suite proves blocked preparation/helper termination and independent job cleanup
through that existing supervisor. No engine/network self-check is implied by permission sealing;
#197 supplies proxy-only egress and whole-engine supervision before launch (ADR 0003).

## Exact acquisition and hard bounds

The installation token is an in-memory HTTP authorization header of the trusted supervisor.
It is never a URL, Git config, argv, environment value or credential file. The URL is constructed
from the validated base repository identity and trusted API host (GitHub or GitHub Enterprise),
and must match the PR repository. No fork-supplied clone URL or repository command is followed.
HTTP redirects and inherited proxies are not used. Provider response bodies never become errors
or logs; auth, forbidden, rate limit, missing repository and availability failures keep the
existing stable codes. Stale/missing/malformed head or incomplete required evidence is
`checkout_incomplete`; deadline expiry is `timeout`.

A small Git smart HTTP v0 client reads the ref advertisement within the same cumulative
preparation envelope (a busy repository can advertise many megabytes of `refs/pull/*/head`, so it
is not limited by the 1 MiB per-field cap), and explicitly wants the queued
commit, obtained from `refs/pull/<number>/head` in the **base** repository, and the base-ref snapshot.
Both advertisement and fetched object identity are verified; the PR ref is checked again before
returning preparation. Depth one and a size filter, `filter blob:limit=<file limit + 1>`, are requested when supported, so the server sends the trees and every blob up to the file limit in the same response and leaves larger blobs out: an oversized file is never downloaded or charged. A blob that a tree names and the response does not hold is therefore above the limit and is omitted as `large_file` (and skipped as `too_large` when it changed). Checked against git `upload-pack` and live GitHub (#296): a filter applies to objects reached through the wanted commit, but a blob **wanted by name is always sent**, so no blob is ever wanted by name. Small blobs of denied paths arrive in the same response (the path is only known from the tree); they are never read, exported or wanted by name, and the private staging that holds them is deleted before sealing. The merge base is
found with a bounded, commits-only ancestry walk (`deepen` with `filter tree:0`), so it cannot pull
in trees or blobs. Ignored filters are allowed only within the same hard envelope. Without the `filter` capability the response holds every blob and only the budgets bound it.

No Git client object store, checkout or `index-pack` is used in production. The runner verifies
PACK versions 2/3, checksums, object headers, bounded zlib output, REF/OFS deltas and copy ranges,
and object SHA-1/type itself. Delta dependencies are bounded to 64 rounds. This avoids expansion
inside Git before a post-fetch size check. Unknown/corrupt/incomplete packs fail closed. The
private raw object staging is deleted **before** sealing, including denied blobs delivered by a
server ignoring the filter. Denied paths receive no path-based blob reads or explicit hydration.
There is no `.git`, promisor remote, alternate, shared Git cache or agent-side lazy-fetch mechanism.
This works independently of bookworm Git's lack of `--no-lazy-fetch`.

| Bound | Enforcement |
|---|---|
| 20,000 entries | Each exact endpoint tree, including directories; before blob reads. Pack object count also has a bounded envelope. |
| 512 KiB/file | Blob size before content read/materialization; redacted output checked again. Oversized unchanged input has an omission; a changed oversized file is skipped with reason `too_large` rather than failing. |
| 64 MiB exposed content | All exported regular content plus serialized evidence, including manifest, metadata and prior state. |
| 256 MiB transfer | Raw bytes received from the server: HTTP status/headers/chunk framing/body, the ref advertisement and every pack, or the offline Git transfer. Counted once, here, and not again as expansion (#296). No retry resets. |
| 256 MiB preparation | What the runner materializes: inflation/delta reconstruction of the staged objects, exported/evidence writes, 4 KiB allocation rounding and directories charged before writes. A conservative 64 KiB runtime/lifetime reservation is charged before creation. The staged objects and the export are both on disk until the staging is deleted, so both are charged. No retry resets. |
| 2 MiB diff | Each endpoint diff, incrementally before adding lines; combined serialized evidence has an additional 3 MiB ceiling. |
| 1 MiB response/data field | HTTP headers, each metadata/prior-state input and the serialized-evidence ceiling above the diff. The ref advertisement instead shares the cumulative preparation envelope. No compare API payload is used. |
| Paths | 1,024 UTF-8 bytes, 32 components, 255 bytes/component; no absolute, drive/UNC, traversal, backslash, control, `.git`, ambiguous Windows reserved/trailing-dot names. |
| 300 seconds | One monotonic preparation deadline, including all transfers, expansion, export and effective-access probe; raw HTTP header/chunk-line reads recheck it between bytes and reset socket timeout to the remaining lifetime; cancellation checked between bounded operations. The job supervisor terminates blocked processes on timeout/lease loss/shutdown. |

Trusted limit overrides can only lower these fixed limits. The accounting is deliberately
conservative: cumulative transfer, expansion and writes are charged even when earlier staging
has already been deleted, but a byte is charged to the budget of the resource it uses, once. Before #296 the wire bytes, the inflated bytes, the rounding and the export write were all charged to one 256 MiB budget, so a repository of about 140 MB of blobs needed about 290 MiB and could never be prepared. The maxima were not raised: the oversized blobs are no longer downloaded and the two resources have separate maxima. Download accounting is application-level HTTP/Git bytes, not TLS/TCP
record overhead. Disk accounting bounds runner-written content and rounds file/directory
allocations; it is not a filesystem-wide quota on unrelated container activity. #197 owns engine
scratch; whole-job/container memory and deployment capacity are measured by hand
(`docs/dynamic-review.md`, "Capacity").

Only eligible regular `100644`/`100755` tracked blobs are exported, without executable bits.
Symlinks, submodule/gitlink and other modes are omitted; Git does not represent tracked hardlinks,
and exports of identical blobs are separate files. No filter, hook, textconv, submodule or LFS
payload is executed/fetched. UTF-8 text with disallowed control bytes, NUL or invalid encoding is
binary and omitted. Known credential paths (including `.env*` except `.env.example`, private keys,
credential stores and recognized credential-shaped names) are denied before hydration/reads.
Known job credentials, token shapes, private-key blocks and credential assignments are redacted
in file text, diffs, metadata and prior state. A private-key block is redacted from its `BEGIN`
line to the next valid `END` line however long it is; an unterminated block is redacted to the end
of the text. Harmless example placeholders remain readable.

Omissions use `OmissionReason` stable values and a bounded explicit manifest. A changed or deleted
file needed by either comparison that is **denied or unsafe** (engine discovery, credential path,
symlink or other non-regular mode), **binary** or **over 512 KiB** is excluded from the checkout and
the diff and listed in the evidence `skipped` array with the stable reason (`engine_discovery`,
`credential_path`, `unsafe_mode`, `binary` or `too_large`), so the review can say the file was not
reviewed; it never fails the job (#296). Before #296 a changed denied path failed the whole run,
which made any repository that tracks such a path unreviewable (with an unknown merge base every
head path counts as changed). Skipping is as safe as failing: a denied path is never read,
exported, diffed or wanted by name, so nothing of it reaches the engine; the failure only protected
completeness, which the `skipped` list now states. A file is skipped per comparison: only when one of the two sides
of that diff is binary or oversized, so a binary earlier revision does not hide a text change from
the base-to-head diff. Unchanged exclusions remain visible in the manifest; consumers
must retain that limitation rather than claim that excluded content was reviewed. No excluded
config/plugin payload is relocated into another exposed file. Sanitized prior state is retained,
including in full mode; checkout never infers a finding resolution. #199 owns parsing and lossless
reconciliation of that state.

## Comparison

Evidence records exact head/base/merge-base/prior identities. The base-to-head diff is the exact
two-dot comparison between the **merge base of the queued head and the base ref** and the head tree
(GitHub's "Files changed" semantics): base-only commits added after the fork never appear as
reversed changes and a base-only oversized or binary file never fails the job. The merge base is
found with a bounded, commits-only ancestry walk (`deepen`, `filter tree:0`, up to 4,096 commits)
under the same budget; the walk does not run without the `filter` capability. If no merge base is
found, checkout declares a full review of the head (the head tree added in full) instead of guessing
a base. The incremental diff independently compares the exact previous reviewed tree and current
head tree. Line-level unified hunks preserve file modes, CRLF and final-newline changes; renames
appear as exact deletion/addition pairs without a similarity heuristic. These are endpoint/two-dot
comparisons, including orphan force pushes. If a previous commit/tree/blob is explicitly
unavailable, mode is `full`, previous evidence is empty and prior findings remain. Malformed
transfers, provider failures or global quota breaches are failures, never relabeled as full
success. No GitHub three-dot compare response, 300-file truncation or absent finding can establish
completeness or resolution.

## Versioned discovery exclusions

`DENY_LIST_VERSION = opencode-v1.19.0-1` was checked against the merged
[#85 research](spike/85-opencode-dynamic-review.md), upstream
[config](https://opencode.ai/docs/config/), [plugins](https://opencode.ai/docs/plugins/),
[agents](https://opencode.ai/docs/agents/) and [skills](https://opencode.ai/docs/skills/) documentation,
and the pinned v1.19.0
[legacy paths](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/config/paths.ts),
[core location loader](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/core/src/config.ts),
[external plugin loader](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/core/src/config/plugin/external.ts)
and [compatible skill discovery](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/skill/index.ts).
At every depth, case-insensitively and before blob hydration/reads, omit:

- Entire `.opencode` trees: singular/plural agent, mode, command, plugin, tool, skill and theme
  directories, config, package manifests/locks, dependencies and all other payloads.
- `opencode.json`, `opencode.jsonc`, and conservatively `tui.json`/`tui.jsonc`.
- `.claude/skills` and `.agents/skills` compatibility trees.

Eligible AGENTS.md, CONTRIBUTING.md, CLAUDE.md and CONTEXT.md remain bounded, redacted untrusted
read-only evidence. Stock nearby AGENTS.md injection is an accepted residual risk, not something
these exclusions or flags disable. #198 supplies the immutable core. Config discovery flags are
defense in depth; stripping and the container/user/proxy boundary remain required. Stock OpenCode
is unmodified. No bubblewrap/user namespaces, provider-specific routing or host tuning is added.

## Verification and rollout limits

`runner/tests/unit/test_checkout_{policy,limits,objects}.py` prove lexical/content/pack boundaries.
`runner/tests/integration/test_dynamic_checkout.py` uses real `file://`-backed upload-pack fixtures
and the loopback smart HTTP server in `fakes/dynamic_git/`. Its actual-uid probe uses a root helper
(or passwordless `sudo -n` on a non-root Linux test host); absence of that prerequisite fails
loudly, never skips. The probe runs here inside the development container and on CI's Linux host;
the image smoke test (`docker/smoke/runner.sh` in `dynamic` mode, #202) covers the final runner image,
its users and the startup self-check, and the privileged suite covers the users and proxy-only
egress.

Remaining rollout validation: live installation-token access to private fork PR refs, unadvertised
eligible blob wants and named GHES versions; no-filter servers and force pushes are covered locally
but are not live-service certification. Activation stays off until the epic's remaining gates.

## Failure reasons and metrics (#296)

Every `CheckoutError` carries a stable `CheckoutReason` next to the `ErrorCode` a caller branches on:
`invalid_request`, `ref_moved`, `ref_missing`, `protocol`, `pack_invalid`, `object_missing`,
`tree_invalid`, `entries`, `path_invalid`, `budget_transfer`, `budget_preparation`, `budget_exposed`,
`diff_too_large`, `input_too_large`, `cancelled`, `timeout`, `transport`, `isolation`, `context`. The
reason is never free text. It reaches the run result as `errorReason`, the first line of the log tail
(`checkout_incomplete [budget_preparation]: ...`), the runner's `finished:` line, the bare verdict the
runner sends when the app refuses the full result (400/413), and the Runs view, which translates it to a
sentence.

Every Dynamic run logs one line of checkout metrics, for a failed run as well as a good one:
`checkout: transfer=<bytes> preparation=<bytes> exposed=<bytes> entries=<files of the head tree>
omitted=<reason>:<n>,... skipped=<reason>:<n>,...`. Counts and stable names only, never a path. The
three byte counters only grow, so their final values are the peaks.

A Dynamic finding that names a file the export does not hold is dropped and counted
(`finding_path_not_exported`, in the run's log line) instead of failing the run.
