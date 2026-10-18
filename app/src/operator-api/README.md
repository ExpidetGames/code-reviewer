# Operator API

A machine interface for an operator who runs one instance for many workspaces (epic #268, issue #275). An
external service lists the workspaces and sets what each may do: the key it reviews with, its limits per period
and whether its reviews are suspended (`src/workspaces/README.md`, "Entitlements"), and reads what each workspace
consumed (`src/usage/README.md`, #278). The app only stores and enforces; where the numbers come from is the
operator's business.

The format is `contracts/operator-api.v1.json` (JSON Schema, with one example per body in
`contracts/examples/operator-api/`). That file is what an external client is built against; the app tests
validate real answers against it (`app/integration-tests/compatibility/operator-api-contract.integration.test.ts`).

## It does not exist until it is switched on

`OPERATOR_API_TOKEN` is optional. While it is unset, blank or unusable, every path below `/api/operator/v1` (any
method) ends in Next.js's `notFound()`: the answer of a path that does not exist, before the request is read and
without opening the database. A self-hoster who never sets it has no extra surface.

The token follows the rules of `RUNNER_TOKEN`: at least 32 characters, no white space or control characters
(`token.ts`). It must differ from `RUNNER_TOKEN`, `APP_SECRET` and `BETTER_AUTH_SECRET` (the deprecated name of the master key; it
stays a credential of the instance while both are set, so it is refused in that case too).

| Token                                                         | API       | Start                                                                                                 |
| ------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| unset or blank                                                | off (404) | `[operator-api] off: OPERATOR_API_TOKEN is not set.`                                                  |
| weak (short, white space)                                     | off (404) | `[operator-api] off: OPERATOR_API_TOKEN must be at least 32 characters long.`                         |
| equal to `RUNNER_TOKEN`, `APP_SECRET` or `BETTER_AUTH_SECRET` | off (404) | the production start ends with `DEPLOY_CONFIG_INVALID` naming the variables (`src/deploy/startup.ts`) |
| usable                                                        | on        | `[operator-api] on.`                                                                                  |

No line contains a token value.

## Authentication

`Authorization: Bearer <token>`, compared in constant time (both sides are hashed first, then compared, so the
time does not depend on length or content). A missing, non-bearer or wrong credential gets one answer, `401
unauthorized`, whatever the reason. The API never looks at a cookie: the browser session of an instance admin does
not open it, and `/api/admin/*` stays session-only. The paths are on the public list of `src/auth/access.ts`
(prefix `/api/operator/v1`), because the bearer token is the credential.

There is no rate limit beyond the strength of the token (out of scope of #275, like for the runner API).

## Order of a request (`api.ts`)

1. off: no usable token, `notFound()`
2. token: 401
3. route: a path the API does not have, 404 `not_found`
4. method: not offered by the route, 405 `method_not_allowed` with `Allow`; `GET` and `DELETE` carry no body (400
   `body_not_allowed`)
5. workspace: the id in the path names a workspace, else 404 `workspace_not_found`
6. work: for a `PUT` first its body, which needs `application/json` (415 `unsupported_media_type`), at most 16 KiB (413
   `body_too_large`) and one JSON value (400 `request_invalid`); then the read, the replacement or the removal. For
   usage: the query (400 `request_invalid`, `cursor_invalid` or `period_invalid`), then the read

Every answer is JSON with `Cache-Control: no-store` and `"version": 1`; an error is `{ "version": 1, "error": <code> }`
(plus `field` for a refused entitlement). There is no message text: callers branch on the code. Every route file
exports every HTTP method so that a method it does not offer is answered by the API (405, or the 404 while off), not
by Next.js.

## Endpoints

| Call                                                   | Does                                                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/operator/v1/workspaces?after=<id>&limit=`    | A page (default 50, at most 200) of `{ id, slug, createdAt }` ordered by id, and `nextAfter`. No names of people, no emails, no repositories.                                  |
| `GET /api/operator/v1/workspaces/{id}/entitlements`    | The stored row (or `null`) and the effective entitlements; `effective.source` says whether they come from the workspace or from the default.                                   |
| `PUT /api/operator/v1/workspaces/{id}/entitlements`    | Replaces the row. Idempotent. Answers like `GET`.                                                                                                                              |
| `DELETE /api/operator/v1/workspaces/{id}/entitlements` | Removes the row, so the default applies. Harmless when there is none. Answers like `GET`.                                                                                      |
| `GET\|PUT /api/operator/v1/entitlements/default`       | The default for workspaces without a row. No `DELETE`.                                                                                                                         |
| `GET /api/operator/v1/usage?after=&limit=`             | A page (default 50, at most 200) of the **settled** usage records of every workspace, ordered by `(settledAt, id)`, and `nextCursor`.                                          |
| `GET /api/operator/v1/workspaces/{id}/usage`           | The same for one workspace, plus `from` (included) and `to` (excluded) on `settledAt`.                                                                                         |
| `GET\|PUT\|DELETE /api/operator/v1/plan-management`    | The address of the operator-configured page that "Manage plan" hands workspace Owners and Admins over to (#284): `{ "url": "https://…" }`; `DELETE` removes it.                |
| `GET\|PUT /api/operator/v1/model-tiers`                | Which model backs each managed tier (`low`, `medium`, `high`), per review kind (#280): `{ "tiers": { "low": { "diff": "…", "dynamic": "…" }, … } }`. `PUT` replaces all of it. |
| `POST /api/operator/v1/handoff/redeem`                 | `{ "token": "…" }`: who a handoff token was made for (workspace id and slug, role, opaque user id), once. One `422 invalid_token` for every other case.                        |
| `GET /api/operator/v1/workspaces/{id}/usage/summary`   | `from` and `to` are required: per review kind and key mode, what the workspace ran in the period.                                                                              |
| `GET /api/operator/v1/usage/unknown-cost`              | `from` and `to` are required: per workspace and key mode, how many runs of the period settled without a known cost (#385). A page of whole workspaces by id.                   |

A change takes effect on the next claim; a running job is not touched.

**There is no call for the operator's own LLM keys** (#276, #427: one for each provider): they are saved by the instance admin in the admin portal and by
nobody else. Whoever holds the API token sets which workspaces are `managed`, never the key itself, and no answer or log
of the API holds or mentions it (`operator-api.integration.test.ts`; `no-operator-keys.test.ts` fails when a file of the API imports anything that reaches the secret store).

**Upgrade every app instance before setting any workspace to `managed`** (#276). An instance of the previous release
ignores the key mode: it would run the workspace's jobs on the workspace's own key and model, outside the cost limit.

### Model tiers (#280)

`GET|PUT /model-tiers` is the only way to set or read which model backs a tier (`src/model-tiers/README.md`). The answer
of both is `{ "version": 1, "tiers": { low|medium|high: { "diff": id|null, "dynamic": id|null } } }`, every tier and kind
present, `null` where nothing is configured. A `PUT` body is `{ "tiers": { … } }` with any of the tiers and kinds (a tier
or kind that is left out or `null` is not configured); it replaces the whole configuration, and unknown keys are refused
(`400 request_invalid`, `field` names the place). A model id the review settings would refuse is `422 model_id_invalid`
(`field` such as `high.diff`, never the value). A **Dynamic** model is checked against the provider's public metadata and
refused with `422` `DYNAMIC_MODEL_TOOLS_UNSUPPORTED`, `DYNAMIC_MODEL_UNKNOWN` or `DYNAMIC_MODEL_UNVERIFIED` (unlike a
user's choice in the review settings, a model that cannot be verified is refused here). A **Diff** model is refused
`422 MODEL_UNKNOWN` when the provider does not list it, and accepted when it needs no tool support or the provider
cannot be reached. The models of one `PUT` are read at the same time. Nothing is stored on a refusal. The
log line is `[operator-api] put model-tiers tiers=<tiers with a model|-> result=<ok|code>`: never an id.

**The ids are operator data**: they are served to the holder of this token and used for the job the runner gets; no
workspace, page, answer of the admin portal (it says only whether a tier is configured), usage record or log of a
workspace has them. A change takes effect at the next claim. An older app instance answers the path with its generic
`404 not_found` and ignores the setting: **upgrade every app instance before saving tiers.**

### The PUT body of the entitlements

The whole entitlements (`planLabel`, `keyMode`, `limits` with every limit, `periodStart`, `suspended`,
`suspensionCode`, and optionally `modelAccess`), validated by `validateEntitlements` of #271 (unknown keys are refused).
A refusal is `422` with the stable code of the validation (`plan_label_invalid`, `key_mode_invalid`, `limits_invalid`,
`limit_invalid`, `cost_limit_requires_managed_key`, `period_start_invalid`, `period_start_in_future`,
`suspended_invalid`, `suspension_code_invalid`, `catalog_entry_invalid`, `entitlements_invalid`), or
`409 period_start_backwards`.

**`PUT /entitlements/default` while the billing switch is on** (`src/billing/switch.ts`: the switch only, because the API has no way to the secret store) is refused `409 entitlements_default_managed_by_billing` (#438): the billing
module writes the default from the Free plan (`src/billing/README.md`). The refusal comes after the body is read and before it
is validated, and the write reads the switch again in its own transaction (a billing that is switched on between the check and
the write is refused too, and its default is not overwritten); a `GET` and the workspace rows are not affected, and the default is the operator's again when billing is
switched off (a default billing wrote is removed then). The marker `source` is not a key of the body: it is refused like any key
the API does not know.

`managedCostLimitMicroUsd` counts the cost of runs on the operator's key, so a non-null value (even `0`) with
`keyMode: "own"` is refused as `cost_limit_requires_managed_key` (field `managedCostLimitMicroUsd`). Send `null` for it,
or switch the key mode. An entry of that shape that was stored before this rule keeps working: it reads back as it was
and the limit is ignored (the app logs it once per workspace).

`ownKeyCostLimitMicroUsd` (#361) is the same kind of limit for the runs on the workspace's **own** key: micro-USD of
measured model cost per period, `null` for unlimited, `0` for none allowed. It is allowed with either key mode (next
to `managed` it waits until the workspace is switched back), and every write states it, like every limit. A job is
checked against the limit of the key it actually runs on, and the cost of a key mode is the sum of the settled runs that
used that key, so a switch in the middle of a period keeps each key's runs under its own limit. A refused job ends
`quota_exhausted` like any other limit. Both cost limits are **soft caps**: a run that starts below the limit can end
above it by what the runs in flight at that moment cost, and a run whose cost is unknown adds nothing to the sum, so
the limit does not bound it. The usage summary lists such runs (`unknownCostCount`) and the app logs one line for each
of them when it settles (job id and workspace id only), so they can be watched; `GET /usage/unknown-cost` counts them per
workspace and key mode (below), so a cost limit that leaks can be told apart and alerted on without the logs. An entry stored before the limit existed
reads it as `null`.

**Rollout of `ownKeyCostLimitMicroUsd`.** Because a write must state it, the first rollout is a cutover: a `PUT` without
the key gets `422 limits_invalid` from an instance that knows it, and a `PUT` with it gets `422 limits_invalid` from one
that does not (a write refuses an unknown limit, so a typo cannot pass). No single body works on both. So: **upgrade every
app instance first** (an instance of the previous release reads the limit and ignores it), **then** switch the writer to
send the key in every body, and treat a `422` during the window as retry-later, not as a refused plan. A body that
carries the key:

```http
PUT /api/operator/v1/workspaces/{id}/entitlements
Authorization: Bearer <OPERATOR_API_TOKEN>
Content-Type: application/json

{
  "planLabel": "team",
  "keyMode": "own",
  "limits": {
    "diffRunsPerPeriod": 100,
    "dynamicRunsPerPeriod": null,
    "managedCostLimitMicroUsd": null,
    "ownKeyCostLimitMicroUsd": 2000000
  },
  "suspended": false,
  "suspensionCode": null
}
```

### `modelAccess`: which catalog entries a workspace may use (#428)

`"modelAccess": { "catalogEntries": ["mce_...", ...] }` grants catalog entries by their ids (the ids the admin portal
shows; the API has no catalog route, decision C8 of ADR 0005, so a writer without the portal can only use `null`).
`catalogEntries: null` is every released entry, `[]` none, a list those entries (at most 100, each `mce_` and opaque
text; an id that no entry has is accepted and matches nothing). Anything else is `422 catalog_entry_invalid` (`field`:
`modelAccess` for a value that is not the object or has another key, `modelAccess.catalogEntries` for the list) and
nothing is stored. It has a meaning for `keyMode: "managed"` only: next to `"own"` it is accepted and kept, not read
(a workspace on its own key chooses provider and model freely); the plan form of the billing epic is where an `own` plan
is refused it. Every answer states it (`{ "catalogEntries": null }` for an entry that never set it).

**A write without `modelAccess` keeps the stored value**, as one without `periodStart` keeps the stored start, so a writer
that does not know the field (the first release of a billing service, a script) cannot clear what an operator granted in
the admin portal or a plan wrote. To clear it, send `{ "catalogEntries": null }`; a row that has none starts with every
released entry. The keep happens in the single statement of the write, so two writers do not race on it. The same holds
for `PUT /entitlements/default`. The log names the field (`modelAccess`) when it changed, never the ids.

**Rollout of `modelAccess`.** Existing writers need no change: the field is optional, so a body that never mentions it
is accepted before and after the upgrade and changes nothing. A writer that sends it can only do so **after every app
instance is upgraded**: an instance of an earlier release refuses the key as it refuses any unknown key, with
`422 entitlements_invalid` (`field: "modelAccess"`), so that a typo cannot pass; treat a `422` with that field during the
upgrade window as retry-later, not as a refused plan. (An earlier instance that reads a row or default written by a newer
one ignores the field.) There is no cutover as with `ownKeyCostLimitMicroUsd`, because nothing requires the field.

**Readers during the rollout (response direction).** In `EntitlementsFields` of the contract `modelAccess` is **optional**:
an instance of an earlier release never sends it, so a client that validates answers strictly (the billing service) must
accept an answer without it and read a missing field as `{ "catalogEntries": null }`. An upgraded instance always sends
it. The write direction is the opposite: the field is optional in a body, but when present it is checked strictly, and an
earlier instance refuses it (above).

**Mixed fleet and rollback: upgrade every instance before anyone sets a default `modelAccess`.** An earlier instance that
writes `default_entitlements` (a `PUT /entitlements/default` it serves, or an admin action of its own) replaces the whole
JSON and drops `modelAccess`, which widens that default to every released entry. A workspace row is not affected (the
earlier upsert names its columns and leaves `model_access` alone). So: upgrade all instances, then set a default
`modelAccess`; after a rollback to an earlier release, set it again. A write that leaves `modelAccess` out over a stored
default that cannot be read is refused with `422 catalog_entry_invalid` (field `modelAccess`): state it to repair the
default. A list holds each id once; a repeated id is refused with the same code. A workspace row overrides the instance
default entirely, so the default is a fallback for workspaces without a row, not a ceiling (a billing writer states
`modelAccess` on every plan write, #442).

Limits are JSON numbers. A number above 2^53 − 1 loses precision when JSON is parsed, so it can never be stored
as sent: it is refused as `limit_invalid`, not rounded.

### `periodStart`: never backwards, and a stale start does not block an unrelated update

The period start of a workspace never moves to an earlier time (`period_start_backwards`), so a late or repeated
reset is harmless. That would make a partial change, such as a suspension toggle sent with a start the client read
long ago, fail as a whole. Therefore **`periodStart` may be left out of the PUT body**: the stored start is kept
(or, when there is nothing stored or the stored row is unreadable, the period starts now). To begin a new period
send the new start. The read-then-write race is safe: a second writer that moved the start forward in between makes
this write fail with `409`, and the client reads again.

### Removal and the guard

The repository keeps no tombstone: **`DELETE` ends the "never backwards" guard for that workspace** (the stored start
was what it compared with). The consequence is documented rather than prevented: a later `PUT` with an explicit,
earlier `periodStart` is accepted, and a `PUT` without one begins now. The default cannot be removed through the
API for the same reason (`settings.remove('default_entitlements')` stays unreachable from here).

### Reading is checked too

A stored row or default that cannot be read comes back as `{ "invalid": true }`, and `effective` is `{ kind:
"invalid", code: "entitlements_invalid" }` (fail closed, #271). A valid `PUT` repairs it.

## Reading usage (#278)

The records are those of `usage_records` (`src/usage/README.md`). An item is `id`, `workspaceId`, `jobId`,
`reviewKind`, `keyMode`, `modelTier` (the name of a quality tier or `null`; a stored value that is not a tier name, `^[a-z][a-z0-9_-]{0,31}$`, is served as `null`, never a model id), `costMicroUsd`
(integer or `null` when it could not be measured), `promptTokens`, `completionTokens`, `settledAt` and `reason` (a short
code or `null`: `no_result` for a job that ended without any result from its runner, whose cost and tokens are then unknown, or `superseded` for a run a newer push replaced (#397: not a run of the free quota, but the cost and tokens it reported are usage like any other, and unknown ones stay unknown); a run that reported its usage, failed or not, has none, and an unpriced one shows a `null` cost with its tokens). Nothing else leaves the app:
no pull request, repository, branch, title or person, and no key. The view is built field by field
(`usage-views.ts`), so a column added later does not reach the outside by itself.

- **Only settled records are served.** `reserved` (still running) and `void` (no model was used) records never are,
  and a served record never changes (a repeated completion changes nothing, and a job has one record).
- **The cursor** is opaque text (`usage-cursor.ts`): base64url, at most 128 characters, naming a time of settlement and a
  record id. One that is not what the API wrote is `400 cursor_invalid`. `nextCursor` is the position after the last
  item; an empty page returns the cursor that was passed, so a reader that is caught up asks again from the same
  place; `null` only while nothing was served and none was passed. A `limit` out of 1 to 200 is `400 request_invalid`; a
  bad `from`/`to`, an empty period, or a summary without both is `400 period_invalid`.
- **Out-of-order commits and the safety lag.** A record is served only once its `settledAt` is more than **60 seconds**
  old (`USAGE_SAFETY_LAG_MS`, validated when the API is made: 1 second to 1 hour). Two settlements that commit in the
  reverse order of their stamps are therefore never skipped by a reader that moved on, as long as a settlement commits
  within the lag (see `src/usage/README.md`, "The feed and the safety lag", for what is and is not covered). The
  newest minute of settlements shows up a little late; that is the price. **Readers must treat `id` as the idempotency
  key** (keep one item per id): the contract says so.
- **The summary** counts a run in the period it started in (`[from, to)`, like the counts of the limits), so it is what
  a limit sees. It is not a view of the feed (which is by time of settlement), and it counts a run that is still in
  progress in `recordCount`. A combination without runs is not listed. It has no safety lag: it is a total, not a
  position to continue from.
- **The count of unknown costs** (`GET /usage/unknown-cost?from=&to=&after=&limit=`, #385) answers, for every workspace at
  once, `{ version, from, to, counts, nextAfter }` where each count is `{ workspaceId, keyMode, unknownCostCount }`:
  a plain integer and nothing else (no cost figure, model, key, name or job). It counts the settled runs whose cost is
  not known (a run that reported no cost, one that succeeded without usage, and one that ended with no result), by the
  period rule of the summary, so it equals that workspace's `unknownCostCount` added up over the review kinds of a key
  mode. `from` and `to` are required (`400 period_invalid`); `limit` is 1 to 200 workspaces (default 50) and `after` a
  workspace id (`400 request_invalid`), the paging of `GET /workspaces`: `nextAfter` is the last workspace of a full
  page, `null` on the last. A page lists a workspace's key modes together, ordered by workspace id then key mode, and a
  workspace and key mode without an unknown cost is not listed (a missing one is zero). It is a total, not a feed
  position: no safety lag, and a run is counted once it settled, so the count of a period can grow until its last run
  has ended. **To alert on a rate, read the same period again later and compare**; the key mode says which limit
  leaks (`managed` is the operator's key, whose limit is `managedCostLimitMicroUsd`). The numbers come from the
  usage records themselves (`src/usage/README.md`, "Counting unknown costs"). Mixed deployments: an older app
  instance answers this path with its generic `404 not_found`, so a reader treats a `404` during a rollout as "not
  yet".
- **Workspace scoping.** The feed of every workspace reads through the instance level `usage-feed-repository.ts`; one
  workspace's page and summary through the scoped usage records repository, which can only see its own rows.
- Reads log nothing. A mixed deployment is safe: no migration, only new routes and new definitions in the contract
  (readers ignore what they do not know), and an older app instance answers these paths with its generic `not_found`.

## The plan handoff (#284)

`src/plan-handoff/README.md` has the whole flow. Here is what the API does:

- **`POST /handoff/redeem`** takes `{ "token" }` (exactly this key; a body that is not that is `400 request_invalid`) and
  answers `200 { workspaceId, workspaceSlug, userId, role }` once. The token is 256 random bits kept as a hash, valid for
  5 minutes, bound to the person and the role they had at the click, revoked by a newer click of the same person in the
  same workspace, and **the role is checked again at redemption**. An unknown, used, expired or revoked token, one of
  another shape, or one whose person lost the role gets the one answer `422 invalid_token` (the token is used up in the
  last case). The answer holds no email, name or repository, and `userId` is opaque. No rate limit beyond the strength
  of the token (like the rest of the API), none needed: a token cannot be guessed.
- **`GET|PUT|DELETE /plan-management`** reads, sets and removes the address the button hands people over to. A `PUT`
  body is exactly `{ "url": "https://…" }`; the address has to be absolute `https:` without credentials or a fragment,
  else `422` with `url_invalid`, `url_not_https`, `url_has_credentials`, `url_has_fragment` or `url_too_long`. It is
  stored in its normal form; `updated_by` is null (the API). The instance admin can set the same value in the portal.
  **Whoever holds the operator token decides where Owners and Admins are sent**; the page only ever gets a one-shot
  token for five minutes.
- Logs: `[operator-api] handoff workspace=<id|-> result=<ok|invalid_token>` and
  `[operator-api] <put|delete> plan-management result=<ok|code>`: ids and codes, never a token or an address.
- Mixed deployments: an older app instance answers both paths with its generic `404 not_found`. **Upgrade every app
  instance before setting the page.**

## Writes and logs

A write records the operator API as the actor (`updated_by` is null) and logs one line:
`[operator-api] put workspace=<workspace id|default> fields=<names of changed fields|-> result=<ok|error code>`
(`delete` for a removal). Names and codes only: never a value, a label, a body or a token. A failure nobody planned
for is a generic `500 internal_error`; the log gets the name of the error.

## Files

| File                       | Role                                                                            |
| -------------------------- | ------------------------------------------------------------------------------- |
| `token.ts`                 | The token rules, the constant-time comparison                                   |
| `startup.ts`               | The one start line                                                              |
| `contract.ts`              | Error codes, limits, routes and methods, the safety lag, the cursor size        |
| `api.ts` (model tiers)     | `modelTiers`: the route over `src/model-tiers/service.ts`                       |
| `usage.ts`                 | The four usage routes (query, safety lag, answer)                               |
| `api.ts` (plan handoff)    | `redeemHandoff` and `planManagement` (`src/plan-handoff/` has the rest)         |
| `usage-cursor.ts`          | The opaque cursor and the check of the safety lag                               |
| `usage-views.ts`           | What a usage record and a summary look like to the outside                      |
| `responses.ts`, `views.ts` | The answers: headers, errors, what an entitlement looks like to the outside     |
| `api.ts`                   | `createOperatorApi`: the order above, as one function of its collaborators      |
| `shared.ts`                | The wiring on the running server (`withOperatorApi`, called by the route files) |
