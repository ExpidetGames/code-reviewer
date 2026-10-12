# Setting up the team's GitHub App

Code Reviewer talks to GitHub as a **GitHub App** of its own: GitHub sends it webhooks (a pull request
was opened, somebody commented `/review`), and it uses short-lived tokens of that app to read pull
requests and to post the reviews. This guide creates that app once, hands its credentials to the
deployment and installs it on the team's repositories. Plan for about 30 minutes. Nothing here needs
code changes.

This is **not** the login of the web UI. People sign in with a separate GitHub *OAuth* app (see
"Sign in" in the [README](../README.md)); do not mix the two, and do not enable user authorization on
this app. Both apps live under the same `<domain>` and are usually created together, so keep this
in mind for the OAuth app: its *Authorization callback URL* is
`https://<domain>/api/auth/callback/github`, and the deployment gets `BETTER_AUTH_URL=https://<domain>`
(the same address, without a path).

What you need before you start:

- An owner (or app manager) role on the GitHub account or organization that will own the app.
- The public https address the deployment will have, for example `https://reviews.example.com`
  (called `<domain>` below). It must be reachable from the internet, because GitHub delivers webhooks
  to it. Assign the domain to the application in Coolify first; the app does not have to be running
  yet.
- A password manager the team shares (the private key goes there, see
  [Private key and secrets](#private-key-and-secrets)).

## 1. Create the app

Open the form: for a personal account `https://github.com/settings/apps/new`, for an organization
`https://github.com/organizations/<org>/settings/apps/new` (Settings > Developer settings > GitHub
Apps > New GitHub App). Fill in exactly this and leave every other field at its default:

| Field | Value |
|---|---|
| GitHub App name | A name that is unique on GitHub, for example `Code Reviewer <Team>`. The app's *slug* is derived from it (lower case, dashes), and the bot shows up in pull requests as `<slug>[bot]`. |
| Description | Optional, for example "Automatic pull request reviews". |
| Homepage URL | `https://<domain>` |
| Callback URL | Leave empty. |
| Expire user authorization tokens | Leave as is (not used). |
| Request user authorization (OAuth) during installation | **Unchecked.** |
| Enable Device Flow | **Unchecked.** |
| Setup URL | Leave empty. |
| Redirect on update | Unchecked. |
| Webhook > Active | **Checked.** |
| Webhook URL | `https://<domain>/api/webhooks/github-app` (one URL for every installation and every event) |
| Webhook secret | A long random string, see [Private key and secrets](#private-key-and-secrets). Keep it at hand: it goes into the deployment as `GITHUB_APP_WEBHOOK_SECRET`. |
| SSL verification | **Enable SSL verification.** |
| Permissions | As in [Permissions](#permissions). |
| Subscribe to events | As in [Events](#events). |
| Where can this GitHub App be installed? | **Only on this account.** Nobody outside the team can install the app. |

Then press **Create GitHub App**.

## Permissions

Under *Permissions > Repository permissions* set these four and nothing else. Everything is
repository-level; **Account** and **Organization** permissions stay at "No access", and there is **no
Checks permission** in the MVP.

| Permission (API name) | Access | What the app uses it for |
|---|---|---|
| Pull requests (`pull_requests`) | Read and write | Read the pull request (head commit, state, draft); post the review, inline comments and suggestions; edit the description (`/describe`) |
| Issues (`issues`) | Read and write | Pull request conversation comments are issue comments: the persistent review comment and the replies to `/ask`; labels and reactions on comments |
| Contents (`contents`) | Read-only | Read the changed files and the other repository files a review needs, such as `AGENTS.md` (the app never pushes) |
| Metadata (`metadata`) | Read-only | Mandatory for every app: list the installation's repositories and ask whether a commenter has write access |

The code asks for the same four permissions when it creates the token of a review job, scoped to the
single repository of that job (`JOB_TOKEN_PERMISSIONS` in
`app/src/integrations/providers/github-app/job-access.ts`). A test (`setup-doc.test.ts` next to it)
fails when this table and the code disagree, so change both together.

## Events

Under *Subscribe to events* tick exactly **Pull request** and **Issue comment**. The other two events
below have no checkbox: GitHub sends them to every app that has a webhook.

| Event | Subscription | What the app does with it |
|---|---|---|
| `pull_request` | Tick "Pull request" | A pull request was opened, reopened, marked ready for review or got new commits: becomes a review trigger |
| `issue_comment` | Tick "Issue comment" | A comment on a pull request that starts with `/review`, `/improve`, `/describe` or `/ask` from somebody with write access becomes a command trigger |
| `installation` | Always sent, nothing to tick | The app was installed, removed, suspended or unsuspended: creates or disables the installation in the app |
| `installation_repositories` | Always sent, nothing to tick | Repositories were added to or removed from an installation: keeps the repository list current |

Every other event (for example GitHub's `ping`, or `push`) is answered with `202` and ignored. The
list is the set of events the webhook code reads (`webhook-fields.ts` next to `job-access.ts`).

## 2. Collect the credentials

After the app is created you land on its settings page (`https://github.com/settings/apps/<slug>`, or
the organization equivalent).

1. **App ID**: the number at the top of the page (*About*). It is `GITHUB_APP_ID`.
2. **Slug**: the last part of the app's public link `https://github.com/apps/<slug>`. It is
   `GITHUB_APP_SLUG`.
3. **Private key**: scroll to *Private keys* and press **Generate a private key**. Your browser
   downloads a `.pem` file, and GitHub does not keep a copy. Handle it as described in
   [Private key and secrets](#private-key-and-secrets).
4. **Webhook secret**: the string you entered in the form. It is `GITHUB_APP_WEBHOOK_SECRET`.

The *Client ID* and *client secrets* on that page are not used.

## 3. Hand the credentials to the deployment

The application reads these settings (four values; the private key is given inline or as a file). They are optional for starting the instance: without them GitHub is "not configured" and no review can run, and a set that is incomplete or unusable is reported in the log at start (one `GITHUB_APP_CONFIG_INVALID` line naming the variables, never their values) while the instance still starts.

| Variable | Value | Notes |
|---|---|---|
| `GITHUB_APP_ID` | The App ID (digits) | |
| `GITHUB_APP_SLUG` | The slug | Letters, digits and dashes |
| `GITHUB_APP_WEBHOOK_SECRET` | The webhook secret | Used byte for byte: no trailing space or line break |
| `GITHUB_APP_PRIVATE_KEY` | The content of the `.pem` file | Either with real line breaks, or on one line with the breaks written as `\n`. It must be a parseable RSA key, otherwise the start is refused and the log names the variable. |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Path of the `.pem` file | Alternative to `GITHUB_APP_PRIVATE_KEY` for a setup without Docker Compose. Set one of the two; if both are set, the inline key wins and the path is ignored. |

How the values reach the process depends on how it runs:

- **Coolify (and Docker Compose):** open the application's *Environment Variables* and add the four
  variables (`GITHUB_APP_PRIVATE_KEY`, not the path variant: the compose file does not mount a key
  file). Make them runtime variables only, not build-time variables, so they never end up in an
  image. Paste the private key either with its real line breaks or as one line with `\n` instead of the
  line breaks; both give the same key. Then deploy again.
  `compose.yml` stops before creating any container when one of them is empty, and
  [`.env.example`](../.env.example) lists them next to the other settings.
- **Local development:** `app/.env.local` (see [`app/.env.example`](../app/.env.example)). Without
  the four settings `pnpm dev` still starts, but nothing can be read from GitHub.

How the deployment itself is set up (the Coolify application, domain, volumes, the other variables) is
described in [`deployment-coolify.md`](deployment-coolify.md); this guide only needs the public address and
the variables.

## 4. Check the webhook

Once the application runs on `<domain>`:

1. Open the app's settings page > **Advanced** > *Recent Deliveries*. If there is a `ping` delivery
   from when the app was created, open it and press **Redeliver**. If there is none, the
   `installation` delivery of step 5 is the first check.
2. The delivery must show a green tick and the response **202** (`event_not_used`: a signed `ping` is
   genuine but not an event the app uses).
3. Optional, **only now, before the app is installed anywhere, and never on a running instance**: to
   see what a wrong secret looks like, change `GITHUB_APP_WEBHOOK_SECRET` in the deployment on
   purpose, redeploy and redeliver: the answer is **401**. Put the right secret back afterwards and
   redeploy. While the secret is wrong, every real delivery is refused with 401.

| Answer | Meaning |
|---|---|
| 202 | Signature correct. |
| 401 | The signature does not match the secret in the deployment (or the deployment has no secret). |
| 400 / 413 | The delivery is malformed or larger than 1 MB. Not seen with GitHub's own deliveries. |
| Timeout, 502, 503 | The application is not reachable: check the domain, the proxy and that the container is healthy (`/api/health`). |

## 5. Install the app on the team's repositories

1. Open `https://github.com/apps/<slug>/installations/new` (the **Install** button of the app's public
   page), pick the account or organization, and choose **Only select repositories**. Select the
   repositories the team wants reviewed. Granting "All repositories" is possible but not recommended.
2. Confirm the permission list GitHub shows. It must be exactly the four permissions above.
3. GitHub sends an `installation` delivery. In *Recent Deliveries* it shows **202**; the response
   body says `installation_changed`. The application now knows the installation and its repositories
   (it also reads every installation of the app each time it starts).
4. Repositories can be added or removed later under the installation's settings
   (Settings > Applications > Installed GitHub Apps > *app* > Configure, or the organization
   equivalent). The `installation_repositories` delivery keeps the application current.

Newly synced repositories are **inactive**: a repository is reviewed only after it was activated as a
project in the application. Open the app's **Projects** page, press **Sync from GitHub** (only the instance admin sees the button) if the
repository is missing, and switch the repository on. The API call
`PUT /api/w/:workspace/repositories/:repositoryId/project` of a signed-in user stays available for scripts (see
`app/src/projects/README.md`).

## Private key and secrets

- The `.pem` file is a credential: whoever has it can act as the app on every repository it is
  installed on. Store it in the team's **password manager** (one entry, the file or its text), put it
  into the deployment's secret variables (`GITHUB_APP_PRIVATE_KEY`) and then **delete the downloaded
  file** from the laptop and the Downloads folder. It does not belong in the repository (`*.pem` is in
  `.gitignore`, and a test scans every tracked file for key blocks and token patterns), in Confluence,
  in Jira, in a chat, in an e-mail, or in a screenshot.
- The webhook secret is a credential too. Create it with `openssl rand -hex 32` and store it in the
  same password manager entry as the key.
- Neither the key, the webhook secret, nor a token derived from them is written to a log or an error
  response. If you ever see one in a log, treat it as leaked and rotate it.
- **Rotating the private key:** on the app's settings page generate a *second* key, put it into the
  deployment, redeploy, check a delivery or a review works, then delete the old key on the settings
  page. Update the password manager entry.
- **Rotating the webhook secret:** change it in the app's settings page and in the deployment, and
  redeploy. Deliveries sent in between are answered with 401: redeliver them under *Recent
  Deliveries* (a redelivery uses the same delivery id and is handled normally).
- **Lost key:** generate a new one as above. There is no way to download the old one again.

## Checklist for whoever sets it up

- [ ] Name, homepage URL and webhook URL (`https://<domain>/api/webhooks/github-app`) as above, SSL
      verification enabled, webhook active
- [ ] Permissions: Pull requests Read and write, Issues Read and write, Contents Read-only,
      Metadata Read-only, and nothing else
- [ ] Events: Pull request and Issue comment ticked
- [ ] "Only on this account" selected, user authorization (OAuth) off
- [ ] App ID, slug, webhook secret and private key in the deployment as runtime variables
- [ ] The `.pem` file is in the password manager and deleted from the laptop
- [ ] `ping` redelivered: 202 (before installing, optionally also a wrong secret gives 401; never test that on a running instance)
- [ ] Installed on the team's repositories (selected repositories), `installation` delivery shows 202

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| The container restarts in a loop with `DEPLOY_CONFIG_INVALID` | One of the four variables is missing or the key is not a parseable RSA key. The log line names the variable. |
| Every delivery is 401 | `GITHUB_APP_WEBHOOK_SECRET` differs from the secret in the app's settings (watch for a trailing space or line break). |
| Deliveries time out | The domain does not reach the application, or SSL verification fails because the certificate is not valid. |
| The `installation` delivery is 202 but no repositories show up | The installation has no repositories selected, or GitHub could not be asked: the delivery answer is 503 then, redeliver it. |
| A pull request or a command produces no review trigger | The repository is not an active project (the delivery answer says `project_not_active`), or the commenter has no write access (`ignored`). |
| `GITHUB_APP_AUTH_FAILED` in the logs | The private key does not belong to the app with that `GITHUB_APP_ID`. |
| `GITHUB_APP_FORBIDDEN` in the logs | The installation is suspended, or a permission is missing: compare the app's permissions with the table above and accept the new permissions on the installation page if GitHub asks. |
