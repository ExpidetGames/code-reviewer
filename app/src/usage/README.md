# Usage records

One row per job in `usage_records` (migration `20261014150000_create_usage_records`; epic #268, issue #272): what the
run consumed, in a form that can be counted atomically with the decision to start a run and read incrementally by
an outside service. The job's own `result` still holds the full usage for showing one run; this table is for
counting. It measures nothing itself: it stores the `usage.costUsd` that the runner reports (#267).

| File                                             | Role                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `usage-records.ts`                               | Pure: the states, `costUsdToMicroUsd`, `settlementOfOutcome`, `keyModeOfAccessSource` |
| `../db/repositories/usage-records-repository.ts` | Scoped to one workspace: `reserve`, `setKeyMode`, `settle`, `get` and the three reads |

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

`reserved` and `settled` count towards a limit (#277), `void` does not.

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
