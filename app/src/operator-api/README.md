# Operator API

A machine interface for an operator who runs one instance for many workspaces (epic #268, issue #275). An
external service lists the workspaces and sets what each may do: the key it reviews with, its limits per period
and whether its reviews are suspended (`src/workspaces/README.md`, "Entitlements"). The app only stores and
enforces; where the numbers come from is the operator's business.

The format is `contracts/operator-api.v1.json` (JSON Schema, with one example per body in
`contracts/examples/operator-api/`). That file is what an external client is built against; the app tests
validate real answers against it (`app/integration-tests/compatibility/operator-api-contract.integration.test.ts`).

## It does not exist until it is switched on

`OPERATOR_API_TOKEN` is optional. While it is unset, blank or unusable, every path below `/api/operator/v1` (any
method) ends in Next.js's `notFound()`: the answer of a path that does not exist, before the request is read and
without opening the database. A self-hoster who never sets it has no extra surface.

The token follows the rules of `RUNNER_TOKEN`: at least 32 characters, no white space or control characters
(`token.ts`). It must differ from `RUNNER_TOKEN` and `APP_SECRET`.

| Token                                   | API       | Start                                                                                                 |
| --------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| unset or blank                          | off (404) | `[operator-api] off: OPERATOR_API_TOKEN is not set.`                                                  |
| weak (short, white space)               | off (404) | `[operator-api] off: OPERATOR_API_TOKEN must be at least 32 characters long.`                         |
| equal to `RUNNER_TOKEN` or `APP_SECRET` | off (404) | the production start ends with `DEPLOY_CONFIG_INVALID` naming the variables (`src/deploy/startup.ts`) |
| usable                                  | on        | `[operator-api] on.`                                                                                  |

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
   `body_too_large`) and one JSON value (400 `request_invalid`); then the read, the replacement or the removal

Every answer is JSON with `Cache-Control: no-store` and `"version": 1`; an error is `{ "version": 1, "error": <code> }`
(plus `field` for a refused entitlement). There is no message text: callers branch on the code. Every route file
exports every HTTP method so that a method it does not offer is answered by the API (405, or the 404 while off), not
by Next.js.

## Endpoints

| Call                                                   | Does                                                                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/operator/v1/workspaces?after=<id>&limit=`    | A page (default 50, at most 200) of `{ id, slug, createdAt }` ordered by id, and `nextAfter`. No names of people, no emails, no repositories. |
| `GET /api/operator/v1/workspaces/{id}/entitlements`    | The stored row (or `null`) and the effective entitlements; `effective.source` says whether they come from the workspace or from the default.  |
| `PUT /api/operator/v1/workspaces/{id}/entitlements`    | Replaces the row. Idempotent. Answers like `GET`.                                                                                             |
| `DELETE /api/operator/v1/workspaces/{id}/entitlements` | Removes the row, so the default applies. Harmless when there is none. Answers like `GET`.                                                     |
| `GET\|PUT /api/operator/v1/entitlements/default`       | The default for workspaces without a row. No `DELETE`.                                                                                        |

A change takes effect on the next claim; a running job is not touched.

### The PUT body

The whole entitlements (`planLabel`, `keyMode`, `limits` with every limit, `periodStart`, `suspended`,
`suspensionCode`), validated by `validateEntitlements` of #271 (unknown keys are refused). A refusal is `422` with
the stable code of the validation (`plan_label_invalid`, `key_mode_invalid`, `limits_invalid`, `limit_invalid`,
`period_start_invalid`, `period_start_in_future`, `suspended_invalid`, `suspension_code_invalid`,
`entitlements_invalid`), or `409 period_start_backwards`.

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
| `contract.ts`              | Error codes, limits, routes and methods                                         |
| `responses.ts`, `views.ts` | The answers: headers, errors, what an entitlement looks like to the outside     |
| `api.ts`                   | `createOperatorApi`: the order above, as one function of its collaborators      |
| `shared.ts`                | The wiring on the running server (`withOperatorApi`, called by the route files) |
