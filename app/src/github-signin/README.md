# Sign in with GitHub, linking and merging

"Sign in with GitHub" is the user authorization of the instance's GitHub App (`docs/decisions/0001-editions-setup-and-
accounts.md`, sections 2.5 and 2.6); this folder decides who a GitHub sign in is, links a GitHub identity to a signed-in
account, and merges the instance admin with an imported operator. The credentials (client id and secret) are in the
database (`src/github-config/`).

| File                      | Role                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decide.ts`               | `decideGithubSignIn`: the pure decision from the GitHub account id, its email addresses and what the instance knows (who owns the identity, who has the address, the sign-up rule). One stable refusal code per reason |
| `directory.ts`            | The two questions the decision asks the tables Better Auth keeps: who has this GitHub identity, who has this address                                                                                                   |
| `decider.ts`              | The decision on the running instance, with the facts read per sign in (the rule, the ways to sign in, whether mail can be sent)                                                                                        |
| `link.ts`, `link-http.ts` | Linking from the account page or the admin portal: the start (a signed, single-use state bound to the session, PKCE, rate limited) and the callback                                                                    |
| `merge.ts`                | The merge of the admin with an imported operator: one transaction                                                                                                                                                      |
| `shared.ts`               | The wiring of the running server                                                                                                                                                                                       |

The provider that talks to GitHub is `src/auth/github-provider.ts`; Better Auth runs the state, the PKCE and the session
(`src/auth/auth.ts`).

## The decision at a sign in

- **A GitHub identity that is linked** signs in as its user, whatever the sign-up rule says (the rule is about creating
  accounts), and the user is found by the **numeric GitHub id**, so a rename keeps the user. A user of the earlier
  sign in (placeholder address, no `imported_at`) is the same user.
- **An imported user's placeholder address** (`<id>@users.noreply.github.com`, a user marked by `users.imported_at`) is replaced
  by GitHub's **verified primary email** at their next sign in and marked verified. If another account has that address, the
  placeholder stays, nothing is taken over or merged, and the address is recorded in `users.email_conflict` for a hint on
  the user's account page and in the admin portal; a later sign in that finds the address free replaces it and clears it.
- **A new GitHub identity** needs a **verified primary email**: none or an unverified one is `github_email_unverified`
  (nothing is written), addresses that cannot be read are `check_failed`. If an account has that address:
  both addresses verified and no other GitHub identity on the account means it is linked
  (`email_exists_unverified` when the account's address is not verified, `github_identity_conflict` when it has another
  GitHub account already). If no account has it, the **sign-up rule is applied to the verified address** (`signup_closed` while
  a rule that names addresses has no way to verify them, `email_not_allowed`), and a new account is made with that address,
  verified. The reserved placeholder domain never passes a rule.
- **An address alone never links.** Linking happens in two ways only: the signed-in person proves control of the identity
  (below), or GitHub reports the very same verified address as the primary one and the account's own address is verified too.
- The refusal is decided before Better Auth writes anything (`user.validateUserInfo`), so a refused person leaves no user,
  account or session behind. The refusals reach the login page as `?error=<code>` with copy that says nothing about who is
  allowed (`src/auth/login-errors.ts`).
- What a session may use is not decided here but by the gates in front of the app (`src/auth/access-gates.ts`): an account that
  signs in with GitHub only is asked for a workspace, nothing else. The accounts table has two unique indexes, so an identity
  belongs to one user and a user has one GitHub identity even when two requests race.

## Linking, and the merge

`POST /api/account/github/link` (the account page) and `POST /api/admin/github/link` (the portal) start it: a signed state
(HMAC, purpose `github-link`, bound to the person and the session, single use, 10 minutes, the page it returns to) and PKCE;
10 starts per person and 2000 for the instance (a flood backstop) in 10 minutes (`rate_limits`). GitHub sends the browser back to the same callback
address as the sign in (`/api/auth/callback/github`); a state that is one of ours (it contains a dot; Better Auth's does not)
is taken by `link-http.ts`, everything else goes to Better Auth. The callback must come from the session that started it. It
uses the state up, trades the code for the user token once, and asks `GET /user` with it: that answer is the proof of control.

- Nobody has the identity: it is linked to the signed-in account (unless that account has another GitHub identity:
  `already_linked`). The user token is not kept.
- Another user has it: refused (`identity_belongs_to_other_user`, `identity_has_other_credentials` when that user has a password),
  except **the merge**. The merge applies only when the signed-in user is the **instance admin**, the owner of the identity is
  **marked as imported** and has **no other credential**, and the admin has no GitHub identity yet. It is one transaction
  (`merge.ts`): memberships move to the admin (the higher role wins where both are members, no duplicate), the history that names
  the user (`workspaces.created_by`, `instance_settings.updated_by`, `secrets.updated_by`) moves, the GitHub identity becomes the
  admin's, and the imported user is retired (the row goes, with its sessions and tokens). Irreversible. A failure halfway rolls
  everything back (`link.integration.test.ts` injects one). `USER_REFERENCES` lists every column that points at a user, and a test
  fails for a table that is not listed, so a later feature that stores a user id cannot forget the merge.
- Afterwards the admin has a linked GitHub identity, which is what "GitHub only" (Setup) asks for.

The page the browser lands on is one of two fixed paths (`/account`, `/admin/integrations`) with the outcome as a code
from a closed list, never an address from the request.

## Tests

`sign-in.integration.test.ts` (the sign in end to end through Better Auth and the fake GitHub), `link.integration.test.ts`
(linking, the merge, the state, the handlers). Journey: `e2e/admin/github-integration.e2e.ts`.

## The landing page's PostHog identity

A visitor who comes from code-review.com with `ph_did` and `ph_sid` in the link has them stored on the user at the sign in or
the sign-up (first touch, nothing else is done with them): `src/landing-identity/README.md`. For the GitHub sign in the
values wait in a one hour cookie that the redirect to GitHub and back carries, and `session.create.after` stores them.

## An invitation link through the sign in

A person who opens an invitation link without a session reaches `/login?invitation=<token>`. The GitHub button of that page
posts the token along (`signInWithGithub`, `src/auth/actions.ts`), and the action hands `/invitation?token=<token>` to Better
Auth as the callback address, which Better Auth keeps with its own state (the browser carries nothing it could change on the
way). Only a value shaped like a link token is carried and the only place it leads to is the invitation page (`src/auth/invitation-return.ts`), so
the parameter is no open redirect; Better Auth also refuses a callback address that leaves the site. The invitation page
accepts only for the address the invitation is bound to, so the account that comes back from GitHub (its verified primary
address) has to match. The tests: `src/auth/actions.test.ts` and `sign-in.integration.test.ts`, and the journey in
`e2e/workspaces/invite-and-accept.e2e.ts`.
