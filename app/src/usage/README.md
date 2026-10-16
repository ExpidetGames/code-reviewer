# Usage records

One row per job in `usage_records` (migration `20261014150000_create_usage_records`; epic #268, issue #272): what the
run consumed, in a form that can be counted atomically with the decision to start a run and read incrementally by
an outside service. The job's own `result` still holds the full usage for showing one run; this table is for
counting. It measures nothing itself: it stores the `usage.costUsd` that the runner reports, which is exact for both review kinds: the sum of the charges the model provider stated for every call, `null` when any is missing (#267 for Dynamic, #274 for Diff; `runner/README.md`).

| File                                             | Role                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `usage-records.ts`                               | Pure: the states, `costUsdToMicroUsd`, `settlementOfOutcome`, `keyModeOfAccessSource` |
| `../db/repositories/usage-records-repository.ts` | Scoped to one workspace: `reserve`, `setKeyMode`, `settle`, `get` and the three reads |
| `enforce-entitlements.ts`                        | Pure: `decideAdmission`, the order of the checks of a claim (below)                   |
| `plan-view.ts`, `usage-summary.ts`               | The plan page's view of a workspace and the read that builds it (#282, below)         |
| `http.ts`, `shared.ts`, `ui/`                    | The polling answer of the plan page, its wiring and the page (#282, below)            |
| `../db/repositories/claim-admission.ts`          | Instance level: resolves the entitlements inside the claim transaction and decides    |

## Columns

`id` (a text identifier; the cursor of the page of settled records is `(settled_at, id)`, so the id only has to be unique),
`workspace_id`, `job_id` (unique), `review_kind` (`diff` or `dynamic`, copied from the job), `key_mode` (`own` when the
job ran on the workspace's key, `managed` when it ran on the operator's: the `source` of the resolved LLM access),
`model_tier` (the managed tier the run used, `low`, `medium` or `high`, set at the claim of a job on the operator's key, #280; null for a run on the workspace's own key. The name only, never the model behind it), `state`, `cost_micro_usd` (the reported `costUsd` times one
million, rounded half up; null when unknown), `prompt_tokens`, `completion_tokens` (null when unknown; all three are 32 bit integers, a larger number is stored as unknown), `reserved_at`,
`settled_at`, `settled_reason` (null unless the record was settled without a report of its run: `no_result`). The table checks the states, the key modes, that only a settled record has a time and a measurement,
and that amounts are not negative.

## Life of a record

```
claim --> reserved --complete with usage (failed or not), or a run that succeeded--> settled   (counts, with cost and tokens)
                   --job ended with no result from a runner that held it---------> settled   (counts, cost and tokens unknown, reason no_result)
                   --failed without usage, or ended before any runner began------> void      (does not count)
```

- **Reserve.** `claimNext` inserts the record in the transaction of the claim, so a job a runner holds always has
  one. A job claimed again after a lost lease keeps its record (`job_id` is unique): it never counts twice.
  The claim does not know the key yet, so the record starts as `own`; the claim route corrects it with `setKeyMode`
  when the LLM access is resolved (`own` for the workspace's key, `managed` for the operator's). Only a `reserved`
  record can be corrected.
- **Settle.** `complete` settles the record from the result, in the transaction that ends the job:
  a reported usage settles it with its cost (possibly null: an unknown cost is `settled`, never `void`, and never
  zero) and tokens, whatever the outcome; a run that succeeded without any usage is settled with everything
  unknown; a run that failed without usage (checkout, configuration, a runner that never reached the model) is
  `void`. A run that failed after it used the model reports its usage in the failed result (#273: the runner puts
  it there, see `runner/README.md`), so a pull request that always fails near the end is counted at every attempt
  and cannot be retried at the operator's cost without anybody seeing it. A failed result whose usage shows no
  model call at all (a runner of an earlier release reports one for a command that never reached the model) is
  `void` too.
- **No result.** A job that a runner held and that then ended without any result (its lease ran out on the last
  attempt, `lease_expired`; it ran past the hard limit, `timeout`; its runner was shut down and gave it back on the
  last attempt, `runner_shutdown`) is `settled` with an unknown cost and unknown tokens and the reason
  `no_result` (`settled_reason`): the model may have been used, and counting it is the conservative reading. It is
  never `void`. A lease that runs out on an earlier attempt ends nothing: the job is tried again and its record
  stays `reserved`. Only the usage of the attempt that ends the job is recorded; the cost of earlier attempts that
  were lost is not (a follow-up of #273).
- **A job process the runner's loop ended.** The loop reports the process it had to end (hard timeout, killed by a
  signal, no result line, a result that disagrees with its exit code) with `errorReason` `no_result_from_process`,
  and a failed result with a usage it could not read with `unreadable_usage`; the Diff watchdog uses the first. A
  failed result without a readable usage and with one of these reasons, or whose usage was sent and cannot be read,
  settles as `no_result` too. A runner of an earlier release never sends the reasons and an app of an earlier
  release ignores them: both stay void, as before.
- **Void without a report.** Every other way a job ends without `complete` made no model call anybody knows of
  (a cancellation at claim time, a release before the runner began, such as `launch_failed` of a Dispatcher or a
  failure of the runner API itself, a cancellation or replacement while the job waited again, a job that was never
  dispatched): its `reserved` record is voided in the same transaction as the transition. The runner side does both
  this and the `no_result` settlement with `closeRecordsOfEndedJobs` (`usage-records-sweep.ts`, also run when
  Dynamic Review is switched off); the scoped job repository (`cancelWaiting`, and the replacement in `enqueue`)
  voids with `voidEndedJobs()`: a job that waited never ran.
- **Immutable.** Every statement that changes a record only touches a `reserved` one; a repeated completion
  (`alreadyCompleted`) changes nothing. A job that was claimed before this table existed has no record; its
  completion creates one in its final state (key mode `own`, dated from the job's claim).
- Runs of workspaces without any entitlement are recorded too. Nothing here changes what a run does.

`reserved` and `settled` count towards a limit (#277, below), `void` does not.

## Limits and suspension at claim (#277)

What an operator allows a workspace (`src/workspaces/README.md`, "Entitlements") is enforced where a job is claimed,
in the transaction of `claimNext` (`runner-jobs-repository.ts`), after the oldest due job was taken and **before** its
record is reserved. That is the only way the check and the reservation are one step: two claims never both pass the
last unit, and a refused job leaves no record. Every way a job is claimed goes through it: the claim of a runner, the
split claim of a Dispatcher and the claim by job id.

`decideAdmission` decides in this order, the first refusal wins:

1. Entitlements that exist but cannot be read: `entitlements_invalid`. Never "unlimited", never an exception.
2. `suspended`: `workspace_suspended`.
3. The run limit of the job's kind (`diffRunsPerPeriod`, `dynamicRunsPerPeriod`): the records of that kind (`reserved`
   or `settled`) reserved at or after `period_start` at or above the limit refuse with `quota_exhausted` (detail
   `diff_runs` or `dynamic_runs`). `0` allows none, `null` is unlimited and is not read.
4. The cost limit (`managedCostLimitMicroUsd`), for a workspace whose key mode is `managed` (the operator's key): the
   sum of the settled managed `cost_micro_usd` reserved at or after `period_start` at or above the limit refuses with
   `quota_exhausted` (detail `managed_cost`). A settled run with an unknown cost adds nothing to the sum, never a
   zero and never a guess, and it still counts in 3; the operator API's summary lists such runs apart
   (`unknownCostCount`), so they can be watched. A workspace on its own key is never blocked by this limit.

A refused job ends `failed` with the code, in the claim transaction: no attempt is counted, no runner hears of it, no
credential or key is created, no record is written, and its holder, start time and lease are cleared (the Runs list
shows no duration for a run that did not start). The claim then tries the next job.
**Fairness:** a suspension and unreadable entitlements do not depend on the job, so they fail **all** the due jobs of
that workspace in one statement (and void the records of those that lost a lease), and a backlog never delays another
workspace. A refusal for a limit is decided per job (the count changes with every claim) and is bounded: at most 25
per call, then the call answers "nothing" and the runner asks again. The detail is only logged (`onRefused`, `[queue] job=... refused at
claim: quota_exhausted (diff_runs)`; a callback that throws is logged as `claim_refusal_log_failed` and ignored, so a
claimed job is never orphaned); the stored code is all the Runs pages get. The pull request notice (#281, `src/refusal-notices/README.md`) is posted
for `quota_exhausted` and `workspace_suspended` after the claim committed, once per pull request and period: the
refusal carries the `periodStart` it was decided under for that (`ClaimRefusal.periodStart`), and the notice does
not tell the three limits apart, so no detail is stored. A job claimed again after a lost lease keeps the one record it has and is **not counted against itself**
(it is left out of its own count), so it runs at a limit that its first claim used up; suspension and unreadable
entitlements still stop it, and its record is then voided.

- **Period.** A run belongs to the period it started in (`reserved_at`), for the count and the cost alike. Moving
  `period_start` forward (an operator's reset) takes effect on the next claim.
- **The cost limit is a soft cap and is not exact under concurrency.** Cost is only known when a run settles, so runs
  in flight are not in the sum (the run limits are exact, the cost limit is not). A run that starts below the limit may
  end above it by what the runs in flight at that moment cost; the overshoot is bounded by the number of concurrent
  runs times the per-run bounds, and it is recorded as usage like any other. A run with an unknown cost is not bounded
  at all by this limit.
- **Which runs the cost limit watches.** Those of a workspace whose entitlements say `managed`; the sum counts the
  records whose key mode is `managed`. A key mode `managed` whose operator key is missing is not a quota matter (#276)
  and keeps its own code (`llm_not_configured`). The key mode of the entitlements also picks the key (#276), and the record
  is corrected to the key the job really uses on both claim paths, so the cost limit counts exactly the runs that spent the
  operator's key. **A cost limit next to the key mode `own` is read by nothing.** An operator can no longer
  write that shape (`cost_limit_requires_managed_key`, 422); an entry stored before that keeps working exactly as it
  did, the limit is ignored, and the claim logs it once per workspace and process (`onIgnoredCostLimit`). Limiting the
  cost of runs on the workspace's own key is a separate limit (#361).
- **Locking.** The claim already runs under the instance gate lock of the queue (Postgres) or the write lock of the
  connection (SQLite), which serializes claims. On Postgres the workspace row is also locked `for no key update` (an
  insert that only references it does not wait), so the count stays exact if the gate is ever narrowed. The lock and
  the count are taken only when a limit applies to the job (`readsUsage`: the limit of its kind, or the cost limit of
  a `managed` workspace); a workspace that is unlimited, suspended, unreadable or without such a limit reads no usage
  and takes no lock. What every claim pays is three point reads (its row, or the instance default, and the job's own
  record).
- **Indexes.** The count is one query on `usage_records_workspace_reserved` (workspace, kind, reserved time). The cost
  sum only runs for a managed workspace with a cost limit and reads that workspace's records of the period.
- **Order with the project guard.** The entitlements are decided inside `claimNext`, before the claim guard (a
  project that was switched off) sees the job. A job of a suspended workspace whose project is also switched off
  therefore fails as `workspace_suspended` instead of being cancelled as `project_deactivated`. Switching a project off
  cancels its waiting jobs eagerly, so the guard only matters in a race; a test pins the order.
- **Mixed versions.** Nothing in the schema changed. An app instance from before #277 still claims, reserves records
  and ignores the entitlements; it shows an unknown code (`quota_exhausted`) with the general sentence if it ever lists
  a job that a newer instance refused. During a rolling upgrade a job claimed by an old instance is not checked.

## Reads

Repository functions, the operator API that serves them (#278, `src/operator-api/README.md`) and the plan page of a
workspace (#282, below).

- `countByKind(since)`: records that count (`reserved`, `settled`) reserved at or after `since`, per review kind.
- `sumSettledManagedCostMicroUsd(since)`: the cost of settled records of managed runs reserved at or after `since` (a run belongs to the period it started in, for the count and for the cost alike);
  an unknown cost adds nothing.
- `pageSettled({ after, limit, settledBefore?, from?, to? })`: settled records ordered by `(settled_at, id)` after a
  cursor, with the cursor for the next page. Never `reserved` or `void` records. `settledBefore` keeps back what was
  settled at or after that time (the operator API passes now minus the safety lag); `from` (included) and `to`
  (excluded) filter on `settled_at`.
- `summarize({ from, to })`: the runs that started in `[from, to)` (the period rule of the counts), per review kind and
  key mode: runs that count, settled runs, the sum of the known cost, settled runs with an unknown cost.
- The instance level `usage-feed-repository.ts` (`pageSettled({ after, limit, settledBefore? })`) is the same page for
  **every** workspace, for the operator API's feed. It is classified as instance level in `scoping.test.ts`: it only
  reads, and every record names its workspace.

### The feed and the safety lag

A record's `settled_at` is stamped with the settling app instance's clock (`settle()` reads it just before the update),
and the record becomes visible when its transaction commits; if `settle` runs inside a longer outer transaction, the
whole gap to the commit counts against the lag. With concurrent writers (Postgres) two settlements can therefore become visible in the reverse order of
their stamps, and a reader that already moved past the later stamp would never see the earlier arrival. The operator
API only serves records settled **more than 60 seconds ago** (`USAGE_SAFETY_LAG_MS`, a validated instance constant:
`operator-api/contract.ts`), so a settlement may take up to that long to commit and still never be skipped. The
assumption is stated, not enforced: a transaction that stays open longer than the lag, or a clock that differs between
two app instances by more than the lag, could still reorder two records. Readers treat `id` as the idempotency key
anyway. `integration-tests/http/operator-api-usage.integration.test.ts` and
`usage-feed-repository.integration.test.ts` show both the hazard (a reader without the bound misses a late record) and
the guarantee.

Records are small and kept; there is no retention job.

## The plan page (#282)

`/w/<slug>/settings/plan` ("Plan and usage", a sub-page of the workspace settings) says what the workspace may use, what
it has used in the current period and whether reviews are paused, **read-only for every member** (`view`). Its data
route is `GET /api/w/<slug>/plan`, which the page polls (the Runs pages' mechanism, `useLiveSnapshot`: every 10
seconds while the workspace has limits, every 30 while none apply, a failed update keeps the last data and says so, a
lost session stops it). The answer is `Cache-Control: no-store`; a workspace the person does not belong to is the answer
of a path that does not exist (page and route), like every workspace address.

`readPlanView` (`usage-summary.ts`) reads the effective entitlements (`readEffectiveEntitlements`, the claim's own
read) and, only for a workspace that has them, the usage since `period_start` through the repository of #272: the same
count (`countByKind`: `reserved` and `settled`, never `void`) and the same period rule (`reserved_at`) as the claim,
so the page and a refusal always agree. `buildPlanView` (`plan-view.ts`) is the boundary to the browser; it copies
named fields only:

| State        | When                                             | What the page says                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unlimited`  | no entitlements (no row, no instance default)    | "No limits apply to this workspace." No navigation entry (the page is still there by address).                                                                                                                           |
| `unreadable` | entitlements exist but fail the checks of a read | That the limits cannot be read and reviews are not started. Nothing else (the claim refuses with `entitlements_invalid`).                                                                                                |
| `limited`    | the rest                                         | The plan label (operator text, shown as text), the start of the period (never an end: the app does not know it), "3 of 5" and "1 of 2" per kind or "no limit", a notice when reviews are paused, and the cost bar below. |

- **Counts.** "N of limit" or "N used, no limit"; "limit reached" is said in words when `used >= limit`.
- **The cost limit is shown as a percentage, never as an amount.** A bar (`role="progressbar"`, whose name and
  `aria-valuetext` are the visible sentence "62 % of the usage limit used") appears only for a workspace on the
  operator's key (`managed`) that has a `managedCostLimitMicroUsd`: the claim watches nothing else, and a limit next
  to the key mode `own` is read by nothing (above), so it is not shown. The percentage is the settled managed cost
  in the period divided by the limit, **rounded down** (100 means the limit is reached, as the claim refuses at
  `used >= limit`) and **at most 100**: a run that was in flight when the limit was reached may take the total past it,
  and the page does not claim to know by how much. The page says that it is not exact (soft cap). A limit of 0 reads 100. Settled runs whose cost is unknown are counted apart ("2 finished reviews could not be measured and are not in
  this percentage"), never as zero. Neither the API nor the DOM holds an amount, a currency or the measured cost, in
  any unit; the measured sum does not leave `buildPlanView`.
- **A managed workspace** is told that the instance provides the models. The page never shows a model, a tier, a key or
  anything of a job, the reason of a suspension, or whether the entitlements are the workspace's own or the instance
  default; a test looks for each in the answer and in the markup.
- **Navigation.** The settings sub-nav lists "Plan" (before "Advanced") only while the workspace has entitlements
  (`planPageAvailable`: its own row or the instance default, readable or not). Every settings page asks once per request.
  The address is the one the refusal notice and the operator's page lead to (`planReturnPath`, `src/plan-handoff/`).
- **"Manage plan"** (#284) is on this page too, for an Owner or Admin while the instance has a plan management page.
- **Mixed versions.** No schema change, no new setting. An app of the previous release has no plan page and no route
  (both answer as a path that does not exist), and its General settings keep working; the plan address the notice and
  the operator's page use is only set once a plan management page is (`src/plan-handoff/README.md`: upgrade every
  instance first).

## Tests

`usage-records.test.ts` (rounding and settlement rules), `usage-records-repository.integration.test.ts` and the
Postgres twin, `integration-tests/http/runner-api-usage.integration.test.ts` (claim, completion, lease loss),
the rows of `scoped-isolation.integration.test.ts`, and the operator API's usage endpoints
(`usage-feed-repository.integration.test.ts`, `integration-tests/http/operator-api-usage.integration.test.ts`). The plan
page: `plan-view.test.ts` (the percentage and what the view leaves out), `usage-summary.integration.test.ts` (real
records: period, `reserved` and `void`, kinds, key modes, unknown cost), `ui/plan-page.test.tsx` (the page, the bar's
text, no colour-only state, the polling), `ui/plan-page.integration.test.tsx` (the page file with the real wiring),
`integration-tests/http/plan-route-file.integration.test.ts` and the "GET plan" row of
`workspace-isolation.integration.test.ts` (the route).
