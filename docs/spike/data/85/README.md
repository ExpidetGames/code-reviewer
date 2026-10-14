# #85 spike artifacts

These are disposable experiments, not the Dynamic adapter or production test infrastructure. No
model execution is included in the CR-50 planning driver. The public catalog snapshot has no key.
Nothing here changes the app or runner. Production fake support belongs in fakes/ and the existing
runner test levels when #196/#197 are implemented.

## Offline Git and measurement-plan checks

From the repository root:

```sh
python3 -m unittest discover -s docs/spike/data/85 -p test_checkout.py
python3 -m unittest discover -s docs/spike/data/85 -p test_measurement_plan.py
python3 docs/spike/data/85/measurement_plan.py plan
uv --directory runner run ruff check ../docs/spike/data/85
uv --directory runner run pyright --project ../docs/spike/data/85/pyrightconfig.json
```

The Git tests create and remove their own local repositories. Their `file://` upload-pack transport
proves real filtering/ref/object behavior, not GitHub installation authorization, HTTP quotas or
GHES conformance. No network service or credentials are involved. The plan driver emits trial
specifications and cost assumptions, not requests. Its `blind` operation accepts an already redacted
neutral capture; scoring-key acquisition and authorized real execution are still prerequisites.

## Real pinned engine against a local SSE model

Prepare an isolated build context, containing only Dockerfile/probe.py/test_probe.py and the
checksum-verified executable. Use the URL, digest and version in [pin.json](pin.json). Downloads and
image/package preparation are separate from offline execution; never perform them in a test.
`RUNNER_IMAGE` may be set to an existing local runner image. To build a private base instead:

```sh
docker build -f runner/Dockerfile -t cr85-runner-base:local .
```

Then build this diagnostic Dockerfile with `--build-arg RUNNER_IMAGE=cr85-runner-base:local` and tag
`cr85-opencode-spike:local`. Do not add the upstream binary to git or modify production lockfiles.

The intended non-root user-namespace preflight on this research host fails. The separate mount/PID
diagnostic requires a root supervisor and namespace-local mount capability; the engine itself runs
as uid 10001 through setpriv. This is deliberately labeled **diagnostic**, not a supported production
configuration, capability or fallback. The engine runs inside bwrap with read-only repository/runtime mounts, private scratch and proc.
The required privileged setup differs from the non-root user-namespace architecture. A separate
bwrap child probes writes, outside paths and parent proc; do not infer non-root launcher support
from a uid 10001 child created by a root supervisor.

```sh
docker run --rm --pull never --network none --user 0 --cap-add SYS_ADMIN \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  --env CR85_ROOT_DIAGNOSTIC=1 --name cr85-engine-diagnostic \
  cr85-opencode-spike:local
```

The outer `--network none` namespace is the OS guard for Python, OpenCode/Bun, Git and every helper;
only loopback is available. No ports or host data are mounted. The script refuses other uid/route
contexts. No real key is used. Test values and file instructions are fixed dummies. The fake counts
all model requests and deliberately attempts denied tools. It checks root/nested rule discovery,
explicit rule reads, directory reads, StructuredOutput and owned-process cleanup; it does not measure
model quality. Stock nested injection and plugin execution are **regression demonstrations**, not safety.

The script emits a compact report without saving full prompts/model transcripts. It uses private
HOME/XDG/temp paths, a deadline on API operations and a finally block to terminate/reap its own
engine and shut down/join the fake server/sampler. Containers use --rm. Remove only tags created by
this task after recording sizes; do not prune globally. No browser or dev server is required.

The diagnostic uses dummy per-job Basic authentication for the engine control API. #197 still
must test private adapter/model-proxy endpoints and cross-job rejection with real proxy logic. It must also exercise a compiled review-mode patch: this experiment uses a
**stock** binary and demonstrates why the stock discovery behavior is incompatible with #193.

## Source and license boundary

Our scripts carry Apache-2.0 headers. The downloaded OpenCode binary is MIT and is not distributed
in this PR; its embedded dependencies require the separate provenance/license audit specified for
#202. The exploratory Dockerfile uses apt packages and an externally prepared binary. It is not the
final reproducible production packaging recipe. `make verify` does not execute the diagnostic image.

Recorded result: [probe-observation.json](probe-observation.json); three checks passed and the
plugin non-execution safety assertion failed. The **stock** experiment intentionally retains that
red assertion as an activation blocker; no skip/expectedFailure or permissive expectation is added.
This diagnostic is separate from make verify. #197 must make the same safety check green with
review-mode guards covering both legacy and core/location plugin/config runtimes.
The stock message-list encoding failure is recorded and diagnosed, not hidden behind an empty
message result. Tool evidence is collected from the local model wire requests and final response.
