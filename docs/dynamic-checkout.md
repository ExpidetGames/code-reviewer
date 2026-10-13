# Bounded Dynamic Review checkout

Issue #196 supplies trusted preparation in
`runner/src/code_reviewer_runner/dynamic_review/`. It launches no OpenCode engine and does not
advertise `opencode`, enable the instance gate, compose a prompt or publish a comment. Those
boundaries remain with #197–#202. The current runner image still runs as its existing non-root
runner user; the root supervisor and dedicated engine users must be supplied by #202 before
this preparation can be used for an agent.

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
#197/#202 must still supply proxy-only egress and whole-engine supervision before launch.

## Exact acquisition and hard bounds

The installation token is an in-memory HTTP authorization header of the trusted supervisor.
It is never a URL, Git config, argv, environment value or credential file. The URL is constructed
from the validated base repository identity and trusted API host (GitHub or GitHub Enterprise),
and must match the PR repository. No fork-supplied clone URL or repository command is followed.
HTTP redirects and inherited proxies are not used. Provider response bodies never become errors
or logs; auth, forbidden, rate limit, missing repository and availability failures keep the
existing stable codes. Stale/missing/malformed head or incomplete required evidence is
`checkout_incomplete`; deadline expiry is `timeout`.

A small Git smart HTTP v0 client reads bounded advertisements and explicitly wants the queued
commit, obtained from `refs/pull/<number>/head` in the **base** repository, and the base-ref snapshot.
Both advertisement and fetched object identity are verified; the PR ref is checked again before
returning preparation. Depth one and `blob:none` are requested when supported. Ignored filters
are allowed only within the same hard envelope. Missing eligible blobs are explicitly wanted
in batches of at most 32 only after all endpoint paths/modes pass policy.

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
| 512 KiB/file | Blob size before content read/materialization; redacted output checked again. Oversized unchanged input has an omission; required changed input fails. |
| 64 MiB exposed content | All exported regular content plus serialized evidence, including manifest, metadata and prior state. |
| 256 MiB preparation | One cumulative budget across HTTP status/headers/chunk framing/body or offline Git transfer, every hydration, inflation/delta reconstruction and exported/evidence writes; 4 KiB allocation rounding and directories charged before writes. A conservative 64 KiB runtime/lifetime reservation is charged before creation. No retry resets. |
| 2 MiB diff | Each endpoint diff, incrementally before adding lines; combined serialized evidence has an additional 3 MiB ceiling. |
| 1 MiB response/data field | Advertisements, HTTP headers and each metadata/prior-state input, plus the whole exposed-content limit. No compare API payload is used. |
| Paths | 1,024 UTF-8 bytes, 32 components, 255 bytes/component; no absolute, drive/UNC, traversal, backslash, control, `.git`, ambiguous Windows reserved/trailing-dot names. |
| 300 seconds | One monotonic preparation deadline, including all transfers, expansion, export and effective-access probe; raw HTTP header/chunk-line reads recheck it between bytes and reset socket timeout to the remaining lifetime; cancellation checked between bounded operations. The job supervisor terminates blocked processes on timeout/lease loss/shutdown. |

Trusted limit overrides can only lower these fixed limits. The accounting is deliberately
conservative: cumulative transfer, expansion and writes are charged even when earlier staging
has already been deleted. Download accounting is application-level HTTP/Git bytes, not TLS/TCP
record overhead. Disk accounting bounds runner-written content and rounds file/directory
allocations; it is not a filesystem-wide quota on unrelated container activity. #197/#202 own
engine scratch, whole-job/container memory and deployment capacity.

Only eligible regular `100644`/`100755` tracked blobs are exported, without executable bits.
Symlinks, submodule/gitlink and other modes are omitted; Git does not represent tracked hardlinks,
and exports of identical blobs are separate files. No filter, hook, textconv, submodule or LFS
payload is executed/fetched. UTF-8 text with disallowed control bytes, NUL or invalid encoding is
binary and omitted. Known credential paths (including `.env*` except `.env.example`, private keys,
credential stores and recognized credential-shaped names) are denied before hydration/reads.
Known job credentials, token shapes, private-key blocks and credential assignments are redacted
in file text, diffs, metadata and prior state. Harmless example placeholders remain readable.

Omissions use `OmissionReason` stable values and a bounded explicit manifest. A changed or deleted
file needed by either comparison that is excluded by policy fails with `checkout_incomplete`.
Unchanged exclusions remain visible in the manifest; consumers must retain that limitation rather
than claim that excluded content was reviewed. No excluded config/plugin payload is relocated into
another exposed file. Sanitized prior state is retained, including in full mode; checkout never
infers a finding resolution. #199 owns parsing and lossless reconciliation of that state.

## Comparison

Evidence records exact head/base/prior identities. The current diff compares the base-ref snapshot
tree and exact queued head tree. The incremental diff independently compares the exact previous
reviewed tree and current head tree, without a merge-base/ancestry assumption. Full-file unified
hunks preserve file modes, CRLF and final-newline changes; renames appear as exact deletion/addition
pairs without a similarity heuristic. These are endpoint/two-dot comparisons, including orphan
force pushes. If a previous commit/tree/blob is explicitly unavailable, mode is `full`, previous
evidence is empty and prior findings remain. Malformed transfers, provider failures or global
quota breaches are failures, never relabeled as full success. No GitHub three-dot compare response,
300-file truncation or absent finding can establish completeness or resolution.

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
#202 still owes tests of the final runner image, its users, mounts and proxy-only egress.

Remaining rollout validation: live installation-token access to private fork PR refs, unadvertised
eligible blob wants and named GHES versions; no-filter servers and force pushes are covered locally
but are not live-service certification. Activation stays off until the epic's remaining gates.
