# 0001: One codebase for self-hosted and hosted, first-run setup, accounts and workspaces

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** decided by the project (decisions of 2026-10-11, revised after review the same day)
- **Implemented by:** milestone "Phase 1b: Setup and accounts" (GitHub Issues)

## 1. Context

Code Reviewer started as a tool for one team on one server. The code in `app/` reflects that:

- **One tenant.** There is no workspace concept. Integrations (`integrations`), repositories, projects,
  jobs and the review defaults (`app_settings`, key `review_defaults`) all belong to "the instance".
- **Sign in is GitHub only and configured by environment variables.** Better Auth runs a GitHub
  OAuth app (`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`), and who may sign in is decided
  by `ALLOWED_GITHUB_LOGINS` and `ALLOWED_GITHUB_ORG` (`app/src/auth/README.md`). Logins on the list are
  bound to a numeric GitHub id in `allowed_login_pins`. `users.github_login` is required, so a user
  without a GitHub account cannot exist. The old sign-in does not establish a verified email address.
- **The GitHub App is configured by environment variables** (`GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
  `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY`) after a manual, roughly 30 minute procedure
  (`docs/github-app.md`). The people sign in with a second, separate GitHub OAuth app.
- **The LLM access is one shared key** from `LLM_PROVIDER` and `LLM_API_KEY`, never stored
  (`app/src/llm/README.md`).
- **Mail does not exist.** There is no way to send an email, so there is no email verification,
  no password reset and no invitation by mail.
- **The database is SQLite only** (Kysely with better-sqlite3, `app/src/db/`). Several parts of the
  app assume exactly one app process: the claim of a job is a single SQLite statement that relies on
  SQLite's single writer lock (`db/repositories/jobs-claim.ts`; its header says a Postgres port only
  needs `FOR UPDATE SKIP LOCKED`, which is not enough, see section 2.10), the GitHub App status is
  cached in memory for 30 seconds (`SETUP_CACHE_MS` in `integrations/registry.ts`), the LLM keys handed
  to runners are remembered in memory (`runner-api/claimed-keys.ts`), the repository sync serializes
  work with an in-process lock (`integrations/sync/keyed-lock.ts`, `coalesce.ts`), and the backup
  scheduler runs inside the app (`backup/`).

Two things are now wanted at the same time:

1. A **small deployment** that a single team starts with one `docker compose up` and configures in the
   browser, without editing environment variables for anything but the technical basics.
2. A **large (hosted) deployment** that serves many unrelated teams: several stateless app instances,
   several workers, an external Postgres, accounts that are not tied to GitHub, workspaces with
   members, and an operator who runs the whole thing.

Two products, two codebases, and a pile of environment variables would not survive contact with
maintenance. The decisions below keep one codebase and one set of features, move configuration from
the environment into the database and an admin portal, and introduce accounts and workspaces.

## 2. Decision

### 2.1 One codebase, two topologies

The small and the large deployment have **identical functionality**. They differ only in topology and
database.

| | Small (self-host) | Large (hosted) |
|---|---|---|
| Processes | `app` container and `runner` (worker) container | `app` (1..n, stateless) and workers (1..n) |
| Database | SQLite in a volume | External Postgres through `DATABASE_URL` |
| Deployment file | One `compose.yml` | A compose or orchestrator example with Postgres and several replicas (delivered by this milestone as a documented example) |
| Backups | Done by the app (existing `src/backup/`) | Done by the operator with Postgres tooling or the managed service |

`DATABASE_URL` selects the database. A `sqlite:` URL, a path form or an **empty value** means SQLite
(the default location stays `/data/app.db` in the image); a `postgres://` or `postgresql://` URL means
Postgres. There is no feature that exists only in one of the two modes. Mode-specific code is limited
to the database dialect and the places listed in section 2.10.

**Environment variables.** Product settings never live in the environment. The environment keeps:

- the **technical** settings: the public URL of the app (today `BETTER_AUTH_URL`; the name may change
  during implementation and the old name keeps working), `APP_SECRET`, the runner token
  (`RUNNER_TOKEN`) and the database URL;
- **operational tuning** settings that describe how a deployment runs rather than what the product
  does, and that stay optional environment variables: runner concurrency, timeouts and polling
  (`RUNNER_*`), the database busy timeout, the backup time and directory, the debounce of automatic
  reviews (`REVIEW_DEBOUNCE_SECONDS`), the database pool size.

Everything a product decision depends on (who may sign up, the GitHub App, mail, limits, keys) lives in
the database and is edited in the admin portal.

`APP_SECRET` is the master key (section 2.7 for how it is used). It is generated by the operator (for
example `openssl rand -base64 32`, at least 32 characters), **must be backed up separately from the
database** and cannot be recovered: a database restored without its `APP_SECRET` loses all stored
credentials. It replaces `BETTER_AUTH_SECRET`; for an existing installation the old variable is
accepted as the value of `APP_SECRET` when the new one is not set, so existing sessions and encrypted
tokens stay valid (section 2.11).

### 2.2 First-run setup

The state of the instance is kept in two explicit markers in `instance_settings`, never inferred from
whether a row exists:

- `setup_completed_at`: null until the wizard has finished, then the time of completion. "Set up" means
  this marker is set.
- `import_state`: `none` (the import of section 2.11 has not run or was not needed) or `done`. The import
  is one all-or-nothing transaction, so there is no state in between.

Two cases are told apart at start. A database from before this milestone has neither marker, which reads
as `setup_completed_at` null and `import_state` `none`.

- **Fresh installation:** the database has no users and `import_state` is `none`.
- **Existing installation:** the database has users and `setup_completed_at` is null, with **any**
  `import_state`. It gets the same setup, shortened by the automatic data import of section 2.11, which
  runs once: it runs while `import_state` is `none` and sets it to `done` in its own transaction. The
  case "`import_state` `done`, `setup_completed_at` null" is a restart before the wizard finished.

A restart before the wizard has finished prints a new code and shows the wizard again; nothing that
was imported is imported twice.

While the instance is not set up:

1. **Setup code.** Every start of an app process prints a fresh 6-digit setup code to the app's
   terminal and log (never to a web page), for example `Setup code: 482913`. The code is generated
   with a cryptographically secure random source and kept **in the memory of that process** (as a
   hash), together with its failure counter. It is valid for **60 minutes**; after that, the app must
   be restarted to print a new one.
2. **The site asks for the code.** Every page and API route, except what the setup itself needs
   (`/api/health` and static assets), shows the code form instead. For an existing installation the
   gate covers the web UI only: webhooks and the runner API keep working with the imported settings,
   so reviews do not stop while the operator has not yet found the code. Rules:
   - at most about 5 attempts per minute, counted per process rather than per source address (a
     reverse proxy makes source addresses unreliable, and only the operator is meant to use this),
   - after **10 failed attempts the setup endpoint locks until the app is restarted**, which prints a
     new code; there is no automatic rotation,
   - the code is single use: a correct code is consumed and exchanged for a short-lived signed setup
     session (30 minutes) that carries the wizard; when the session expires unfinished, the app must be
     restarted for a new code,
   - the code stops being valid once the setup is completed, and the form is never shown again.
3. **The wizard** asks three things, in this order:
   1. **Tenancy:** single-tenant or multi-tenant.
   2. **Sign-up rule:** everyone, a list of emails, or allowed email domains. All three can be chosen
      here; section 2.5 says what an email or domain rule does while addresses cannot be verified yet
      (it is fail-closed).
   3. **Instance admin account:** an email and a **mandatory strong password**. The password rule
      applies to **every** email and password account, not only to the admin: at least 12 and at most
      128 characters and not on a bundled list of common passwords. There are no composition rules
      (no "one digit, one symbol"). The server checks it; the form shows the reason.
4. **Completion** is one transaction that creates the admin account, stores the choices, marks the
   instance as set up and invalidates the code. Two people finishing at the same moment cannot both
   win. The admin lands in the admin portal at `/admin`. In single-tenant mode the same transaction
   creates the one workspace (or, for an existing installation, uses the imported one) and makes the
   admin its Owner (section 2.6). In multi-tenant mode the admin becomes Owner of an imported
   workspace only if the import left it without an Owner; a fresh multi-tenant instance has no
   workspace until somebody creates one.

**Trade-offs, stated openly.** A 6-digit code is a deliberate project decision for convenience. Its
protection is the lock after 10 failures and the fact that the code is only in the process memory and
log of the server. An attacker who can reach the site can force a lock, and the operator then has to
restart the app (a denial of service for the setup), but cannot get in: the chance to guess the code
is at most 10 in 1,000,000 per restart. Because the code and the counter are **per process, the setup
must be done with a single app instance running**; in a multi-instance deployment start one instance,
finish the setup, then scale out.

### 2.3 Admin portal

The instance admin (a user flag, separate from workspace roles) uses `/admin`. An anonymous visitor is
redirected to sign-in; a signed-in user who is not an instance admin gets a 404 (no hint that the
portal exists). The admin keeps portal access even when their email address is not verified (section
2.5), so that a mail problem can always be fixed. It offers:

- **Setup choices.** Tenancy and sign-up rule can be changed at any time, with two restrictions:
  single to multi is always allowed; multi to single is allowed only while **at most one workspace
  exists** (if none exists, the default workspace is created and the admin becomes its Owner). The
  sign-up rule can always be changed; an email or domain rule shows a notice while it is fail-closed
  (section 2.5). Changing the sign-up rule affects new accounts and new invitations; it does not delete
  or lock existing accounts.
- **Sign-in methods.** Email with password and GitHub can each be switched off, but at least one stays
  on. GitHub can only be on when the GitHub integration is configured. **Switching to GitHub only is
  refused unless the acting admin has a linked GitHub identity**, so the admin cannot lock themselves
  out.
- **Integrations.** One tile per integration. GitHub is the first (section 2.4). GitLab and Bitbucket
  come later as further tiles behind the same provider interface (`app/src/integrations/`).
- **Mail server.** SMTP host, port, user, password, sender address, transport security. The password is
  stored encrypted (section 2.7). A "send test mail" button sends a mail to the admin's address and
  reports the result. **Mail is never configured through environment variables.** SMTP may be removed
  at any time (rules that depend on it become fail-closed, section 2.5).
- **Instance limits.** The maximum number of workspaces per user (default **10**). Later: the
  operator's LLM key for "included" usage and pricing (section 2.8).
- **Approvals.** Requests to link a GitHub installation that need the instance admin (section 2.9).

**A lost admin password.** With SMTP the normal password reset mail works. Without SMTP, a command
inside the app container, `admin reset-password <email>`, prints a **single-use reset link valid for 30
minutes**. Having shell access to the server's container is the proof of operator rights.

### 2.4 GitHub integration: one GitHub App for sign-in and for reviews

The integration is configured at instance level by the instance admin, in two ways:

- **One click (manifest flow).** The admin portal sends the admin's browser to GitHub with an app
  manifest (name, public URL, webhook URL `<public URL>/api/webhooks/github-app`, the repository
  permissions and events from `docs/github-app.md`, the account permission to read email addresses,
  the callback URL for sign-in (user authorization), and the setup URL for the installation binding).
  The manifest requests, besides the repository permissions of `docs/github-app.md`, the account
  permission **Email addresses: read-only** (so the verified primary email of a GitHub sign-in can be
  read and replaces the placeholder noreply address of an imported user) and the organization
  permission **Members: read-only** (so a user's organization role can be read with the GitHub App user
  token, section 2.9).
  The manifest says whether the app is public (multi-tenant) or private (single-tenant); the portal
  records that choice as the "private app" flag. GitHub redirects back with a short-lived code; the app
  exchanges it for the app id, slug, private key, webhook secret, client id and client secret, and
  stores them encrypted. The state value of the round trip is signed and bound to the admin's session.
- **Manual entry.** Step-by-step instructions, then a form for the same values (app id, slug, private
  key, webhook secret, client id, client secret) and a checkbox "this app can only be installed on its
  own account" (the private flag, which GitHub's API does not report). Values are validated before they
  are saved (the key must parse, a call to GitHub with the app JWT must succeed).

The **one GitHub App provides both** "Sign in with GitHub" (its user authorization, replacing the
separate OAuth app and `GITHUB_OAUTH_*`) and pull request reviews (installation tokens, webhooks). The
GitHub App's **user access token** is also what proves a person's rights on an installation (section
2.9), which the old OAuth app could not do. The environment variables `GITHUB_APP_*` are imported once
(section 2.11); `GITHUB_OAUTH_*` are never imported. An App that was imported or created by hand may
lack the two permissions above; the portal lists what to add in the App's settings (installations have
to accept the changed permissions on GitHub).

### 2.5 Verified emails and what a sign-up rule may be

There are exactly three sign-up rules: **everyone**, **a list of emails** and **allowed email
domains**. There is no rule based on a GitHub organization. All three can be chosen at any time, in the
wizard and in the admin portal.

**Verification.** An email address can be verified in two ways: through **SMTP** (the app sends a
verification link) or through **GitHub** (a GitHub sign-in uses the verified primary email address that
GitHub reports; the old OAuth sign-in did not provide one).

- **When SMTP is configured, every email and password account must verify its address**, also under
  the rule "everyone". An unverified account cannot use the app. Accounts that existed before SMTP was
  configured are asked to verify at their next sign-in. **The instance admin is included**, but keeps
  access to `/admin` meanwhile so that SMTP can be repaired.
- Without SMTP no email can be verified; email and password accounts are usable unverified under the
  rule "everyone".

**A verification link is bound to the password of the sign-up that made it.** Someone can sign up with
another person's address before that person does (an account pre-hijack): the owner then gets a mail, and a
link that merely marks the address as verified would hand the account, with the password the attacker chose, to
the attacker as soon as the owner clicks it. Therefore:

- every link is stored with the password hash of the sign-up that made it, and is used on the verification page
  **with that password**, in the same request; the link is only used up when the password matches the hash bound
  to it. A wrong link and a wrong password are one answer and count against the link's attempts;
- a repeat sign-up for an address whose account waits for verification **never replaces the account's
  password**: it mails one more link, bound to the new password, and gives the same answer as a new account.
  Several links can be pending at once, so signing up again cannot keep the owner's link from working;
- when a link is used, its hash becomes the account's password (the sessions of the account end if the password
  changed), the address is verified, and every other pending link of the account is deleted. A password reset
  also deletes the pending links, because using one would put the old password back;
- the effect: someone who clicks a link from another person's sign-up cannot complete it, because they do not
  know that person's password, and the link of their own sign-up works with their own password.

Without SMTP there is no verification and so no such protection: an address can be claimed by whoever signs up
first, and a sign-in after a sign-up shows whether the address was taken. That mode is accepted (see above).

**Rules that name emails or domains** are only meaningful for verified addresses. They are
**fail-closed** while no verification path exists, that is, when there is no SMTP **and** sign-in is not
GitHub only:

- nobody except the instance admin can sign up (the instance admin account is exempt from the rule),
  and no invitation can be created under the rule, because it cannot be evaluated safely;
- the admin portal shows a clear notice on the overview and on the sign-up rule setting that says what
  to configure (SMTP, or GitHub as the only sign-in method);
- the rule starts working as soon as a path exists. This is also the state right after the wizard if
  such a rule was chosen, because neither mail nor GitHub exists yet at that point.

The state is evaluated when it matters, not when the rule is saved. Removing SMTP while such a rule is
in force is allowed; it makes the rule fail-closed again and shows the notice. Existing accounts are
never affected.

**Matching** is case-insensitive. A domain entry matches exactly that domain, not its subdomains. The
rule is evaluated against the verified email when an account is created and when an invitation is
created.

**Linking a GitHub identity to an existing account** happens in exactly two ways: from that account's
own settings while signed in, or automatically when GitHub reports the **same verified email** and the
existing account's email is verified too. An unverified match never links (no account takeover through
an unverified address). Identities from the old OAuth sign-in are matched by their numeric GitHub id.
Imported users (marked by `users.imported_at`) have a placeholder (noreply) email; it is **replaced by
GitHub's verified primary email at their next GitHub sign-in**. If that verified email already belongs
to **another account**, the placeholder is kept and nothing is taken over or merged; a hint is shown in
the user's profile and to the instance admin.

**Merging the instance admin with an imported operator.** In an existing installation the person who
runs the instance usually exists twice after the short setup: as an imported user (GitHub identity, no
password) and as the instance admin (email and password). When the signed-in instance admin links a
GitHub identity that belongs to an imported user **without any other credential** (no password), the two
accounts are **merged**: the imported user's memberships and history move to the admin account, the
higher role wins where both are members, and the imported user row is retired. Conditions:

- Only users **marked as imported** (`users.imported_at`, set by the import) qualify. A user created
  later never does.
- The admin must complete **GitHub user authorization for that identity**; that proves control of it.
- The merge runs as **one irreversible transaction**.
- If that GitHub identity belongs to a user who has **other credentials**, linking is refused with a
  clear message.

The merge is what lets the admin meet the "GitHub only" guard of section 2.3.

### 2.6 Accounts, workspaces, roles and invitations

**Users and identities.** A user is a person. A user has one or more **login identities**: email with
password, GitHub, and later others (for example OIDC). Identities are decoupled from **git provider
connections**: signing in with email and password does not require a GitHub account, and a GitHub
sign-in does not by itself connect any repository. Better Auth's `accounts` table already models
identities (`provider_id`, `account_id`); `users.github_login` becomes optional.

**Workspaces (tenants)** have **members** with a role: **Owner**, **Admin** or **Member**.

| Role | Can |
|---|---|
| Member | Use the workspace: see projects, runs and settings, start reviews, change project settings |
| Admin | Everything a Member can, plus manage connections, repositories and the BYOK LLM key, and manage Members and invitations (invite, remove, revoke; Members only) |
| Owner | Everything an Admin can, plus manage Admins and Owners (invite, change roles, remove) and rename the workspace (deleting a workspace is a follow-up) |

The exact matrix is tested table-driven in the implementation issue; the principle is that every action
needs the lowest role that is safe. **The last Owner cannot leave, be removed or be demoted**; an Owner
must first make somebody else an Owner.

**Invitations.** Owners invite with any role; Admins invite Members.

- **The sign-up rule applies to invitations.** Only emails that the current sign-up rule allows can be
  invited; an invitation does not override the rule. (An email list rule therefore needs the address
  on the list first.)
- An invitation is a **single-use link bound to that email address**. It expires after **7 days** and
  can be revoked by an Owner, or by an Admin for Member invitations. The token is random with 256 bits;
  only its hash is stored.
- With SMTP configured the invitation is sent by mail. Without SMTP it is shown as a link the admin can
  copy and send themselves.
- **Accepting** requires being signed in with that email address, verified. **Without SMTP an invitation
  can only be accepted through its link (the token)**: the link itself proves the address, and opening
  it, then signing up or signing in with that email, accepts it. Without SMTP, pending invitations are
  **never** found by looking up an email address.
- With SMTP, after sign-up or sign-in a user sees the **pending invitations for their verified email**
  and can accept them. Pending invitations are listed by email **only for verified emails**.

**What a user sees without an invitation.**

- **Multi-tenant:** the user is asked to **create a workspace** and becomes its Owner. Any user can
  create further workspaces at any time while multi-tenant is active (subject to the instance limit
  "max workspaces per user", default 10). A **workspace switcher** in the navigation moves between
  workspaces.
- **Single-tenant:** the user sees "Ask an admin of this instance for an invitation" and has **no
  access** until invited. There is **no automatic join**, even when the sign-up rule lets the person
  create an account.

**Which workspace a request is about** (decided with the implementation, issue #101). The workspace is part of
the address: pages live below `/w/<slug>` and data routes below `/api/w/<slug>`. It is not a cookie or a header,
because an address is what links, bookmarks and a second browser tab carry: deep links keep working, two tabs
can work in two workspaces, and nothing remembered by the browser can point a request at a workspace by
accident. The slug is never trusted: on every request it is looked up among the memberships of the signed in
person, and a workspace they do not belong to is exactly as absent as one that does not exist (a missing path,
with the same answer in every detail). The instance admin is not a member of a workspace by being the admin.
The switcher in the navigation links the workspaces of the person; `/` opens the first one.

**Roles of the first implementation.** Besides what the table says: switching a project on or off and changing
the review defaults of a workspace need an Admin (they decide which repositories are reviewed and what a review
costs), a Member changes the settings of a project. Only an Owner changes roles; an Admin cannot hand out a rank.

### 2.7 Instance level versus workspace level

| Level | What lives there | Who changes it |
|---|---|---|
| Instance | Tenancy, sign-up rule, sign-in methods, SMTP, the GitHub App credentials (app id, slug, private key, webhook secret, client id, client secret), the "private app" flag, instance limits, later the operator's LLM key and pricing | Instance admin (the operator in the hosted version) |
| Workspace | Connections (GitHub App installations), repositories, projects, review settings, BYOK LLM key, members, invitations | Workspace Owner or Admin |

**Credentials at rest.** Every secret stored in the database (SMTP password, GitHub App private key,
webhook secret, client secret, LLM keys, the remembered keys of claimed jobs) is encrypted:

- a key per **purpose** is derived from `APP_SECRET` with **HKDF-SHA256**;
- the cipher is **AES-256-GCM** with a **random 96-bit nonce** per encryption;
- the **additional authenticated data** is table name, row id and field name, so a ciphertext copied to
  another row or field does not decrypt;
- a **key version** is stored with every secret so that a rotation command can be added later.

Secrets are never returned by any API after they were saved (the UI shows that one exists and, where
useful, the last four characters), never logged, and never included in error messages. **The operator
can decrypt every secret by design**, because the operator holds both the database and `APP_SECRET`;
a hosted operator therefore can read workspace keys, and this must be said in the hosted terms.

**Workspace BYOK keys are now persisted**, encrypted. This reverses the earlier guarantee that the LLM
key is "never stored" (`app/src/llm/README.md`), which held while there was exactly one key in the
environment. The documentation of the `llm` module must be updated with the change.

**Tokens.** Verification, password reset and invitation tokens are random with 256 bits, stored only as
hashes, single use, and expire: verification 24 hours, password reset 30 minutes, invitation 7 days. A verification token is also bound to the address it was made for and to the password hash of the sign-up that
made it (section 2.5), and several can be pending for one account; expired and used verification tokens and
spent rate-limit counters are removed by a periodic cleanup. The
**setup code** is single use and kept only as a hash in process memory. The **setup session** that
follows a correct code is a signed cookie valid for 30 minutes, not a stored token.

**Data model sketch.** The exact schema belongs to the implementation issues; the shape is:

| Table | Purpose |
|---|---|
| `workspaces` | id, name, slug, created by, created at |
| `workspace_members` | workspace, user, role |
| `invitations` | workspace, email, role, token hash, invited by, expires at, accepted at, revoked at |
| `instance_settings` and `secrets` | non-secret settings as JSON, and encrypted secrets with key version |
| `rate_limits` | shared counters for sign-in, verification, reset and invitation endpoints |
| `installation_link_requests` | requests to link an installation that need the instance admin (section 2.9) |
| `integrations.workspace_id` | a connection belongs to exactly one workspace; denormalized onto `repositories` and `jobs` (with an index) so that listing, scoping and usage queries do not need joins |
| `app_settings` (existing) | the review defaults become per workspace |

Every query that reads or writes workspace data is scoped by `workspace_id` through one helper; a
test fails when a repository function takes no workspace.

### 2.8 LLM key resolution

For a review job, the LLM access is resolved in this order:

1. The **workspace's own key (BYOK)**, entered by an Owner or Admin in the workspace settings.
2. Otherwise the **operator's key**, if the operator offers "included" usage. Usage is then counted per
   workspace. (The operator key, the "included" switch and the counting belong to the pricing phase;
   this record fixes only the order and keeps room for it in the schema.)
3. Otherwise the job fails with `llm_not_configured`, as today.

The runner receives the resolved key in the claim response as it does today; keys never reach the
browser.

### 2.9 Binding a GitHub App installation to a workspace

There is one GitHub App for the whole instance, and any account may install it. The app must therefore
decide which workspace a new installation belongs to, and must not hand repositories of one customer to
another. The binding is **fail-closed**: when a condition cannot be established, nothing is linked.

1. In a workspace, an Owner or Admin chooses **Connect GitHub**. This needs the GitHub App's user
   authorization to be configured (client id and secret, section 2.4); **until it is, "Connect GitHub"
   is unavailable in multi-tenant mode** and the page says why. The app creates a **signed state**
   (HMAC with a key derived from `APP_SECRET`) that contains the workspace, the user, a random nonce
   and an expiry of 10 minutes. The nonce is stored and can be used once.
2. The browser goes to the GitHub App's installation page with that state.
3. After the installation, GitHub redirects to the app's setup URL with the **installation id** and
   the **state**.
4. The app verifies the signature, the expiry and the nonce, and that the signed-in user is the one in
   the state and still Owner or Admin of that workspace.
5. The app verifies, **with the user's own GitHub App user token**, two things: the user **can access
   the installation** (it appears in the installations the user may use), **and** the user is an
   **owner or admin of the installation's account**: the personal account itself, or an owner of the
   organization. The organization role is readable because the manifest requests the organization
   permission **Members: read-only**. A user who signed in without GitHub is asked to connect their GitHub account first
   (GitHub's user authorization, no new account is created).
   **If the user's role in the organization still cannot be read** with the token (for example the App
   lacks the permission), the request is not linked; it becomes an `installation_link_request` that the
   **instance admin approves or denies** in the admin portal. The approval page shows the requester, the
   installation's account and the **evidence**: whether the user's token can access the installation
   (yes or no) and the result of the role read. There is no weaker fallback: access to the installation,
   or admin rights on a single repository, never suffice.
6. Only then the app links the installation to the workspace, and the repository sync starts for it.
   An installation can be linked to **one** workspace only; a second attempt fails with a clear error.

Consequences of this design:

- **Multi-tenant:** installations are never created from a bare webhook or from the app-wide
  installation listing. An `installation created` webhook for an installation without a link is
  recorded as unclaimed and ignored for everything else. A **"link an existing installation"** picker
  lists the installations the user can access that are not linked yet; it applies the same checks and
  covers installations that needed approval from an organization owner first.
- **Single-tenant:** an installation is attached to the one workspace automatically **only** when the
  GitHub App is **private** (the "private app" flag of section 2.4: it can only be installed on its own
  account) **and** the installation is on that account. Everything else needs the explicit Connect
  flow with the same checks.
- A webhook is attributed to a workspace through the installation id of its connection.
- Installations that were already linked before the update (section 2.11) keep their link.

### 2.10 Requirements for the large topology (several instances)

The large topology only works if no app instance relies on its own memory. The following must change;
each point has a test with two simulated instances:

| Today | Required |
|---|---|
| Claimed LLM keys list in memory (`runner-api/claimed-keys.ts`), so a rotated key can still be masked in a result | Kept in the database, encrypted, removed together with the job's retention, so any instance can mask a result |
| GitHub App status cached for 30 seconds in memory (`SETUP_CACHE_MS`) | No in-process cache of configuration; read from the database (a cache may only exist with a version check against the database) |
| Backup scheduler inside the app | Runs only for SQLite; for Postgres the operator backs up the database |
| Sync serialized by an in-process lock (`keyed-lock.ts`, `coalesce.ts`) | Serialized by a database lock per connection (advisory lock on Postgres, an equivalent on SQLite) |
| Migrations run once, protected by the SQLite write lock | Migrations run behind a lock that makes concurrent starts wait; exactly one instance migrates |
| Job claim is one SQLite statement; "one running job per pull request" holds because SQLite has one writer | On both databases a **partial unique index on running jobs per pull request** guarantees the rule. The Postgres claim uses `FOR UPDATE SKIP LOCKED` and treats a **unique violation as "skip this job, try the next"**. `FOR UPDATE SKIP LOCKED` alone is not enough: two runners could otherwise start two jobs of one pull request. Same behavior, same test suite |
| Rate limits (sign-in, verification, reset, invitations) | Shared counters in the database (`rate_limits`), never in memory |
| Setup code and its counter | Per process, by design (section 2.2): the setup is done with one instance running |

The runner API needs no change for several workers: the lease token already makes a claim
instance-independent.

### 2.11 Migration of existing installations

An existing installation (environment variables set, a SQLite file with data, users but no instance
settings row) must update without losing data and without a long new setup. On the first start of the
new version:

1. **Backup.** The existing backup module takes a backup of the SQLite file first; the import does not
   run if that fails. The backup lies outside the import's transaction, so if the import fails and the
   next start runs it again, another backup may be taken. That is harmless.
2. Migrations create the new tables.
3. **Automatic import**, in one transaction:
   - **One default workspace** is created and receives all existing integrations, repositories,
     projects, jobs and review defaults.
   - **GitHub App settings** (id, slug, private key, webhook secret) and the **LLM provider, key and
     model** from the environment are imported into the database; the LLM key becomes the default
     workspace's key. `GITHUB_OAUTH_*` are not imported.
   - **Members.** Existing users who **pass the current allow list at import time** become Members: a
     listed login whose pinned GitHub id matches, or, if `ALLOWED_GITHUB_ORG` is set, a **live
     organization membership check**. The earliest created of them becomes **Owner**. Users who would
     be blocked today are not imported as members; a user whose check cannot be completed (GitHub
     unreachable, stored token undecryptable) is treated as blocked and listed in the notice. The
     default workspace always ends with at least one Owner: if no user qualifies, the instance admin
     becomes Owner.
   - Imported users are marked with `users.imported_at`.
   - No sign-up rule is derived from the allow list. The old sign-in has no verified emails, so no
     email list is built from existing users.
4. After the import the variables are ignored and the log says so once, listing names only.
   `BETTER_AUTH_SECRET` is used as `APP_SECRET` when `APP_SECRET` is not set.
5. The instance is **not yet set up** (`import_state` `done`, `setup_completed_at` null): the **short
   setup** of section 2.2 runs (code in the log, the wizard with tenancy, sign-up rule and the instance
   admin account). A restart before the wizard finishes prints a new code and shows the wizard again. Webhooks and the runner API keep
   serving the imported settings meanwhile. In single-tenant mode the wizard's admin becomes an Owner of
   the default workspace as well.
6. **After setup, sign-in is by email and password only** (the admin) until the admin enables sign-in
   through the GitHub App: the portal prompts for it (client id and secret of the App's user
   authorization, and the callback URL to register in the App's settings). Existing users then sign in
   with GitHub and are recognised by their numeric GitHub id; their placeholder emails are replaced by
   GitHub's verified primary email at that sign-in (the permission "Email addresses: read-only" is
   needed). The operator who exists both as an imported user and as the new admin links their GitHub
   identity from the admin account, which merges the two accounts (section 2.5). Until then,
   "Connect GitHub" is unavailable in multi-tenant mode, which the portal states. The "private app" flag is not known for
   an imported App; the portal asks the admin to confirm it, and until then new installations need the
   explicit Connect flow.
7. A one-time portal notice lists what could not be migrated: allowed logins that never signed in
   (invite them by email), users whose check failed, and an allowed GitHub organization (see
   consequences).

The import is one all-or-nothing transaction, guarded by `import_state` (`none` to `done`). A crash or a
failure during the import leaves no partial data: the start ends with a readable line, and the next
start runs the import again from the beginning. Once `done`, a later start does nothing.

## 3. Alternatives considered

- **Two codebases or two products (self-hosted tool, hosted service).** Rejected: features would drift,
  the hosted service would not benefit from self-hosters' bug reports, and every fix is done twice.
- **Keep configuring the GitHub App, OAuth, mail and LLM key through environment variables.**
  Rejected: a hosted multi-tenant service needs these changeable at runtime by an operator, secrets in
  a database are the only workable place for per-workspace keys anyway, and a 30 minute manual GitHub
  procedure is the main obstacle for self-hosters.
- **Separate GitHub OAuth app for sign-in, GitHub App for reviews (today).** Rejected: two apps to
  create, two sets of credentials, and sign-in cannot be used to prove access to an installation.
- **GitHub as the only identity.** Rejected: GitLab and Bitbucket are planned, and some users and
  operators do not want a GitHub account to use the tool.
- **Automatic join in single-tenant mode** (anybody who may sign up sees the workspace). Rejected:
  signing up and having access to a company's repositories are different decisions.
- **Setup by environment variables or a default admin password.** Rejected: a one-time code printed to
  the log proves access to the server and needs no pre-shared secret.
- **A longer or automatically rotating setup code.** A longer code was rejected for convenience, and
  automatic rotation was rejected because it would let an attacker invalidate the operator's code at
  will; the lock until restart is the chosen protection.
- **A weaker installation check (repository admin as fallback).** Rejected: a repository admin of a
  foreign organization could link that installation and receive its repositories.

## 4. Consequences

**Easier**

- A self-hoster sets up in the browser with a code from the log; no GitHub procedure by hand.
- One feature set to document, test and support; the hosted service is the same program.
- Accounts do not depend on a git provider, which prepares GitLab, Bitbucket and OIDC.
- Per-workspace keys and limits make a hosted offering with "bring your own key" and "included" usage
  possible.

**Harder or costly**

- The data model changes at its core: every table that holds customer data gets a workspace, and every
  query must be scoped. A missed scope is a data leak between customers, so scoping is enforced in one
  helper and covered by tests that act as a second tenant.
- Secrets in the database make `APP_SECRET` a single point of failure for recovery. It must be backed
  up separately and documented loudly. Rotating it needs a re-encryption command (not part of this
  milestone). The operator can decrypt every stored secret.
- **Workspace LLM keys are now stored** (encrypted), where before the key was only in the environment.
- Sign-in becomes a larger attack surface (passwords, mail, invitations, password reset flows). Rate
  limits, token hashing and the strong password rule are part of the acceptance criteria, not
  follow-ups.
- The setup endpoint can be locked by anyone who reaches the site, until the app is restarted (section
  2.2). The setup must be done with one app instance.
- The Postgres port, the removal of in-process state and the migration of existing installations are
  large changes that must not break the small deployment; the existing test suites run against both
  databases once Postgres support lands.
- **Behavior change for existing installations.** An update needs the operator once: a setup code from
  the log, an admin account and two choices. Existing users sign in again through the GitHub App after
  the admin enables it. Users who would be blocked today do not become members.
- **Behavior change for installations that limit sign-in to a GitHub organization
  (`ALLOWED_GITHUB_ORG`).** The new model has no organization rule and the setting does not become a
  rule. Members of the organization who pass the live check at import time keep access as workspace
  members, but organization members who never signed in can no longer sign up on their own until the
  admin recreates the access as an email list or as allowed domains. The update notice and the upgrade
  guide say so explicitly. Likewise, allowed logins that never signed in must be invited by email.
- `docs/github-app.md`, the compose files and the README must be rewritten around the new setup.

## 5. Open questions

- **Two-factor authentication** for the instance admin (and later for all users): later.
- **OIDC / SSO** as a further identity: later, behind the identity model of section 2.6.
- **Existing users when the sign-up rule changes.** This record says accounts are not locked out by a
  rule change. Decide later whether the instance admin gets a "disable user" action.
- **Inviting an account the rule no longer allows.** After the rule is tightened, an existing account
  may no longer pass the rule. Decide whether it can still be invited to (or stay in) further
  workspaces. Until decided, existing accounts are never affected and new accounts must pass the rule.
- **Unlinking an installation after a disconnect.** Decide who may link an installation again after
  its workspace disconnected it, and whether a disconnect releases the one-workspace lock at once.
- **Moving from SQLite to Postgres.** There is no migration tool in this milestone. Decide whether to
  provide an export and import path for an installation that outgrows the small topology.
- **Rotation of `APP_SECRET`** and a re-encryption command.

## 6. Out of scope

- Billing, prices, the operator's LLM key, usage counting and "included" usage (pricing phase; only the
  resolution order is fixed here).
- GitLab, Bitbucket and other providers; OIDC and SSO.
- Restricting runner network egress (own issue).
- Audit log, data retention and account deletion for the hosted service.
- Organization-level billing or teams below the workspace.
- Horizontal scaling of the web UI behind a CDN; only the stateless requirement is fixed here.
