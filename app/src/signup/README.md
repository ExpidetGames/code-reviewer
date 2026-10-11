# Sign-up and email verification

People create an account on their own when the sign-up rule lets them, and a rule that names emails or
domains is only ever applied to addresses that can be verified. The decision is in
`docs/decisions/0001-editions-setup-and-accounts.md`, sections 2.5 and 2.6.

| File                                  | Role                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rule.ts`                             | The three sign-up rules as pure logic: `evaluateSignUpRule(rule, address)` and `canonicalEmail`. Case-insensitive, surrounding white space ignored, a plus tag is not stripped, a domain matches exactly that domain (never a subdomain), an internationalized domain is compared in punycode, an empty list lets nobody in. `invalid_email` for a malformed address, `email_not_allowed` for one the rule refuses. |
| `availability.ts`                     | `signUpAvailability`: whether the email sign-up is open right now, from the same `signUpRuleState` that drives the admin portal's notice. `signup_closed` while a rule that names addresses has no verification path, `sign_up_disabled` while email with password is off.                                                                                                                                          |
| `state.ts`                            | `readSignUpFacts`: the rule, the ways to sign in that are actually on and whether mail can be sent, read when asked, never remembered. Nothing saved for the rule is a rule that lets nobody in (`CLOSED_RULE`).                                                                                                                                                                                                    |
| `sign-up.ts`                          | The sign-up: creates the user and its password account in one transaction, unverified, and sends the verification link after the answer.                                                                                                                                                                                                                                                                            |
| `resend.ts`, `verification-mail.ts`   | A new link on request; the one place that makes a link and mails it (never throws, logs a code only).                                                                                                                                                                                                                                                                                                               |
| `verification-tokens.ts`              | The token: 256 random bits, base64url, only its SHA-256 hash stored (`email_verification_tokens`), valid 24 hours, used once by one guarded statement, bound to the address it was made for.                                                                                                                                                                                                                        |
| `limits.ts`                           | The limits of the sign-up, the mail and the use of a link, in the shared `rate_limits` table.                                                                                                                                                                                                                                                                                                                       |
| `http.ts`, `assemble.ts`, `shared.ts` | The handlers of the three public routes, how they are put together over a database and a mail sender (the same code serves requests and tests), and the wiring of the running server.                                                                                                                                                                                                                               |
| `github.ts`                           | Pure rules for the GitHub App sign-in of a later issue: the rule on the verified primary email, and when a GitHub identity links to an existing account. Nothing calls it yet.                                                                                                                                                                                                                                      |
| `ui/`                                 | The forms (sign-up, confirm, new link) and the copy for the error codes. Pages: `src/app/sign-up`, `verify-email`, `no-access`.                                                                                                                                                                                                                                                                                     |

## What a visitor can learn

With a mail server, nothing about an address. `POST /api/sign-up` answers the same (status, body, headers) for an address that is
new, that already has an account and that the rule refuses, and does the same amount of work: the password is
hashed in every case, and the mail goes out after the answer (to a new address, and to an address whose account
waits for verification; an address with a verified account gets none). The request for a new link answers the same for
an address with an account that waits, with an account that does not, and with no account. What differs is only
what does not depend on the address: that the sign-up is closed (`signup_closed`), that it is switched off
(`sign_up_disabled`), that the form is wrong (`invalid_input` with the field and a code), that the instance has
no mail server for a new link (`not_available`), or that the caller is going too fast (`429`). The copy says
"if this address may sign up". The price is that a person the rule refuses is told nothing; the admin sees who
the rule is for.

**Without a mail server** (the rule `everyone`, the only one that works then) this does not hold, and the decision
record accepts that mode (section 2.5, "Without SMTP no email can be verified"): accounts are usable at once,
unverified, so (1) a sign-up followed by a sign-in with the same password shows whether the address already had an
account (the existing account has another password), and (2) anybody can claim an address nobody has used yet,
because nothing proves they own it. Both are the nature of a sign-up that verifies nothing. Add a mail server in
the admin portal, or close the sign-up, to get rid of them.

## With and without a mail server

|                                        | Under `everyone`                                                                                                                                                | Under a list of emails or of domains                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| No mail server, email with password on | The account is usable at once, the address stays marked unverified; the address is not proven to be theirs, and a sign-in afterwards shows whether it was taken | Closed (`signup_closed`): nobody signs up, not even a listed address. The admin signs in as always            |
| Mail server                            | The account is unverified; a link goes to the address; it cannot sign in or act until the link is used                                                          | The same, for an address the rule lets in                                                                     |
| GitHub the only way to sign in         | The email sign-up is off (`sign_up_disabled`)                                                                                                                   | The same; the rule works for GitHub accounts, through the verified primary email (`github.ts`, a later issue) |

The state is looked at when it matters: removing the mail server closes a list rule again at once and lets
unverified accounts in again (nothing can be verified any more), adding one asks every unverified email
account to verify at its next sign-in. Existing accounts are never deleted or locked out by a rule change.

## Verifying an address

1. The link is `<BETTER_AUTH_URL>/verify-email?token=...`, never built from a request header.
2. Opening it shows a page with a button. The address is verified by the click, a `POST /api/verify-email`: a
   mail scanner or a link preview that opens every link in a message would otherwise use the link up first.
   The page asks browsers not to send its address as a referrer.
3. A link is used **with the password of the sign-up that made it**, in the same POST. The link is bound to that
   password's hash; the token is only used up when the password matches. On success that hash is the account's
   password (sessions of the account end when it changed), the address is verified, and every other pending link
   of the account stops working. This closes the pre-hijack: if someone signs up with another person's address
   first, the owner's mail (from either sign-up) cannot be completed with the owner's password on the attacker's
   link, a repeat sign-up never replaces the account's password, and the owner completes the link of their own
   sign-up with their own password, which then replaces the attacker's. A wrong token and a wrong password are
   one answer, `invalid_token` (400), and count against the 10 attempts of the link; `token_used` (409) and
   `token_expired` (410) are only told to somebody who has the password, and nothing changes in any refusal. A
   link opened in a browser that is signed in as somebody else is `invalid_token` too, and stays valid. A reset
   of the account's password (`admin reset-password`) drops its pending links, because using one would put the
   old password back.
4. Several links of one account can be pending (one per mailed sign-up); making one does not cancel the others,
   or somebody could keep a person's link from working by signing up again. A new link on request
   (`POST /api/verify-email/resend`) is bound to the password the account has now.
5. An account that has not verified its address is refused at the sign in while a mail server exists
   (403 `EMAIL_NOT_VERIFIED`, after the right password, no session; `src/auth/unverified-sign-in.ts`), and a
   session it already holds is turned away at every request (`src/auth/access-gates.ts`). The instance admin
   signs in and keeps `/admin`.

## Limits

All in `rate_limits`, so every app instance counts the same attempts, and keyed on the canonical address (a
hash, no address is stored), never on a client address. The sign-up: 10 per hour per address and 60 per minute
for the instance. A verification mail (sign-up and new link share it): 5 per hour per address and 200 per 10
minutes for the instance. A link: 10 attempts per link that exists in the 24 hours it lives; a token that does
not exist touches no counter and there is no counter for all links, so junk requests can never use up the
attempts of a person's valid link. The counter for an address is asked first, so attempts beyond it do not use
up the instance's. The sign in keeps the limit of `src/auth/sign-in-limit.ts`. A refusal by a limit is
`429 rate_limited` with `Retry-After`, the same for every address; counters that cannot be read refuse the
request (`503 unavailable`), they never wave it through. The server removes old counters and spent links every hour (`src/maintenance/`). The price of keying on the address: somebody can use
up the mail budget of an address and so keep its owner from asking for a new link for an hour; a link already
in the inbox keeps working.

## How a request is read

The three routes read their request exactly once (`src/http/json-body.ts`): same site, `application/json` only,
a 4 KB limit, parsed once, and everything behind that uses the parsed values. Nothing hands the body on to a
second parser, so a limiter and the code behind it cannot see two readings of one request. Better Auth's own
sign-up endpoint stays switched off.

## No workspace, no data

A new account belongs to no workspace and nothing joins it to one: in a single-tenant instance the person sees
`/no-access` ("ask an admin of this instance for an invitation"), every data route answers 403
`no_workspace_access`. The instance admin is exempt, accounts that sign in with GitHub only are not asked. The
workspaces issue builds the invitation, the empty state of a multi-tenant instance and the workspace pages, and
replaces this interim check (`src/auth/access-gates.ts`) with them. This code creates no workspace; a
workspace is only ever created through `createWorkspaceUnderTenancy`.

## Tests

`rule.test.ts`, `availability.test.ts`, `github.test.ts`, `ui/forms.test.tsx`: the pure logic and the forms.
`verification-tokens.integration.test.ts`, `limits.integration.test.ts`: the token and the counters over a real
SQLite file. `sign-up.integration.test.ts`, `verify.integration.test.ts`, `sign-in.integration.test.ts`: the
whole flow through the real handlers, Better Auth and a mail double (`src/test-support/fake-mail.ts`), including
what no answer and no log line may contain. `src/auth/access-gates.integration.test.ts`: the gates behind the
real proxy. Journey: `e2e/auth/sign-up.e2e.ts` (its own app with a mail outbox).
