# First-run setup

A new instance is set up in the browser. The operator proves access to the server with a code from the
app's log, answers three questions and has an admin account. The decision is in
`docs/decisions/0001-editions-setup-and-accounts.md`, sections 2.1 and 2.2; this folder is its
implementation.

| File                       | Role                                                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state.ts`                 | `readSetupState(db)`: `completed`, `fresh` or `existing`, from the two markers in `instance_settings` (`setup_completed_at`, `import_state`) and whether users exist. `createSetupStateReader` remembers `completed`. |
| `gate.ts`, `gate-proxy.ts` | The gate: what to do with a request while the instance is not set up (pure decision, then the Next.js response). Applied first in `src/proxy.ts`.                                                                     |
| `code-store.ts`            | The setup code and everything that protects it, in the memory of the process: expiry, rate limit, lock, single use.                                                                                                   |
| `start.ts`                 | `startSetupOnStart`: called from `src/instrumentation.ts`; prints the one log line with a fresh code while the instance is not set up.                                                                                |
| `setup-session.ts`         | The signed, HttpOnly setup session cookie (30 minutes), bound to the issuance of the code it came from.                                                                                                               |
| `input.ts`, `complete.ts`  | Validation of the wizard's answers; the completion in one transaction (admin, settings, workspace, marker).                                                                                                           |
| `http.ts`, `shared.ts`     | The two route handlers (`POST /api/setup/code`, `POST /api/setup/complete`) and the wiring of the running server (the store lives on `globalThis`).                                                                   |
| `errors.ts`                | The stable error codes and their HTTP status.                                                                                                                                                                         |
| `ui/`                      | The code form and the three-step wizard (client components), their copy (`messages.ts`) and the calls they make (`api.ts`). Page: `src/app/setup/page.tsx`.                                                           |

## The three states

|           | Condition                                                         | Gate                                                                                                                                                     |
| --------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fresh     | `setup_completed_at` not set, no users and `import_state` `none`  | Everything but `/api/health`, static files and the setup answers `503 setup_required` (API, webhooks, runner API) or shows the code form (pages).        |
| existing  | `setup_completed_at` not set, and users exist (or the import ran) | The same for the web UI and the UI APIs. **Webhooks and the runner API keep working**, so reviews do not stop while the operator has not found the code. |
| completed | `setup_completed_at` set                                          | `/setup` and `/api/setup/**` answer 404; nothing else is touched.                                                                                        |

The state is never inferred from whether a row exists: a database from before the markers reads as
`setup_completed_at` null and `import_state` `none`. `import_state` is written by the import of an existing
installation (a later issue), never by the setup.

## The code

- Printed once per start of a process while the instance is not set up: `[setup] Setup code: 482913 ...`
  (`start.ts`, the only place that ever shows it, and only in the log). 6 digits from `crypto.randomInt`.
- Only a keyed hash is kept (HMAC with a random key per issuance), in the memory of the process, together
  with its counters. **Nothing about it is in the database** and the code is never in a response, a page
  or another log line (`setup.integration.test.ts` checks the responses and the logs).
- Valid 60 minutes; about 5 attempts per minute for the whole process (not per address); **10 wrong
  attempts lock the endpoint until the process is restarted**, which prints a new code. There is no
  automatic rotation: it would let an attacker invalidate the operator's code at will. A lock can be forced
  by anyone who reaches the site (a denial of service for the setup; a restart fixes it), but the code
  cannot be guessed: at most 10 in 1,000,000 per restart. Rate limited attempts are not counted as wrong.
- Single use: the correct code is consumed and exchanged for the setup session cookie.
- **The setup is done with one app instance running**: a second process has its own code and counters and
  refuses the code of the first (`setup.integration.test.ts`, "two processes over one database").

## The setup session

A cookie signed with a key derived from `APP_SECRET` for this purpose (`src/crypto/`): `cr_setup_session`,
HttpOnly, `SameSite=Strict`, `Secure` when `BETTER_AUTH_URL` is https, 30 minutes. It carries the id of the
issuance of the code, so a session made before a restart is worthless afterwards. When it runs out
unfinished the app has to be restarted for a new code. Both routes also refuse requests from another site
(`src/http/request-checks.ts`) and bodies that are not JSON.

## Completion

`complete.ts`, one transaction (the password is hashed before it opens):

1. the admin: a user flagged `is_instance_admin`, with Better Auth's credential account (the password hash
   comes from Better Auth's own `context.password.hash`, so the sign in verifies it);
2. the choices: `tenancy` and `sign_up_rule` in `instance_settings`;
3. the workspace: single-tenant uses the oldest workspace (an existing installation's imported one) or
   creates "Default workspace", and the admin becomes an Owner; multi-tenant makes the admin Owner of an
   imported workspace only if it has no Owner, and a fresh multi-tenant instance gets none;
4. `setup_completed_at`.

Two completions at the same moment cannot both win: the transaction takes the write lock first and the
second reads the marker set (`already_set_up`). Afterwards the code is invalidated and the admin is signed
in (Better Auth's `signInEmail`); the response says `redirectTo: "/admin"`.

## Sign-up rules

All three rules can be chosen (`everyone`, a list of emails, allowed domains). An email or domain rule is
fail-closed while no verification path exists (no mail server and sign in is not GitHub only,
ADR section 2.5); the wizard says so next to the choice. Nothing signs anybody up yet: the sign-up
endpoint of Better Auth is switched off, the rule is only stored.

## After the setup

The admin lands in the admin portal (`src/admin/README.md`): it changes the tenancy, the sign-up rule and the
ways to sign in there, and `admin reset-password` recovers a lost admin password.

## Tests

`setup.integration.test.ts` drives the real proxy gate, the real routes' handlers and the real Better Auth
over a real database (`src/test-support/setup-harness.ts`) with a code store whose clock the test moves.
`code-store.test.ts`, `gate.test.ts`, `setup-session.test.ts` and `input.test.ts` are the unit tests;
`ui/` has component tests. The journey is `e2e/setup/first-run.e2e.ts`; other journeys and the harnesses
get a set-up instance from `e2e/setup/prepare-apps.e2e.ts` and `markInstanceSetUp`
(`src/test-support/workspaces.ts`).
