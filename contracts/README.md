# Contracts

Machine-readable descriptions of the interfaces that two parts of the system share. A contract file
is the single source of its format: the code on both sides is checked against the file, never the
other way round, so a change to the format has to change the file and both sides.

| File                            | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner-api.v1.json`            | The wire format of the runner API v1 (JSON Schema, draft 2020-12): the claim request, the claim response, the heartbeat and complete requests and responses, the Dispatcher's calls (release, version, the report of a created VM `VmStartRequest`/`VmStartResponse`, #493) and every error. The `$defs` are the named bodies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `operator-api.v1.json`          | The wire format of the operator API (#275, `app/src/operator-api/README.md`): the workspace list, the entitlements of a workspace and of the instance default (with the optional `modelAccess`, #428: the catalog entries a workspace on the operator's key may use; left out of a write it keeps the stored value, and a writer sends it only after every app instance is upgraded; **optional in an answer** too, so a strict reader accepts the answers of an instance that is not yet upgraded and reads a missing field as `{"catalogEntries": null}`), the write body, the usage feed, the usage of a workspace and its summary (#278), the count of runs that settled without a known cost per workspace and key mode (#385), the plan handoff (the redemption of a handoff token and the address of the plan management page, #284), and every error. For an external service that sets limits; it exists only while the app has an `OPERATOR_API_TOKEN`. `examples/operator-api/<Definition>.json` holds one valid example per body. |
| `anthropic-models.v1.json`      | The Anthropic (Claude API) model list (#511): per model the exact id, name, context window, max output, Anthropic's retirement commitment, the flags that decide which request parameters it takes (`temperature`, `topP`, `tools`, `forcedToolChoice`, `thinkingDisabled`), the review kinds it can serve, and the prices in USD per million tokens as decimal strings (input, output, cache read, cache write for 5 minutes and 1 hour, and the higher tier of Haiku 5.5 for a prompt over 100000 tokens), with the day it was read and the source pages. The single record of the list: the app (`app/src/llm/providers/anthropic/models.ts`) and the runner (`runner/src/code_reviewer_runner/anthropic_models.py`) each keep a typed copy that a test compares with this file. Not an interface of the runner API, and no schema: it changes when Anthropic changes its lineup or prices.                                                                                                                                                |
| `examples/<Definition>.json`    | One valid document per body. Both test suites validate them, so an example can never drift from the schema. They hold dummy values only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `worker-api.v1.json`            | The Worker contract of the hosted deployment (#316, #318): job details, heartbeat and result under `/api/workers/v1`, with the per-job credential (`crj_…`, valid for one job only). Reuses `RunnerJobInput` and `RunnerResult` of the runner API. `examples/worker-api/<Definition>.json` holds one valid example per body.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dispatch-webhook.v1.json`      | The signed wake-up call the app sends a Dispatcher after a job is enqueued: the closed body (`DispatchWebhook`), the headers and the signing rule in its description, the answers, the stop call the app sends when a job's claim ends (#487: `DispatchStop` and its two answers `DispatchStopAccepted`, `DispatchStopIgnored`; #493: the accepted answer names the stopped VMs in the optional `vms`), and the shape of `dispatch-signing-vectors.json` (`DispatchSigningVectors`). `examples/dispatch-webhook/<Definition>.json` holds the examples.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `dispatch-signing-vectors.json` | Requests as a receiver sees them (valid, previous key, wrong key, old or future timestamp, tampered body, id or timestamp, unknown key id, malformed headers) with the verdict each must get. Dummy keys only. Every consumer computes the verdict itself and compares.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `worker-container.v1.json`      | The hardened container spec: user, `cap_drop` and `cap_add` with startup-only markers, security options, read-only root, tmpfs mounts with options, memory/swap/pids limits, stop timeout, allowed environment names, forbidden keys, and what a launcher may override per Worker kind (`WorkerContainerOverrides`: the memory limit). The schema is the hardening floor: `privileged`, binds, volumes, devices, host namespaces, host networking, `seccomp=unconfined`, a writable root or a credential in the environment have no way in. `examples/worker-container/WorkerContainerSpec.json` is the spec and equals `compose.dynamic.yml`.                                                                                                                                                                                                                                                                                                                                                                                                |
| `probe-verdict.v1.json`         | The capability probe of the hosted deployment (#331): `ProbeVerdict`, the one line the Worker image's `probe` mode prints (engines, and the stable `ProbeReason` list of the startup self-check when `opencode` is missing), and `ProbeReport`, what `POST /probe` of the Dispatcher answers (status `passed`, `denied` or `failed`, `ok`, the engines it advertises, the reasons or a stable failure code, the time). Engines, stable reasons and codes only: no path, no value, no text. `examples/probe-verdict/<Definition>.json` holds the examples.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `dynamic-review/schema.v1.json` | The neutral findings of a Dynamic Review (#195), before the runner renders them: opaque id, P0–P3, confidence, bounded title/body, a lexically safe repository-relative path, a line range (ordering is the runner's semantic check), evidence references, and the reviewed SHA. Resolutions of earlier findings sit on the run envelope (`resolvedIds`), so a run that leaves no current finding can still report them. No permission, provider, routing, endpoint or command field. `dynamic-review/example.v1.json` and `example-resolved.v1.json` are validated by both suites.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Who checks what

- **App** (`app/integration-tests/compatibility/runner-api-contract.integration.test.ts`, with Ajv):
  the real answers of the routes are valid against the file; the hand-written checks on what a runner
  sends give the same verdict as the file for a set of good and bad bodies; the lists the app keeps
  in TypeScript (`app/src/runner-api/contract.ts`: error codes, commands) equal the lists in the file.
- **Runner** (`runner/tests/contract/test_runner_api_contract.py`, with `jsonschema`): the examples are
  valid, and the rules the runner relies on hold (the job input is closed, because the runner refuses
  unknown fields; the only command is `review`; a previous release's review payload — the legacy `args`
  and the removed tools' env families — is still accepted; the error code rules of a result).

## The operator API contract

`operator-api.v1.json` is checked by the app only (`app/integration-tests/compatibility/operator-api-contract.integration.test.ts`, with
Ajv): the examples are valid, the real answers of the API (success and every kind of error) are valid, the
bodies the app accepts and refuses agree with `EntitlementsWrite` for the cases the schema can express (the
rest, such as a start in the future or backwards, is the app's rule and documented in the definition), and the
error codes, key modes, limit names and id pattern equal the app's lists. The version is in the path
(`/api/operator/v1`) and in every body (`"version": 1`); the file only grows in ways readers may ignore, and a
reader ignores fields it does not know. A field that is new in an answer is optional in the schema until every instance sends it (`modelAccess`, #428: a strict reader accepts an answer without it; a write that carries it is refused by an instance of an earlier release, so upgrade first). It identifies workspaces by id and slug only. No runner reads it. The plan handoff
definitions (#284: `HandoffRedeemRequest`, `HandoffRedeemResponse`, `PlanManagementWrite`, `PlanManagementResponse`) carry
workspace ids, the slug, a role and an opaque user id, never an email or a name; a token is valid for five minutes and
once, and a redeem of anything else is the one `invalid_token`. The usage
definitions (`UsageItem`, `UsagePage`, `UsageSummaryResponse`) carry no repository, pull request, branch, title or person,
and a managed tier only by its name; a test pins the exact field list. A reader of the feed keeps the `nextCursor` it is given and treats the
record `id` as the idempotency key (the definition says so).

### The removal of `/model-tiers` (#434)

Version 1 of the operator API "only grows", and the rule for a breaking change is a version 2 with its own file. #434 removes
`GET|PUT /api/operator/v1/model-tiers` and its definitions (`ModelTiersWrite`, `ModelTiersResponse`, `ModelTierAnswer`,
`ModelTierModels`, `ModelId`, the five error codes `model_id_invalid`, `MODEL_UNKNOWN` and `DYNAMIC_MODEL_*`) from
`operator-api.v1.json` and their examples from `examples/operator-api/`, **without a version 2, a deprecation stage or a
`410`**. This is the exception that ADR 0005 (decision C1) records, and the reasons are these:

- **The route cannot do anything any more.** Since #432 the claim reads a catalog entry and never the tiers. A `PUT` that is
  still answered `200` would look like a working configuration and change nothing, which is worse for an operator than a
  missing path. A deprecation stage would keep that lie for a release.
- **The one caller is the operator's own tooling**, behind `OPERATOR_API_TOKEN`; there is no published client of this route
  and no other consumer of the file. The configuration it wrote has been turned into catalog entries by the migration
  (`app/src/db/migrations/20261018170000_migrate_model_tiers_to_catalog.ts`), so nothing is lost by the removal. Whether an
  external caller exists is a read-only check of the access log of the production instance, which is the maintainers' to do
  before the release (a follow-up in the pull request); a caller found there is the trigger for a facade, which this series
  does not build.
- **A `410` would need a new error code and a handler to keep**, to tell a caller what the path's absence already says. With
  a valid token the answer is the `404 not_found` of any path the API does not have, validated against `ErrorResponse` by a
  test; without a valid token it is the `401 unauthorized` of every path (the credential is checked first), also by a test.
- The file still grows for a reader that ignores unknown things: `UsageItem.modelTier` **stays, required and nullable**
  (null for every run since the catalog), so a strict reader of the feed keeps working. Nothing else in the file changed
  its meaning.

| Caller / peer                                                  | Before #434                                 | After #434                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Operator tooling that calls `/model-tiers`                     | `200` (since #432 without effect)           | `404 not_found` with a valid token, `401 unauthorized` without one; set the models as catalog entries in the admin portal |
| Reader of the usage feed (strict or not)                       | `modelTier` present, null for catalog runs  | the same: present, null for every run since #432; old rows keep their tier name                                           |
| Client that branches on `ApiErrorCode`                         | may see the five tier codes                 | never sees them; the codes are out of the enum (a client that lists them still works)                                     |
| Runner, Worker, Dispatcher                                     | `RunnerJobInput` as it is                   | unchanged: no runner or Worker contract changes (the model reaches them as `llm.model`, as ever)                          |
| App of the previous release next to a new one (rolling deploy) | reads `managed_model_tiers` and `modelTier` | the data is still there (the migration only adds), so the old instance keeps working; see the pull request for the window |

The old setting `managed_model_tiers`, the `modelTier` members of the stored settings and the column `usage_records.model_tier`
stay in the database for one release (a migration only adds; a removal waits one release,
`docs/deployment-vercel.md`, section 5.6). Their deletion is a later forward-only migration.

## The hosted deployment contracts (#316, #318)

The App, the Dispatcher (TypeScript) and the Worker (Python) agree on these files; none imports another's source.

- **Additions to `runner-api.v1.json`** (all optional, so a previous-release reader and writer keep working):
  `ClaimRequest.jobId` and `ClaimRequest.maxRunning`; the claim feature `worker_credential`, which selects
  the split answer `SplitClaimResponse` (the per-job credential, **no job input and no secrets**; without the
  feature the answer is the legacy `ClaimResponse`, unchanged); `ReleaseRequest`/`ReleaseResponse`;
  `VersionResponse` (the features of the app, so a Dispatcher or a Worker detects an app that is too old);
  `JobStateResponse` (#364, `GET /api/runners/v1/jobs/{id}`: the status of a job and nothing else, for the Dispatcher's
  reaper; not a required feature, an app without it is a `404` the reader treats as "state unknown");
  the API error codes `WORKER_CREDENTIAL_INVALID` and `RUNNER_JOB_ENDED`. The Worker API and the split claim are
  served since #320 (`app/src/runner-api/README.md`, "The Worker API"); claim by job id, the pool cap, release and
  version since #322 ("The Dispatcher's calls" there). A previous-release app ignores the new claim
  fields and has no version call, so a Dispatcher reads `/version` first and does not claim from an app that
  lacks the features it needs; a previous-release runner never names `worker_credential`, so it is not affected.
- **Generated types.** `make generate-contracts` writes TypeScript types of `runner-api`, `worker-api`,
  `dispatch-webhook` and `worker-container` into `app/src/contracts/` and `dispatcher/src/contracts/` (the
  same content twice, committed). `make check-contracts`, part of `make verify`, fails with the command to
  regenerate while a committed file differs from the schemas, is missing or has no schema any more. Do not
  edit the files by hand.
- **No cross-project imports.** The Dispatcher never imports anything under `app/` (or `runner/`), the app
  never imports the Dispatcher: `app/src/ci/project-boundaries.test.ts` fails on such an import. What is shared
  is the contract files, the generated types and `fakes/`.
- **The fake App** (`fakes/dispatcher-app/`) speaks the Dispatcher API and the Worker API with the bodies of the
  examples, and fails on script (status, body, delay, lost lease). The Worker, the Dispatcher and the
  end-to-end journeys run against it. Its answers are checked against the schemas in
  `app/integration-tests/fakes/dispatcher-app.integration.test.ts`.

### The findings a review left open (#405)

Additive, so a previous-release reader and writer keep working: `RunnerResult.findings`, an optional `ReviewFindings`
(`open`, and `bySeverity` with `P0` to `P3`, or `null` for a Diff Review whose findings have no severity). It is the
count of the findings open **after** a successful run (a Dynamic Review carries the findings of earlier runs over, PR-Agent
keeps a record of the active ones), and the app decides the review verdict it submits from it
(`app/src/check-runs/README.md`). A runner that does not send it, a failed result, or a count that cannot be known
means no verdict. The app stores it with the result and ignores it when it is absent.

### The call trace of a Dynamic Review (#541)

Additive, so a previous-release reader and writer keep working: `RunnerUsage.callTrace`, an optional `RunnerCallTrace`
(`truncated`, `modelCalls` and `toolCalls`, at most 100 of each: the first ones). Per model call it has `index`, `tMs`
(since the run started), `promptTokens`, `cacheRead`, `cacheWrite`, `completionTokens` and `costUsd` (each `null` when
the provider reported none), `finishReason`, `final` (the wrap-up or recovery call) and `tools` (the names the answer
asked for, with counts); per tool call `index`, `name`, `resultBytes` and `isRepeat` (the same tool with the same
normalised arguments already ran in this job). **No path, argument, tool result or model text is in it**, and a tool
name that is none of the engine's is `other`. A runner of an earlier release sends none (an app reads that as "no
trace"); an app of an earlier release ignores it. Not nullable: a runner leaves it out. The runner checks it against
this shape before it sends it and leaves out one that does not fit, keeping the usage; the app refuses a result whose
trace does not fit (`app/src/runner-api/call-trace.ts`), as the schema does. The Runs detail of a workspace and the
admin portal's run view show it (`app/src/runs/README.md`, `app/src/admin/README.md`).

### A superseded run (#396, #397)

Additive, so a previous-release reader and writer keep working: the claim feature `supersede` (a runner or Worker
that names it understands the heartbeat field below); the heartbeat answer's optional `job.superseded` (`true` when
a newer push replaced the run; absent means not superseded, and `examples/HeartbeatResponse.json` shows the field
as `false`; a runner that never named the feature never gets it); the result code `superseded`; the status
`superseded` in the answer of a result and in the job state (`draining` there while the claim still holds); and
`SupersedeTiming`, the numbers behind it, stated once for both sides (the heartbeat maximum, the longest model
request, the drain, the margin before the lease, the claim and the report grace). It is not part of any request or
answer: the app test and the runner test each hold their constants equal to it.

A heartbeat that says `superseded` names the end of the claim in `job.leaseExpiresAt`: the app sets it once, at the
push, to `claimSeconds` after it, and heartbeats do not extend it. The Worker ends its drain `killMarginSeconds`
before it, so the result is reported while the claim holds.

### The probe contract (#331)

`probe-verdict.v1.json` has no generated types: the reader, the Dispatcher, keeps the closed list of reasons in
`dispatcher/src/probe/verdict.ts` and a test (`verdict.test.ts`) holds it equal to the file's `ProbeReason`; the
writer, the runner, is checked by `runner/tests/contract/test_probe_verdict_contract.py` (the examples are valid, the
runner's `SelfCheckReason` values are exactly the file's list, what `probe` prints is a valid `ProbeVerdict`, the verdict
is closed). The Dispatcher reads a verdict leniently (an unknown field is ignored, an unknown reason is dropped, never
echoed) and `POST /probe`'s answers are checked against `ProbeReport` in `dispatcher/src/probe/route.test.ts`. A new
`SelfCheckReason` is added to the file, to the Dispatcher's list and to the runner in one pull request. `ProbeFailure`, the closed list of codes of a probe that gave no verdict, is the Dispatcher's own (`dispatcher/src/probe/failure-codes.ts`, held equal to the file by `failure-codes.test.ts`).

### Who checks what (hosted deployment)

- **App** (`app/integration-tests/compatibility/hosted-contracts.integration.test.ts`, with Ajv): every
  example is valid; the dispatch webhook is closed (an unknown or a secret-shaped field is refused); an
  additive field of a Worker API answer is ignored, while `RunnerJobInput` stays closed; the container spec
  refuses every weakening; the signing vectors give their verdicts with the reference verifier of
  `fakes/dispatcher-app/signing.ts`; and the real routes will check their answers against these files when
  #320 and #322 land. `app/src/ci/contract-types/generate.test.ts` checks that the generated types are the
  committed ones; `app/src/runner-api/contract.ts` keeps the API error codes equal to the file.
- **Runner** (`runner/tests/contract/test_hosted_contracts.py`, with `jsonschema`): the same examples, the same
  closed objects and the same vectors, with a verifier written independently of the TypeScript one. `runner/tests/contract/test_worker_api_client_contract.py` runs the
  Worker's API client (#323) against a recording server that answers with the examples: the routes, the credential only in
  `Authorization`, request bodies valid against the schemas, an additive field of an answer ignored.
- **App, sending side** (#326; `app/src/dispatch/`): `request.test.ts` builds the request the app sends and holds it to
  the example and to the signing vectors (the signature of every vector that verifies is reproduced; the reference
  receiver of `fakes/dispatcher-app/signing.ts` accepts the app's request and rejects a tampered body, an old
  timestamp and an unknown key id); `service.integration.test.ts` sends to a stand-in receiver
  (`app/src/test-support/fake-dispatch-receiver.ts`) that verifies every call with that reference.
- **Dispatcher** (`dispatcher/`, #327; `dispatcher/src/contracts.test.ts`, `src/triggers/signature.test.ts`):
  validates the same examples with Ajv, checks that its closed webhook body and its reading of the split claim
  answer agree with the schemas, and runs every signing vector against its own receiver and the reference verifier.
- **The hardened container spec and its renderer** (#325). `examples/worker-container/WorkerContainerSpec.json`
  is the spec. It is kept equal to `compose.dynamic.yml` and to the `runner-dynamic` service of
  `compose.coolify.yml` by `app/src/ci/worker-container-parity.test.ts`, which translates each compose
  service into the spec's shape and fails on a changed flag, a missing or added capability, tmpfs or
  limit, or any key that could weaken the isolation (`privileged`, `volumes`, `network_mode`, `devices`,
  `sysctls` and the like) in either place. The Dispatcher ships the same values as
  `dispatcher/src/launchers/container-spec.ts` (a test pins it to the example) and renders them to
  `docker run` arguments in `dispatcher/src/launchers/container.ts`. The renderer refuses a spec that
  weakens the container (stable codes), takes the credential on stdin only, and lets a launcher change
  the memory limit per Worker kind and nothing else (`WorkerContainerOverrides`; the swap stays equal to
  the limit). A change of a flag is made in the spec, both compose files and the dispatcher copy in one
  pull request. `WorkerContainerLauncherAdditions` (`examples/worker-container/`) is the one explicit per-launcher
  addition (#345): the two `net.ipv6.conf.{all,default}.disable_ipv6=1` sysctls the Sandbox variant renders as
  `--sysctl` because the Sandbox kernel only supports the `ip` nft family (the Dynamic-Worker's fallback
  ruleset does not see IPv6, so IPv6 must be off, and the container's `/proc/sys` is read-only). The shared spec
  and both compose files have no sysctl (the parity test fails on one), so self-hosted full-mode hosts do not
  change. `docker/sandbox/vm-prepare.sh` is the host preparation a Sandbox VM needs before its
  first `docker run` with limits (the cgroup root fix of spike #317, run before `dockerd` on every VM start).

## Rules of version 1

- The version is in the path (`/api/runners/v1/...`) and in every response body (`"version": 1`).
  A change that breaks a reader makes a version 2 with its own file; this file only grows in ways
  readers may ignore. #203 follows this: `Command` narrows to `["review"]`, and the removed tools'
  legacy review fields (`args`, `PR_DESCRIPTION__*`, `PR_CODE_SUGGESTIONS__*`, `PR_QUESTIONS__*`) stay
  in the schema so a new runner still accepts a review payload a previous-release app sends.
- A reader ignores fields it does not know. The one exception is `RunnerJobInput` (the job the runner
  reads on stdin), which is closed because the runner refuses unknown fields.
- Callers branch on error codes, never on messages. The codes the runner reports are listed in
  `KnownRunnerErrorCode`; the app accepts any code of the right form and stores one it does not know as
  `unknown` (the original stays in the stored result).
- A failed Dynamic Review checkout reports a stable `errorReason` next to the code `checkout_incomplete`
  (#296). The reasons are listed in `KnownCheckoutReason`; the app accepts any name of the right form
  and shows an unknown one with a general sentence. The reason is optional, so a runner and an app of
  different versions keep working.
- Secrets (`git.token`, `llm.apiKey`, `leaseToken`) appear in the claim response and in requests that
  prove a claim, and nowhere else.
- #195 grows v1 without breaking a reader: the optional `ClaimRequest` body (`engines`), the optional
  `reviewKind`/`dynamic`/`base` fields of `RunnerJobInput` for a tagged Dynamic job, and the new
  `Engine`, `ReviewKind`, `DynamicReview`, `ClaimBase` definitions and Dynamic failure codes. A
  previous-release app ignores the claim body; a previous-release runner sends none (pr-agent only) and
  never receives the tagged fields, so its closed `RunnerJobInput` parsing is unchanged. The tagged
  union is enforced on both sides: a Dynamic job must carry `dynamic` and `base`, a Diff job (no
  `reviewKind`, or `"diff"`) must not, and a Dynamic `model` uses the same character pattern the runner
  accepts.
- #255 adds the optional `ClaimBase.attemptedShas`. The app leaves the key out when it is empty, but a
  runner from before #255 rejects it when present (`RunnerJobInput` is closed): update the runner
  before or together with the app. The reverse (a newer runner, an older app) is safe: absent means none.
- #257 adds the optional `ClaimBase.attemptedShasTruncated`: `true` when more heads qualified than
  `attemptedShas` holds. The app leaves the key out unless it is true (never sends `false`), and a runner
  from before #257 rejects it when present: update the runner before or together with the app. A newer
  runner with an older app is safe: absent means false, and the publisher stays fail-closed.

- #279 adds the optional `DynamicReview.capabilities` (`DynamicModelCapabilities`: the features, the
  context window, the output allowance and the unit prices the app read from the provider's model
  metadata) and the optional `ClaimRequest.features`. `RunnerJobInput` is closed, so a runner from
  before #279 rejects a `dynamic.capabilities` it receives. The rule is therefore the opposite of the
  two above: the **app** never sends the field unless the claim names the feature
  `dynamic_capabilities`. A new runner always names it; an old runner names no feature and gets
  exactly the previous payload; an old app ignores `features` and sends no descriptor, so the new
  runner uses its operator's description as before. Either side can be upgraded first and neither
  breaks the other. Unknown feature names are ignored (a newer runner may name features an older app
  does not know), unlike unknown engines. `golden` fixtures: `fakes/fixtures/dynamic-review-job.json`
  (without) and `dynamic-review-job-capabilities.json` (with the field), validated by both suites.

- #424 grows v1 without breaking a reader: `RunnerJobInput.llm.provider` changes from the enum
  `["openrouter"]` to a slug (`LlmProviderId`, `^[a-z][a-z0-9_]{1,31}$`), and `ClaimRequest` and the
  Worker API's details request (`WorkerJobDetailsRequest`, the query `?llmProviders=a,b`) get an
  optional list of the providers the caller can run. The list means "send me jobs for these", absent
  means `["openrouter"]`. `KnownLlmProvider` lists the slugs this release knows; the runner's
  registry, the app's registry and that list are compared by tests. The app only parses the list; it
  still sends `openrouter` only.

### Rolling out providers (#424)

The change is additive in both directions, so there is no deploy order to keep:

| App      | Runner / Worker | What happens                                                                                                                                                                    |
| -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| previous | previous        | unchanged                                                                                                                                                                       |
| previous | new             | the new runner sends `llmProviders` (claim) and `llmProviders=` (details); the old app ignores them and sends `openrouter`, which the new runner's registry holds               |
| new      | previous        | no list is sent, so the app reads `["openrouter"]`; it sends `openrouter`, which the old runner reads (`"provider": "openrouter"` is valid under both the enum and the pattern) |
| new      | new             | the claim list is parsed and validated, the details list is ignored for now; neither is used yet, so the job is the same                                                        |

The first app change that sends another provider (the claim issue of epic #420, #432) must deploy only after
every runner it serves advertises that provider: it sends a provider only to a caller that listed it
and ends the job with `llm_provider_unsupported` otherwise (`managed_model_unavailable` for a job on the operator's
key, whose entry names the provider). Until then the contract is as above.

#432 is that change. The caller that decides is the one that runs the job: a runner's list is its claim's
`llmProviders`, a Worker's list is the `llmProviders=` query of its details call. The claim of a Dispatcher is not
judged against a list it did not send (it says nothing certain about its Worker), so the Worker's fetch ends the job when
the provider is not listed. A caller that names no list can run `openrouter` only. A self-hosted instance with the own
key and the default provider sends exactly what it sent before (`provider`, `model`, `apiKey`, `maxTokens`, in this order).
The operator API's `UsageItem` gains the optional `catalogEntryId` and `catalogEntryName` (null for a run on the
workspace's own key and for runs from before the catalog); `modelTier` stays (required, nullable) and is null for new rows. The fields are optional in the schema and the definition is open, so a reader of
the previous release ignores them.

- #487 grows the dispatch webhook (still version 1: nothing a reader of the wake-up call reads has changed) with a second signed call, `POST /stop` on
  the same Dispatcher: `DispatchStop` (`{version: 1, type: "job.stop", jobId, stopId, sentAt}`, closed, at most 1 KiB), the answers
  `DispatchStopAccepted` (`202`, `stopping`) and `DispatchStopIgnored` (`200`, `no_vm` or `replayed`), and the examples
  `examples/dispatch-webhook/DispatchStop*.json`. The signing rule, the headers (`x-dispatch-id` carries the `stopId`), the
  clock and the key rotation are those of the wake-up call. A new `type` and a new path, never a changed field, so a
  receiver of the wake-up call is untouched. The wake-up answers do not change; the Dispatcher stops releasing a job whose
  container ended with an error after the hand-over (`worker_exited` of #375, a reason the runner API keeps for any caller that
  still sends it).

### Rolling out the stop call (#487)

The change is additive on the wire and has no deploy order. The App never lets a failed stop touch a job (best effort, a bounded
retry, one log line), and the Dispatcher's reaper (`GET /api/cron/reap-sandboxes`) and the VM timeout stay as the safety nets.

| App      | Dispatcher | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| previous | previous   | unchanged: the Dispatcher supervises the Worker after the hand-over and stops the VM itself (`waitUntil`, cut at the function limit)                                                                                                                                                                                                                                                                                                        |
| previous | new        | the App sends no stop; the Dispatcher holds no supervision, so the VM of a finished job is ended by **the reaper** (job not `running`, within five minutes) or the VM timeout. A Worker that dies is found by its lease (two minutes) **plus the next expiry pass**, which is the next claim or the sweep: on an idle instance up to about the sweep interval (2 hours), instead of by the container's exit code (`worker_exited`, seconds) |
| new      | previous   | the App signs a stop for every job that ended; the old Dispatcher has no `/stop` and answers `404`; the App logs `DISPATCH_STOP_UNSUPPORTED` once per job, does not repeat it, and the job is unaffected. The old Dispatcher keeps supervising and stops the VM as before                                                                                                                                                                   |
| new      | new        | the App's stop ends the VM within seconds of the job's end; the reaper finds nothing to do                                                                                                                                                                                                                                                                                                                                                  |

Upgrade the Dispatcher first (or together with the App): an App that is ahead only logs a `404` per job, and a Dispatcher that is
ahead relies on the reaper for a short time. Rolling the Dispatcher back to a release with supervision while the App is new is safe.

### Rolling out the billable minutes (#493)

The change is additive on the wire and has no deploy order; nothing in it can fail a launch, a job or a stop. It adds one route
(`POST /api/runners/v1/jobs/{id}/vm`, `VmStartRequest`/`VmStartResponse`), one value of `KnownAppFeature` (`vm_lifecycle`), one
optional field of an answer (`DispatchStopAccepted.vms`) and one table (`job_vm_runs`, new and empty, so an App of the previous
release on the same database never reads it). No existing field changes its meaning, and `VersionResponse.features` only grows
(a reader ignores a name it does not know). The Dispatcher does not require the feature (`REQUIRED_APP_FEATURES` is unchanged).

| App      | Dispatcher | What happens                                                                                                                                                                                                                                                                                          |
| -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| previous | previous   | unchanged: no VM is measured                                                                                                                                                                                                                                                                          |
| previous | new        | the Dispatcher reads the App's features, finds no `vm_lifecycle` and **sends nothing**; the stop answer's `vms` is read by nobody. The launch, the stop and the reaper are as before                                                                                                                  |
| new      | previous   | the App gets no report and the old Dispatcher's `202` names no VM: **no VM row is stored and the job measures 0 minutes**, the stop and the reaper work as before. Upgrade the Dispatcher **before billing is switched on**, or hosted jobs are measured as free                                      |
| new      | new        | the Dispatcher reports each VM right after it is created and names the stopped VMs in its stop answer: the App states `started_at`, `ended_at`, their sources and the minutes of every hosted job. Where the report or the answer is lost, the bounded backstop applies (`app/src/billing/README.md`) |

Upgrade the Dispatcher first (or together with the App). Rolling either part back is safe: the rows already stored stay and are
read by nothing that does not know them.

### Rolling out Dynamic Review (#195, finding 4)

A previous-release **app** ignores `review_kind` in its claim SQL: on a shared, migrated database it
could hand a Dynamic row to a runner as an untagged Diff payload — a silent fallback. It must never be
able to see a Dynamic row, so Dynamic jobs are only enqueued when the instance setting
`dynamic_review` is `{ enabled: true }` (default off; `dynamic-review-gate.ts`). With the gate off, a
Dynamic project's run is created `failed` with `dynamic_review_disabled`, visible in Runs.

Order:

1. Deploy every app instance with the version that routes by `review_kind` (this change). New runners
   are safe next to old apps.
2. Only then set `dynamic_review` to `{ enabled: true }`, once a Dynamic runner is deployed and
   advertises `opencode` (`docs/dynamic-review.md`, "Activation, step by step").
3. To roll back, keep every app instance on this gate-aware version while calling the instance
   settings repository's `set("dynamic_review", { enabled: false }, operatorId)`. Wait for commit:
   it stops new Dynamic enqueue and cancels **queued** Dynamic jobs with `dynamic_review_disabled`.
   **Running jobs are untouched**: their leases, heartbeats and PR slots stay valid until they finish.
   A release or lease expiry with the gate off fails the job with `dynamic_review_disabled` instead
   of requeueing it, including on the last attempt and for a requested delayed retry.
4. Keep the gate-aware app and runners serving the remaining leases until the Dynamic work finishes.
   Before downgrade, quiesce the runners and verify **all Dynamic engine processes have ended** as
   well as **zero Dynamic jobs in `queued` or `running` status**. If a runner is stopped, terminate
   and confirm cleanup of its engine processes before releasing its claims; handle any expired
   claims with the gate-aware app. Terminal database rows alone do not prove process termination.
5. Only after that boundary may an older app start serving claims. Keep the setting off throughout
   rollback; retain the forward migration and historical Dynamic rows. Resume compatible runners.

Removing the setting is equivalent to disabling it. Use the repository setter, not raw SQL, which
would bypass the lock and cancellation. The operator control is the instance admin's **Dynamic Review**
card on the portal's Instance page (`PUT /api/admin/settings` with `{ "dynamicReview": { "enabled":
boolean } }`, admin only, server side), which calls that setter; it asks the admin to confirm step 1
before it turns the gate on. It is off in every shipped configuration; the activation steps and the
rollback are in `docs/dynamic-review.md`.

### Queue lock order

All queue writers acquire locks in this order, held through commit:

1. **Instance gate transaction advisory lock `(195, 1)`**, before any repository, project, setting
   or job row. Enqueue, project writes and waiting-job cancellation take it shared;
   gate writes/removal and runner mutations (expiry, release, claim, heartbeat, completion and
   claimed cancellation) take it exclusive. This covers a missing gate row as well. A transaction
   that will run a runner mutation must take the exclusive lock first; never upgrade after row locks.
2. **Workspace-scoped repository, then project row**, for producers/settings that need them. Enqueue
   and settings saves retain the same repository `FOR UPDATE` lock from kind resolution through write.
3. **Job rows in ascending `id`**, reserving a multi-row transition's complete live candidate set
   before its first update. Expiry/claim reserve live jobs once before expiry passes and selection;
   disable reserves only queued Dynamic rows. Single-job lease operations touch only their own row.

Runner mutations briefly serialize on the gate, keeping drain and expiry from holding opposing job
rows and making the gate read/lease transition atomic. Locks cover database work only, never engine,
network or credential preparation. SQLite uses its immediate transaction write lock. Callers using
an existing transaction must take the appropriate gate lock before any row locks in that transaction.

The meaning of the calls (status codes, the lease, what happens on failure) is in
`app/src/runner-api/README.md`.

## The job options

- `env` (`JobEnv`) holds options of the PR-Agent tools, one option name per key: the key pattern is
  `PR_<TOOL>__<NAME>` with `NAME` made of upper case letters and digits in groups separated by one `_`
  (never a second `__`, never a trailing `_`). It is the runner's `_ENV_KEY`, and the app's
  `RUNNER_ENV_KEY_PATTERN` (a test compares the app's pattern with this file). Values are text of the
  type of the PR-Agent option (`"5"`, `"true"`); the runner refuses a value that does not fit. The app
  sends only `PR_REVIEWER__*`; a previous release's `PR_DESCRIPTION__*`, `PR_CODE_SUGGESTIONS__*` and
  `PR_QUESTIONS__*` are accepted and ignored (never handed to PR-Agent).
- The runner reserves some options for itself and refuses a job that sets them:
  `PR_REVIEWER__FINAL_UPDATE_MESSAGE`,
  `PR_REVIEWER__ENABLE_REVIEW_LABELS_SECURITY` and `PR_REVIEWER__ENABLE_REVIEW_LABELS_EFFORT`. The app never sends them (a test over the options of the
  review settings checks it).
- `llm.maxTokens` is the token budget of a review. `llm.fallbackModels` (at most five names) is accepted
  by the runner; the app does not send it until a chain is decided, and then `maxTokens` must fit the
  smallest window of the chain.

## Size of a result

A `complete` request must stay under 64 KiB serialized, or the app answers `413` and the job can never
finish (the lease runs out and it is tried again). The largest document the schema allows can exceed
that, because `logTail` (8192 characters) and `errorMessage` (2000) may hold characters that take
several bytes in JSON; with `ensure_ascii` (the runner's output mode) a non-ASCII character takes 6 to 12
bytes. The runner keeps `logTail` at 4 KB. The job loop (CR-29, `job_loop/reporting.py`) sends ASCII-escaped JSON, caps
the result **before** serializing and keeps the body under 48 KB (measured in that form).

## A shutdown is not a result

A runner that is shut down while it holds a job reports `ok: false, errorCode: "runner_shutdown"` with
`complete`. The app gives the job back to the queue instead of finishing it (the answer's `job.status`
is `queued`, or `failed` when that was the last allowed attempt).
