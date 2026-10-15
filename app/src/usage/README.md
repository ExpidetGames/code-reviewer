# Usage records

One row per job in `usage_records` (migration `20261014150000_create_usage_records`; epic #268, issue #272): what the
run consumed, in a form that can be counted atomically with the decision to start a run and read incrementally by
an outside service. The job's own `result` still holds the full usage for showing one run; this table is for
counting. It measures nothing itself: it stores the `usage.costUsd` that the runner reports (#267).

| File                                             | Role                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `usage-records.ts`                               | Pure: the states, `costUsdToMicroUsd`, `settlementOfOutcome`, `keyModeOfAccessSource` |
| `../db/repositories/usage-records-repository.ts` | Scoped to one workspace: `reserve`, `setKeyMode`, `settle`, `get` and the three reads |
| `enforce-entitlements.ts`                        | Pure: `decideAdmission`, the order of the checks of a claim (below)                   |
| `../db/repositories/claim-admission.ts`          | Instance level: resolves the entitlements inside the claim transaction and decides    |

## Columns

`id` (a text identifier; the cursor of the page of settled records is `(settled_at, id)`, so the id only has to be unique),
`workspace_id`, `job_id` (unique), `review_kind` (`diff` or `dynamic`, copied from the job), `key_mode` (`own` when the
job ran on the workspace's key, `managed` when it ran on the operator's: the `source` of the resolved LLM access),
`model_tier` (null until the managed tiers exist, #280), `state`, `cost_micro_usd` (the reported `costUsd` times one
million, rounded half up; null when unknown), `prompt_tokens`, `completion_tokens` (null when unknown; all three are 32 bit integers, a larger number is stored as unknown), `reserved_at`,
`settled_at`. The table checks the states, the key modes, that only a settled record has a time and a measurement,
and that amounts are not negative.

## Life of a record

```
claim --> reserved --complete with usage, or a run that succeeded--> settled   (counts, with cost and tokens)
                   --failed without usage, or ended without a report--> void   (does not count)
```

- **Reserve.** `claimNext` inserts the record in the transaction of the claim, so a job a runner holds always has
  one. A job claimed again after a lost lease keeps its record (`job_id` is unique): it never counts twice.
  The claim does not know the key yet, so the record starts as `own`; the claim route corrects it with `setKeyMode`
  when the LLM access is resolved (`own` for the workspace's key, `managed` for the operator's). Only a `reserved`
  record can be corrected.
- **Settle.** `complete` settles the record from the result, in the transaction that ends the job:
  a reported usage settles it with its cost (possibly null: an unknown cost is `settled`, never `void`) and tokens,
  whatever the outcome; a run that succeeded without any usage is settled with everything unknown; a run that
  failed without usage (checkout, configuration, a runner that never reached the model) is `void`.
- **Void without a report.** A job that ends without `complete` (the last attempt loses its lease, the hard limit,
  a release on the last attempt, a cancellation at claim time, a cancellation or replacement while it waited again)
  has its `reserved` record voided in the same transaction as the transition: the runner side with
  `voidRecordsOfEndedJobs` (`usage-records-sweep.ts`, also run when Dynamic Review is switched off), the scoped job repository (`cancelWaiting`, and the
  replacement in `enqueue`) with `voidEndedJobs()`.
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
credential or key is created, no record is written, and the claim tries the next job (up to 25 per call, then it
answers "nothing" and the runner asks again). The detail is only logged (`onRefused`, `[queue] job=... refused at
claim: quota_exhausted (diff_runs)`); the stored code is all the Runs pages and the later pull request notice (#281)
get. A job claimed again after a lost lease keeps the one record it has and is **not counted against itself**
(it is left out of its own count), so it runs at a limit that its first claim used up; suspension and unreadable
entitlements still stop it, and its record is then voided.

- **Period.** A run belongs to the period it started in (`reserved_at`), for the count and the cost alike. Moving
  `period_start` forward (an operator's reset) takes effect on the next claim.
- **The cost limit is a soft cap.** Cost is only known when a run settles, so runs in flight are not in the sum. A run
  that starts below the limit may end above it by what the runs in flight at that moment cost; the overshoot is bounded
  by the number of concurrent runs times the per-run bounds, and it is recorded as usage like any other.
- **Which runs the cost limit watches.** Those of a workspace whose entitlements say `managed`; the sum counts the
  records whose key mode is `managed`. A key mode `managed` whose operator key is missing is not a quota matter (#276)
  and keeps its own code.
- **Locking.** The claim already runs under the instance gate lock of the queue (Postgres) or the write lock of the
  connection (SQLite), which serializes claims. On Postgres the workspace row is also locked `for no key update` (an
  insert that only references it does not wait), so the count stays exact if the gate is ever narrowed. A workspace
  without limits reads no usage and takes no lock: the cost is two point reads (its row, or the instance default).
- **Indexes.** The count is one query on `usage_records_workspace_reserved` (workspace, kind, reserved time). The cost
  sum only runs for a managed workspace with a cost limit and reads that workspace's records of the period.
- **Mixed versions.** Nothing in the schema changed. An app instance from before #277 still claims, reserves records
  and ignores the entitlements; it shows an unknown code (`quota_exhausted`) with the general sentence if it ever lists
  a job that a newer instance refused. During a rolling upgrade a job claimed by an old instance is not checked.

## Reads

Repository functions, and the operator API that serves them (#278, `src/operator-api/README.md`); there is no page
yet (#282).

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

## Tests

`usage-records.test.ts` (rounding and settlement rules), `usage-records-repository.integration.test.ts` and the
Postgres twin, `integration-tests/http/runner-api-usage.integration.test.ts` (claim, completion, lease loss),
the rows of `scoped-isolation.integration.test.ts`, and the operator API's usage endpoints
(`usage-feed-repository.integration.test.ts`, `integration-tests/http/operator-api-usage.integration.test.ts`).
