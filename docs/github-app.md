# Setting up the GitHub App

Code Reviewer talks to GitHub as one **GitHub App** of its own. The same App does two jobs: it signs people
in ("Sign in with GitHub", the App's user authorization) and it reviews pull requests (GitHub sends it
webhooks, and it uses short-lived tokens of the App to read pull requests and post the reviews). You set it
up once, in the browser, in the admin portal under **Integrations**: no environment variable is needed.
Plan for about five minutes with the one-click way and about 30 minutes by hand.

What you need before you start:

- The instance runs and its first-run setup is done (you signed in as the instance admin and see `/admin`).
- The public https address of the instance, for example `https://reviews.example.com` (called `<domain>`
  below). It is the `BETTER_AUTH_URL` of the deployment. It must be reachable from the internet, because
  GitHub delivers webhooks to it.
- An owner (or app manager) role on the GitHub account or organization that will own the App.

## Which way

| | One click | By hand |
|---|---|---|
| What you do | Press **Create GitHub App** on the Integrations page, press the green button on GitHub | Fill in GitHub's form with the values below, copy six values into the portal |
| Credentials | Come back to the portal by themselves, never visible to you | You copy the private key and the secrets |
| When to use it | Almost always | An App that exists already, or when GitHub's manifest page is not an option |

Both end the same way: the App id, slug, private key, webhook secret, client id and client secret are in the
portal's encrypted secret store, and none of them is ever shown again.

## One click

1. Open **Integrations** in the admin portal, **Create the App with one click**.
2. Change the name if you like (GitHub names must be unique, at most 34 characters). To create the App under an
   organization instead of your own account, enter the organization.
3. Press **Create GitHub App**. GitHub opens with everything filled in; press **Create GitHub App** there.
4. GitHub sends you back to the portal, which saves the credentials. The tile shows **Configured**.
5. Install the App on your repositories (see [Install the App](#install-the-app)).

On a single-tenant instance the App is created **private** (only the account that owns it can install it); on a
multi-tenant instance it is created **public**. The portal remembers what it asked for.

The portal sends GitHub a signed, single-use, short-lived value with this step and checks it when GitHub
returns; a callback that does not carry it (a forged one, an old one, one from another session) stores nothing.

## By hand

Open the form: for a personal account `https://github.com/settings/apps/new`, for an organization
`https://github.com/organizations/<org>/settings/apps/new` (Settings > Developer settings > GitHub Apps > New
GitHub App). The portal shows the four addresses below under **Addresses to enter on GitHub**. Fill in
exactly this and leave every other field at its default:

| Field | Value |
|---|---|
| GitHub App name | A name that is unique on GitHub, for example `Code Reviewer <Team>`. The App's *slug* is derived from it (lower case, dashes), and the bot shows up in pull requests as `<slug>[bot]`. |
| Description | Optional, for example "Automatic pull request reviews". |
| Homepage URL | `https://<domain>` |
| Callback URL | `https://<domain>/api/auth/callback/github` (the sign in with GitHub) |
| Expire user authorization tokens | Leave as is. |
| Request user authorization (OAuth) during installation | **Unchecked.** |
| Enable Device Flow | **Unchecked.** |
| Setup URL | `https://<domain>/github/connected` |
| Redirect on update | **Checked.** |
| Webhook > Active | **Checked.** |
| Webhook URL | `https://<domain>/api/webhooks/github-app` (one URL for every installation and every event) |
| Webhook secret | A long random string (`openssl rand -hex 32`). Keep it at hand: you enter it in the portal. |
| SSL verification | **Enable SSL verification.** |
| Permissions | As in [Permissions](#permissions). |
| Subscribe to events | As in [Events](#events). |
| Where can this GitHub App be installed? | **Only on this account** for a single-tenant instance; **Any account** for a multi-tenant one. |

Then press **Create GitHub App**, and collect the values on the App's settings page
(`https://github.com/settings/apps/<slug>`, or the organization equivalent):

1. **App ID**: the number at the top of the page (*About*).
2. **Slug**: the last part of the App's public link `https://github.com/apps/<slug>`.
3. **Private key**: *Private keys* > **Generate a private key**. Your browser downloads a `.pem` file and
   GitHub keeps no copy.
4. **Webhook secret**: the string you entered in the form.
5. **Client ID** and a **client secret** (*Generate a new client secret*): these are what makes "Sign in with
   GitHub" work.

Enter them under **Integrations > Enter the values by hand** and press **Save and check**. Nothing is saved
before GitHub confirms that the values belong together: the key must be an RSA private key, a call with the
App's JWT must name your App id and slug, and GitHub must accept the client id and secret as a pair. A value
GitHub does not accept is named at its field. The check of the client secret is a call that GitHub answers the
same way for a client id it does not know, so a wrong client id shows at the first sign in.

Tick **This App can only be installed on its own account** if that is what you chose above: GitHub's API does
not report it, and the portal needs it to decide whether a new installation of a single-tenant instance may
be attached to its workspace without asking.

**Leaving a field empty keeps what is saved**, but only while it still belongs to the same App: if you change
the App id, enter the key and the webhook secret again; if you change the client id, enter the client secret
again. Otherwise one wrong click could send the saved secrets to another App.

## Permissions

The manifest of the one-click way asks for exactly this, and the form of the way by hand needs exactly this. A
test (`setup-doc.test.ts` next to the manifest code) fails when these tables and the code disagree, so change
both together.

### Repository permissions

Set these four and nothing else. There is **no Checks permission** in the MVP.

| Permission (API name) | Access | What the app uses it for |
|---|---|---|
| Pull requests (`pull_requests`) | Read and write | Read the pull request (head commit, state, draft); post the review, inline comments and suggestions; edit the description (`/describe`) |
| Issues (`issues`) | Read and write | Pull request conversation comments are issue comments: the persistent review comment and the replies to `/ask`; labels and reactions on comments |
| Contents (`contents`) | Read-only | Read the changed files and the other repository files a review needs, such as `AGENTS.md` (the app never pushes) |
| Metadata (`metadata`) | Read-only | Mandatory for every app: list the installation's repositories and ask whether a commenter has write access |

The code asks for the same four permissions when it creates the token of a review job, scoped to the single
repository of that job (`JOB_TOKEN_PERMISSIONS` in
`app/src/integrations/providers/github-app/job-access.ts`).

### Account permissions

| Permission (API name) | Access | What the app uses it for |
|---|---|---|
| Email addresses (`emails`) | Read-only | Read the verified primary email of a person who signs in with GitHub. The sign-up rule is applied to it, and it replaces the placeholder address of a user who was imported from an earlier version |

### Organization permissions

| Permission (API name) | Access | What the app uses it for |
|---|---|---|
| Members (`members`) | Read-only | Read a person's role in an organization with their user token, when a workspace connects an installation of that organization |

An App that was imported from an older installation, or made by hand without these two permissions, still
reviews pull requests, but signing in with a GitHub account and binding organization installations need them.
The Integrations page lists them, and **Check the permissions** asks GitHub which of them the App really lacks.
After you add a permission in the App's settings, every installation has to accept the changed permissions on
GitHub (GitHub asks the installing account).

## Events

Under *Subscribe to events* tick exactly **Pull request** and **Issue comment**. The other two events below have
no checkbox: GitHub sends them to every app that has a webhook.

| Event | Subscription | What the app does with it |
|---|---|---|
| `pull_request` | Tick "Pull request" | A pull request was opened, reopened, marked ready for review or got new commits: becomes a review trigger |
| `issue_comment` | Tick "Issue comment" | A comment on a pull request that starts with `/review`, `/improve`, `/describe` or `/ask` from somebody with write access becomes a command trigger |
| `installation` | Always sent, nothing to tick | The app was installed, removed, suspended or unsuspended: creates or disables the installation in the app |
| `installation_repositories` | Always sent, nothing to tick | Repositories were added to or removed from an installation: keeps the repository list current |

Every other event (for example GitHub's `ping`, or `push`) is answered with `202` and ignored. The list is the
set of events the webhook code reads (`webhook-fields.ts` next to `job-access.ts`).

## Sign in with GitHub

The App's user authorization signs people in. The login page offers **Sign in with GitHub** exactly while the
integration is configured with a client id and secret and GitHub is switched on as a way to sign in (Setup).

- The sign-up rule (Setup) is applied to the **verified primary email address** that GitHub reports. An
  account without one is refused; nothing is created for it.
- A GitHub account is matched by its numeric GitHub id. Signing in again, after a rename too, is the same user.
- A GitHub account whose verified address is the address of an existing account is linked to it only when the
  existing account's address is verified too. An address alone never joins two accounts.
- You can also link a GitHub account from the account page ("Your account") while you are signed in: GitHub asks
  you to authorize the App, which proves the account is yours.

### An App that was imported, or made without the user authorization

The Integrations page then shows **Enable sign-in with GitHub**: it names the callback address
(`https://<domain>/api/auth/callback/github`) to add under *Callback URL* in the App's settings, and takes the
client id and a client secret. The old separate GitHub OAuth app (`GITHUB_OAUTH_CLIENT_ID`,
`GITHUB_OAUTH_CLIENT_SECRET`) is **not used any more** and is never imported.

Until the user authorization is configured, "Connect GitHub" in a workspace is unavailable on a multi-tenant
instance, and the page says so.

### Linking your own GitHub account as the admin

An instance that ran before accounts existed has your operator account twice: as an imported user (your GitHub
identity, no password) and as the instance admin you created in the setup (email and password). Under
**Integrations > Your GitHub account** press **Link GitHub account** and authorize on GitHub. If that GitHub
account belongs to an imported user without any other way to sign in, the two accounts are **merged**: its
memberships and history become yours, the higher role wins where you are both members, and the imported user
is retired. That is one irreversible transaction. It is available only to the instance admin and only for
users the import marked; a GitHub account of a user with a password is refused with a message, and nothing
moves. Afterwards you can make GitHub the only way to sign in (Setup).

### Placeholder addresses

An imported user has a placeholder address (`<id>@users.noreply.github.com`). At their next sign in with GitHub
it is replaced by GitHub's verified primary address. If another account has that address already, the
placeholder stays, nothing is taken over or merged, and a hint is shown on the user's account page and to the
instance admin.

## Install the App

Anybody can install a public App, so an installation is **not** reviewed until a workspace has linked it
(`docs/decisions/0001-editions-setup-and-accounts.md`, section 2.9). An Owner or Admin of the workspace does that:

1. Open the workspace's **Connections** page and press **Connect GitHub**. GitHub shows the App's installation page.
2. Pick the account or organization, and choose **Only select repositories**. Select the repositories the team
   wants reviewed. Granting "All repositories" is possible but not recommended. Confirm the permission list GitHub
   shows and press Install.
3. GitHub brings you back to the app (the Setup URL) and asks you to authorize the App. That proves two things with
   *your own* GitHub token, which is used once and never stored: that you can use the installation, and that you
   are the owner of the personal account, or an owner of the organization. A member of an organization who is not
   an owner cannot connect its installation, and neither can somebody who only has access to a repository.
   (If you are not allowed to install the App on an organization, GitHub asks its owners instead; once they
   approved, use **Link an existing installation** on the Connections page.)
4. The repositories of the installation appear under **Projects** of that workspace, and in no other. An
   installation belongs to one workspace only.

If GitHub does not let the App read your role in the organization (the App lacks the organization permission
*Members*, see [Permissions](#permissions)), nothing is linked: the request goes to the instance admin, who sees who
asked, the account and the evidence under **Approvals** in the admin portal and approves or denies it.

A single-tenant instance whose App is **private** (it can only be installed on its own account) attaches an
installation on that account to its one workspace by itself, without this round trip. Everything else needs
Connect GitHub. An installation made by somebody else is only listed under **Approvals** as "nobody has linked it".

The `installation` delivery GitHub sends shows **202** in the App's *Recent Deliveries*; the body says
`installation_unclaimed` while nobody has linked the installation, and `installation_changed` for a linked one.

Newly synced repositories are **inactive**: a repository is reviewed only after it was activated as a project in
the application. Open the workspace's **Projects** page, press **Sync from GitHub** (Owners and Admins see the button;
it reads the workspace's own connections) if the repository is missing, and switch the repository on. The API call
`PUT /api/w/:workspace/repositories/:repositoryId/project` of a signed-in user stays available for scripts (see
`app/src/projects/README.md`).

## Check the webhook

1. Open the App's settings page > **Advanced** > *Recent Deliveries*. If there is a `ping` delivery from when the
   App was created, open it and press **Redeliver**. If there is none, the `installation` delivery of the
   installation is the first check.
2. The delivery must show a green tick and the response **202** (`event_not_used`: a signed `ping` is genuine
   but not an event the app uses).

| Answer | Meaning |
|---|---|
| 202 | Signature correct. |
| 401 | The signature does not match the webhook secret in the portal (or no GitHub App is configured). |
| 400 / 413 | The delivery is malformed or larger than 1 MB. Not seen with GitHub's own deliveries. |
| Timeout, 502, 503 | The application is not reachable: check the domain, the proxy and that the container is healthy (`/api/health`). |

## Private key and secrets

- The `.pem` file is a credential: whoever has it can act as the app on every repository it is installed on. With
  the one-click way you never see it. With the way by hand, store it in the team's **password manager** and
  **delete the downloaded file** from the laptop and the Downloads folder. It does not belong in the repository
  (`*.pem` is in `.gitignore`, and a test scans every tracked file for key blocks and token patterns), in
  Confluence, in Jira, in a chat, in an e-mail, or in a screenshot.
- The private key, the webhook secret and the client secret are stored encrypted (AES-256-GCM, a key derived from
  `APP_SECRET`) and are never shown again, never logged and never part of an answer. **Back `APP_SECRET` up apart
  from the database:** a database restored without it loses every stored credential, and the portal then asks
  you to enter them again.
- A replaced webhook secret counts from the next delivery, on every app instance: nothing is cached.
- **Rotating the private key:** on the App's settings page generate a *second* key, enter it in the portal
  (**Enter the values by hand**, the other fields stay), check that a delivery or a review works, then delete the
  old key on GitHub. Update the password manager entry.
- **Rotating the webhook secret:** change it on GitHub and in the portal. Deliveries sent in between are answered
  with 401: redeliver them under *Recent Deliveries* (a redelivery uses the same delivery id and is handled
  normally).
- **Lost key:** generate a new one as above. There is no way to download the old one again.

## Older installations

An installation that still has `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_WEBHOOK_SECRET` and
`GITHUB_APP_PRIVATE_KEY` (or `GITHUB_APP_PRIVATE_KEY_PATH`) in its environment keeps working: they are read as
long as the database holds no GitHub App, and the update to accounts imports them once. As soon as the App is
saved in the portal, the database wins and the variables are ignored. `GITHUB_OAUTH_CLIENT_ID` and
`GITHUB_OAUTH_CLIENT_SECRET` (the separate OAuth app of the earlier sign in) are not used any more.

## Checklist for whoever sets it up

- [ ] The App exists (one click, or by hand with the addresses and settings above), webhook active, SSL
      verification enabled
- [ ] Permissions: Pull requests Read and write, Issues Read and write, Contents Read-only, Metadata Read-only,
      Email addresses Read-only, Members Read-only, and nothing else
- [ ] Events: Pull request and Issue comment ticked
- [ ] The tile on Integrations shows **Configured**, and **Sign in with GitHub** is enabled
- [ ] Only for the way by hand: the `.pem` file is in the password manager and deleted from the laptop
- [ ] `ping` redelivered: 202
- [ ] Installed on the team's repositories (selected repositories), `installation` delivery shows 202
- [ ] `APP_SECRET` is backed up apart from the database

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| The tile shows **Problem** and names `github_app_private_key` or another secret | The secret was saved with another `APP_SECRET`, or the stored value was changed. Enter it again (**Enter the values by hand**). |
| "GitHub refused the key of the App" when saving | The private key does not belong to the App id you entered. |
| "GitHub knows this App under another slug" | The slug differs from the App's public link. |
| Every delivery is 401 | The webhook secret in the portal differs from the one in the App's settings (watch for a trailing space), or no App is configured. |
| Deliveries time out | The domain does not reach the application, or SSL verification fails because the certificate is not valid. |
| The `installation` delivery is 202 but no repositories show up | The installation has no repositories selected, or GitHub could not be asked: the delivery answer is 503 then, redeliver it. |
| A pull request or a command produces no review trigger | The repository is not an active project (the delivery answer says `project_not_active`), or the commenter has no write access (`ignored`). |
| `GITHUB_APP_AUTH_FAILED` in the logs | The private key does not belong to the app with that App id. |
| `GITHUB_APP_FORBIDDEN` in the logs | The installation is suspended, or a permission is missing: compare the app's permissions with the tables above and accept the new permissions on the installation page if GitHub asks. |
| "We could not read the email addresses of your GitHub account" on the login page | The App lacks the **Email addresses** permission (see **Check the permissions**), or GitHub failed. |
| "GitHub reports no verified primary email address" | The person has to verify a primary email address in their GitHub settings. |
