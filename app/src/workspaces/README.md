# Workspaces, roles and invitations

A workspace owns the customer data of an installation: connections (`integrations`), repositories,
projects, jobs and the review defaults. People work in workspaces with a role, are brought in by invitation
and can belong to several. The decision is in `docs/decisions/0001-editions-setup-and-accounts.md`
(sections 2.6 and 2.7); the tables are described in `src/db/README.md`.

| File                                                 | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roles.ts`                                           | `WORKSPACE_ROLES`, the three roles (the database restricts the column to the same list)                                                                                                                                                                                                                                                                                                                                                                                                        |
| `permissions.ts`                                     | The one permission matrix: what each role may do (`can(role, action)`), who may invite, revoke, change roles and remove whom. Pure; `permissions.test.ts` pins every action against every role                                                                                                                                                                                                                                                                                                 |
| `paths.ts`                                           | The addresses: `/w/<slug>/...` for pages, `/api/w/<slug>/...` for data routes, and how a path names a workspace                                                                                                                                                                                                                                                                                                                                                                                |
| `access.ts`                                          | `resolveWorkspaceAccess`: may this request act in this workspace? A pure decision over the session and the memberships                                                                                                                                                                                                                                                                                                                                                                         |
| `access-runtime.ts`, `access-response.ts`            | The running server's side: `requireWorkspace(slug)` for pages, `withWorkspace(slug, action, handler)` for data routes, `withSignedIn(handler)` for routes that are not about one workspace; the JSON answers of a refusal                                                                                                                                                                                                                                                                      |
| `create-workspace.ts`, `names.ts`, `limits.ts`       | Creating a workspace for a person (multi-tenant only, the limit of workspaces per user, the slug), and the rules for names (length, characters, the slug, line-safe text for mails)                                                                                                                                                                                                                                                                                                            |
| `members.ts`                                         | Changing roles, removing a member or leaving, renaming; the last Owner rule, under a lock                                                                                                                                                                                                                                                                                                                                                                                                      |
| `invitations.ts`                                     | Creating, resending, revoking and accepting invitations; the list of what waits for a verified address                                                                                                                                                                                                                                                                                                                                                                                         |
| `rate-limits.ts`                                     | The limits on creating invitations, accepting them and creating workspaces, in the shared `rate_limits` table                                                                                                                                                                                                                                                                                                                                                                                  |
| `http.ts`, `assemble.ts`, `shared.ts`, `acceptor.ts` | The handlers of the routes, how the services are put together over a database (the same code serves requests and tests), the wiring of the running server, and the account that accepts, as the database has it                                                                                                                                                                                                                                                                                |
| `account-view.ts`, `legacy-redirect.ts`              | What the frame and the page of a person without a workspace need (memberships, pending invitations, whether people can create workspaces); the old addresses of the pages (`/projects`, `/runs/<id>`, `/settings`) as bookmarks: the proxy answers them (and `/`) with a real 307 to the same page of the first workspace of the person (`legacyWorkspaceTarget` in `paths.ts`, `AccessGates.firstWorkspaceSlug`); the pages stay as the fallback for a person who has no workspace to lead to |
| `ui/`                                                | The Members page, the forms (invite, rename, create), the list of pending invitations, the page of a person without a workspace, the accept button and the workspace switcher                                                                                                                                                                                                                                                                                                                  |

## The current workspace is in the address

Every workspace page lives below `/w/<slug>` and every data route below `/api/w/<slug>`. Not a cookie, not a
header: an address is what a link, a bookmark and a second browser tab carry with them, so a deep link opens
the workspace it names for any member, two tabs can work in two workspaces, and nothing the browser remembers
can point a request at a workspace by accident. There is deliberately no "current workspace" that code could
ask for without naming one; the temporary resolver and the lazy default workspace of the data model issue are
gone.

The address is never believed. The slug is looked up among the memberships of the person who is signed in:

1. The proxy (`src/auth/access-proxy.ts`) asks for the role of the person in that slug on every request to
   a workspace address. No role, or a slug that is not shaped like one, and the request goes on marked as one
   for a path that does not exist: the very answer of a workspace that is not there, in every detail (status,
   headers, body). The instance admin is not a member of a workspace by being the admin.
2. The page or route asks again (`requireWorkspace`, `withWorkspace`), close to the data, because the proxy
   alone must not be the only guard. The service for the workspace (`runsServiceFor(workspaceId)`, ...) is
   only made from the answer (`access.workspace.id`), never from the slug or an id of the request;
   `guard-rule.test.ts` fails for a page or route without the guard and for a file that makes a service from
   a value of the address.
3. The services decide on their own who may do what, from the role the person has in the database inside the
   transaction that makes the change, so a caller that forgets a check still cannot hand out a rank.

A person who belongs to no workspace reaches only the pages and routes made for them
(`NO_WORKSPACE_PATHS`, `src/auth/access.ts`): `/no-access`, `/invitations`, `/workspaces/new`,
`POST /api/workspaces` and `POST /api/invitations/accept`. Everything else answers a redirect to `/no-access`
or 403 `no_workspace_access`. That holds for every identity, the GitHub ones too: being on the allow list
admits a person to the app, it gives them no workspace. A member who is removed is turned away at once, also
with the session they hold.

`/` opens the first workspace of the person (the one they joined first), or `/no-access`. The old addresses
(`/projects`, `/runs/<id>`, `/settings`) redirect to the same page in that workspace.

## Roles and the permission matrix

| Role   | Can                                                                                                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Member | See projects, runs, settings and the members; start reviews; change the settings of a project; leave                                                                                      |
| Admin  | Also switch projects on and off (which repositories are reviewed), change the review defaults, manage connections and the LLM key; invite, revoke and remove Members; see the invitations |
| Owner  | Also invite with any role, revoke any invitation, change roles, remove Admins and Owners, rename the workspace                                                                            |

`permissions.ts` is the matrix, `permissions.test.ts` pins it. Two judgments are written down here because
the decision record leaves them to this issue: switching a project on or off needs an Admin (it is "which
repositories are managed", and in a hosted instance it decides what is paid for), and the review defaults of a
workspace need an Admin (they decide what every project costs). A Member changes the settings of a project, as
the record says. Admins cannot touch Owners or other Admins, and cannot raise anybody's role.

**The last Owner cannot leave, be removed or be demoted** (`last_owner`). The count and the change are one
transaction that first takes the lock of the workspace (`WorkspaceMembersRepository.lock`; SQLite takes its
write lock for every transaction, the lock statement is what keeps the code right on a database that locks by
row), so two Owners who leave at the same moment cannot both succeed (`last-owner-race.integration.test.ts`
runs it with two real processes).

## Creating workspaces

Only a multi-tenant instance lets people create workspaces (`multi_tenant_required`); a single-tenant instance
has the one workspace its setup made. `createWorkspaceUnderTenancy` is the one place that creates a workspace
for a person: in one transaction it reads the tenancy and the limit "workspaces per user" (the workspaces the
person is an Owner of; default 10, changed on the Limits page of the admin portal; `workspace_limit_reached`),
makes the slug from the name (a taken one gets `-2`, `-3`) and the person its Owner. A name is 1 to 80
characters without control or formatting characters (they end up in mails and pages). Counted per person
(10 per hour).

## Invitations

- Owners invite with any role, Admins Members only. The address must be allowed by the current sign-up rule,
  evaluated with the sign-up's own functions (`signUpAvailability`, `evaluateSignUpRule`): `email_not_allowed`
  for an address the rule refuses, `signup_closed` while a rule that names addresses has no way to verify
  them. An instance that has switched email sign-up off (GitHub only) still invites, because the invited
  person signs in with GitHub; the invitation never overrides the rule.
- The link is `<public address>/invitation?token=...`, built from the configured address, never a request
  header. The token is 256 random bits, only its SHA-256 hash is stored, it works once, for 7 days, for the
  address it was made for. With a mail server it is mailed (the names in the mail are made one line each, so
  a name with a line break cannot start a header; the HTML is escaped); without one, or if the mail server
  refuses, the link is in the answer **once** for the person who invited to copy. A new link then needs a
  revoke and a new invitation; with a mail server the same invitation can be sent again (a resend replaces the
  token, which stops the old link).
- The rule is evaluated **again at accept** and at resend (`email_not_allowed`, `signup_closed`): an invitation
  made under "everyone" does not bring in an address that a tightened rule refuses, and it stays open for a
  rule that lets the address in again. The instance admin is exempt, as from the sign-up itself. An existing
  membership is never touched by a change of the rule.
- An invitation belongs to the workspace, not to the person who made it: when that person leaves or is removed
  the invitation stays open and works (`invited_by` is only set to empty when their account is deleted). An
  Owner can revoke it from the list.
- An address that is a member already is `already_member`, one with an open invitation `already_invited`
  (an expired one is ended and replaced). An address that has an account but is no member gets exactly the
  answer of one that has none, so the form tells an Admin nothing they cannot see on the lists.
- Limits (`rate-limits.ts`, in `rate_limits`): per person (30 an hour), per workspace (100 a day), per
  invited address across workspaces (10 a day) and for the instance. A Member who is refused burns no counter.
- **Accepting.** Opening the link accepts nothing: the page (`src/app/invitation`, public) shows what the
  invitation is about and, for a person who is signed in with the invited address, a button; the accept is a
  POST (`/api/invitations/accept`) that needs a session and the same-site check, and the page sends
  `Referrer-Policy: no-referrer` (a header from `next.config.ts` and in the metadata). A person without a
  session is sent to `/login?invitation=...` or `/sign-up?invitation=...`, which carry only a value shaped like
  a token and lead back to the invitation page only (`src/auth/invitation-return.ts`).
- The person must be signed in with the invited address (`email_mismatch`), and that address must be verified
  while the instance can send mail or the rule names addresses (`email_not_verified`); the instance admin needs
  no verification. Only under the rule "everyone" without a mail server there is nothing to verify, and the
  link is the proof of the address (ADR section 2.5/2.6).
- **Without a mail server an invitation is only ever found by its link.** With one, after sign-up or sign-in
  the invitations for the **verified** address are listed (`/no-access`, `/invitations`, the switcher) and
  accepted by id; an unverified address sees nothing listed and the id of an invitation is useless to it.
- One guarded statement uses an invitation up, so of two requests with one link only one succeeds
  (`invitation_used`); revoked and expired ones say `invitation_revoked` and `invitation_expired`; an unknown
  or damaged token is one generic `invitation_not_found`. Accepting while already a member changes nothing
  about the role. Attempts are limited per person (any token) and per invitation (10 a day; a token that does
  not exist touches no invitation counter). The hash is looked up in the database, never compared in
  application code with something an attacker controls.

## Empty states

- **Multi-tenant**, no workspace, no invitation: "Create a workspace" (the person becomes its Owner).
- **Single-tenant**, no workspace: "Ask an admin of this instance for an invitation". No access, no automatic
  join, however the account was made; `POST /api/workspaces` answers `multi_tenant_required`.

## Not here

Deleting workspaces, transferring data, SSO and teams below the workspace are out of scope. Binding a GitHub
App installation to the workspace of the person who installed it is its own issue: until then the
synchronization puts a connection that is new to the instance into the oldest workspace
(`src/integrations/sync/default-workspace.ts`) and refuses (`WORKSPACE_NOT_AVAILABLE`) when there is none. The
workspace LLM key is in place (`src/llm/`, `manage_llm_key`: an Admin or an Owner sets it, every member sees whether
there is one). The installation-binding issue gives the
synchronization with GitHub back to the workspaces (`manage_connections`, an Admin or an Owner): until then it is the
instance admin's, because it reads every connection of the instance (`src/integrations/README.md`). In the same way the
workspace pages tell a member only that GitHub or the reviews are not set up and to ask the instance admin; the names
of the variables and the provider and model are the instance admin's to read (`src/config-status/`).

The Postgres issue (#105) has work here as well: creating a workspace and the last Owner rule lean on SQLite's
serialized writers (`begin immediate`). On Postgres the creation needs a lock (or the handling of the unique
violation of the slug, so a collision never becomes a 500), see the comment in `create-workspace.ts`, and the lock of
`WorkspaceMembersRepository.lock()` has to become a real row lock.

## Tests

`permissions.test.ts`, `names.test.ts`, `paths.test.ts`, `access.test.ts`, `guard-rule.test.ts`: the pure
rules and the structure rules. `members.integration.test.ts`, `invitations.integration.test.ts`,
`create-workspace.integration.test.ts`, `last-owner-race.integration.test.ts`, `http.integration.test.ts`,
`fresh-user.integration.test.ts`, `invitation-sign-up.integration.test.ts`: the services and handlers over a
real SQLite file. `integration-tests/http/workspace-isolation.integration.test.ts`: every data route against
a second workspace and against every role. `ui/*.test.tsx`: the components. Journeys:
`e2e/workspaces/invite-and-accept.e2e.ts` (single-tenant, no mail server), `e2e/workspaces/multi-tenant.e2e.ts`.
