# Maintenance

Housekeeping of tables that an outsider can make grow. `cleanup.ts` removes the counters of `rate_limits` whose
window is over (every window of the app is at most 24 hours, which `cleanup.integration.test.ts` pins against
each window constant, so a counter in force is never removed) and the verification links that expired or were
used more than a week ago (a week, so that someone who holds a link and its password is still told "used" or
"expired"), and the password reset links the same way. A signed state (the single-use side of a round trip through GitHub, `src/signed-state/`) is removed once it has expired. It also removes the encrypted LLM keys that were remembered for jobs
(`job_claimed_keys`, `src/runner-api/claimed-keys.ts`) a week after the job finished, so a key that was rotated away
does not stay in the database for ever. `startup.ts` runs it when the production server starts and then every hour, from
`src/instrumentation.ts`, like the backup timer (no timer in other environments); a failing run is logged by its
code and tried again at the next hour.

## Sign-ups that never verified

A pending email and password sign-up is removed a week after it was made (`UNVERIFIED_ACCOUNT_KEEP_MS`, pinned by a test), together with its
password account and its links, so a stranger cannot leave addresses waiting forever and the table does not grow without bound. The address
is free again: a new sign-up for it is an ordinary one (new account, new link, the old link no longer works). Only a plain pending sign-up
qualifies: not verified, not the instance admin, not imported, a password account and no other identity (no GitHub), no workspace
membership, no session, and a verification link made for it (so an account that was never asked to verify is left alone), the first one more than a
week ago (so an account that is asked to verify now gets the whole week, and asking for more links, which anybody can do, does not postpone the
removal). A link is valid for 24 hours and kept a week after that, so the first link is still there when the account is a week old (a test
pins the two against each other and walks the hourly runs). It runs only while the instance has a mail
server: without one nothing can be verified and every email and password account is usable unverified, so none is removed. The same applies
if the mail settings cannot be read. The removal runs before the links are cleaned up, because the first link is the evidence.
