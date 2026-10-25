# The landing page's PostHog identity on the user (#692)

code-review.com (the landing page, another repository) measures its visitors with PostHog, **only after they accepted
tracking there**. A visitor who did is sent to the app with their PostHog identifiers, and the app does one thing with
them: it writes them on the user at sign-up, so the owner can later connect a landing visit to the account in the database.
**The app itself does no tracking**: it loads no PostHog SDK, sets no analytics cookie, sends nothing to PostHog and never
reads the values back.

## The contract with the landing page

Links from code-review.com to `https://app.code-review.com/sign-up` and `/login` carry two query parameters, only for
visitors who accepted tracking:

| Parameter | Content                 |
| --------- | ----------------------- |
| `ph_did`  | the PostHog distinct id |
| `ph_sid`  | the PostHog session id  |

`ph_did` and `ph_sid` are opaque text (PostHog uses UUIDs; older SDKs hyphenated hex groups). They are read strictly (`identity.ts`): 1 to
200 characters of `A-Z a-z 0-9 . _ : -`. A value that does not fit is ignored without a word, the other one is kept.
`ph_ts` is only taken out of the address with the other two: it is neither stored nor checked (how fresh a link is, is the
landing page's rule; rejecting old links here would only lose attributions of visitors who left the tab open). Nothing is ever decided from them; a visitor can send any value and only changes the note on their own account.

## How they travel

| File          | Role                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.ts` | The parameter names, the strict shape, the cookie value (`<did>~<sid>`) and its parsing                                                                                                                                                                                               |
| `capture.ts`  | The proxy step (`src/proxy.ts`, after the setup gate): a `GET /sign-up` or `GET /login` with a parameter gets a **307 to the same address without `ph_did`, `ph_sid` and `ph_ts`** (other parameters, such as `invitation`, stay) and, when a value is valid, the cookie `cr-landing` |
| `sign-in.ts`  | Better Auth's `session.create.after` hook (`src/auth/auth.ts`): after any sign-in (GitHub callback, email form), a request that carries the cookie stores it on the user (`store.ts`) and clears the cookie. A failure is logged by its name and never stops the sign-in              |
| `store.ts`    | The only writer: the columns of a new user row, and the first-touch update of a known one                                                                                                                                                                                             |
| `src/signup/` | The email sign-up (`POST /api/sign-up`) reads the cookie, the account made after the answer gets the identity, and the answer clears the cookie                                                                                                                                       |

The cookie `cr-landing` is first-party, `HttpOnly`, `SameSite=Lax` (it has to come back on the redirect from GitHub, a top
level navigation), `Secure` when the app is served over https, `Path=/`, **one hour**. It exists so the values survive the
sign-in form, the redirect to GitHub and the way back; it is not an analytics cookie, no script can read it and it is cleared at the first
sign-in or sign-up that sees it. The parameters are taken out of the address by the redirect, so they are not left in the
address bar, the history or a later `Referer` (the `Referrer-Policy` of the pages is unchanged).

## What is stored, and the first-touch rule

`users.posthog_distinct_id`, `users.posthog_session_id`, `users.posthog_captured_at` (nullable text, migration
`20261025140000_add_users_posthog_identity`, additive, SQLite and Postgres).

- **A new account** (email sign-up, first GitHub sign-in) gets the identity that came with it.
- **A known user** who signs in with a landing link gets it **only while `posthog_captured_at` is still empty** (one
  conditional `UPDATE`, so two sign-ins at the same moment cannot both win). What is there is never replaced: the
  first touch stays. A user who signed up without a link and later arrives from the landing page is connected then.
- An email sign-up for an address that already has an account changes nothing (and the answer is the same, as without a
  cookie: the sign-up never says whether an address has an account).
- `posthog_captured_at` is the time of writing and is what makes the rule; it is set even when only one of the two
  identifiers came.

## Retention and deletion

The values live on the user row and nowhere else (no log, no other table, no copy in a session or a token), and they go
with the row: the cleanup of a sign-up that never verified its address (`src/maintenance/cleanup.ts`) and the retirement of a
user in the merge (`src/github-signin/merge.ts`) delete the row, and with it the values. `users` is global, not a
workspace's data, so deleting a workspace (`src/workspaces/delete-workspace.ts`) does not touch them; the app has no
account-deletion feature yet (the landing page's privacy policy says the values are deleted with the account: any future deletion of a user is the deletion of the row, and `no-readers.test.ts` guards that no second copy exists), and when it gets one it deletes the row (a request for erasure is a deletion of the user,
columns included). The values are kept as long as the user exists. The privacy policy on the landing site names the
processing (storing the PostHog identifiers of consenting visitors on the account); it is maintained there, not here.

## Not exposed

Not in any page, API answer or session (`src/landing-identity/sign-in.integration.test.ts` reads the session Better
Auth returns), and not in a log line (failures are logged with the error name only). `no-readers.test.ts` fails when
a source file other than the schema, the migration and `store.ts` names a column, so a later reader is a decision, not an
accident.

## Tests

`identity.test.ts` (the strict shape, the cookie value), `capture.test.ts` (the proxy step), `store.integration.test.ts`
(first touch), `sign-in.integration.test.ts` (the cookie through the real GitHub redirect and the email form),
`sign-up.integration.test.ts` (the email sign-up), `deletion.integration.test.ts`, `no-readers.test.ts`, the migration
test `src/db/migrations/add-users-posthog-identity.integration.test.ts`, and the journey `e2e/auth/landing-identity.e2e.ts`.
