# GitHub integration

The one GitHub App of the instance, for sign in and for reviews (`docs/decisions/0001-editions-setup-and-accounts.md`,
sections 2.4, 2.7 and 2.10), configured in the admin portal and read from the database. How an operator uses it:
[`docs/github-app.md`](../../../docs/github-app.md).

| File                   | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.ts`          | The non-secret settings (`instance_settings` key `github_app`: app id, slug, client id, the "private app" flag, where it came from) and the rules for what the admin may enter: `parseManualInput`, `parseUserAuthorizationInput`, one stable code per field                                                                                                                                                                                          |
| `credentials.ts`       | `createGithubCredentialStore`: the one loader. `load()` reads the database (the settings, the private key and the webhook secret and client secret from the secret store) and nothing else: the `GITHUB_APP_*` variables are not read (the import of an existing installation, `src/legacy-import/`, moved them into the store once); `persistApp`, `persistUserAuthorization`, `setPrivateApp` write the settings and the secrets in one transaction |
| `service.ts`           | `createGithubConfigService`: `view` (what the portal shows), `saveApp` (the manual form), `saveUserAuthorization` and `setPrivateApp` (the prompt of an imported App), `startManifest` and `completeManifest` (the manifest flow), `checkPermissions`                                                                                                                                                                                                 |
| `http.ts`, `errors.ts` | The handlers of the data routes below `/api/admin/github` and their stable error codes                                                                                                                                                                                                                                                                                                                                                                |
| `facts.ts`             | What the portal and the account page read about GitHub identities: the linked account of a user, and the users whose placeholder address could not be replaced                                                                                                                                                                                                                                                                                        |
| `shared.ts`            | The wiring of the running server (`getGithubCredentialStore`, `getGithubConfigService`, `isGithubSignInConfigured`, `getIntegrationsPageData`)                                                                                                                                                                                                                                                                                                        |
| `ui/`                  | The Integrations page: the status, the one-click form, the manual form, the prompts of an imported App, the permission check, the admin's own GitHub account. Pages: `src/app/(app)/instance-portal/integrations`                                                                                                                                                                                                                                     |

The GitHub specific parts (the manifest, the conversion of the one-time code, the check of the App's key and of
the client credentials) are in `src/integrations/providers/github-app/` (`manifest.ts`, `app-requests.ts`) and
reached through the registry.

## The credentials

- **The database is the only source.** `load()` reads the stored App, or says `source: "none"`. The `GITHUB_APP_*`
  variables are not read, on a new instance or an updated one: the update to accounts imports them into the database
  once (`src/legacy-import/`, `origin: "import"`) and a start after that ignores them. `GITHUB_OAUTH_*` are never
  read. The `env` the store is given holds the test-only address overrides (`GITHUB_API_BASE_URL`,
  `ALLOW_TEST_GITHUB_ENDPOINTS`) and nothing else.
- **Nothing is remembered.** There is no in-process cache (the 30 second `SETUP_CACHE_MS` is gone): the provider
  asks `load()` on every call (`createDefaultIntegrationRegistry` in `src/integrations/registry.ts`), so a replaced
  webhook secret or key counts from the next request on every app instance. The GitHub client is kept only while the
  key, the app id and the address are the ones it was made for.
- **Write-only secrets.** The private key, the webhook secret and the client secret are in the encrypted secret
  store (`github_app_private_key`, `github_app_webhook_secret`, `github_app_client_secret`). The view says
  `none`, `configured` or `unreadable` and nothing else; no answer, page or log line holds a value, and a test
  searches the answers and the logs for the values.
- **Keeping a secret is tied to the App.** An empty field keeps the stored private key and webhook secret only while
  the App id is unchanged, and the client secret only while the App id and the client id are unchanged (otherwise
  `private_key_required`, `webhook_secret_required`, `client_secret_required`): pointing the form at another App
  never carries the saved secrets to it.
- **Problems are names.** A saved App that cannot be used is a `problem` that names secrets or fields
  (`github_app_private_key`), never a value; an undecryptable secret (another `APP_SECRET`, a changed row) is
  `unreadable` and the portal asks for it again.

## The manifest flow

1. `POST /api/admin/github/manifest` (`startManifest`): the manifest is made from the configured public URL
   (`BETTER_AUTH_URL`), never from a header; the answer is the manifest and GitHub's creation page with a **signed,
   single-use, 10 minute state bound to the admin and to the session** in its address (`src/signed-state/`). What the
   manifest asked for (public or private) is stored with the state. An App that is configured is replaced only when the
   request says `replace`. Limited to 10 starts per admin in 10 minutes.
2. The browser posts the manifest to GitHub (the page does it with a hidden form); the admin confirms there.
3. `GET /api/admin/github/manifest/callback` (`completeManifest`): GitHub sends the browser back with the one-time
   `code` and the `state`. The **state is checked and used up first**: the signature, the purpose, the expiry, the admin
   and the session must match and the single-use row must still be unused, otherwise `state_invalid` and nothing is
   exchanged or stored. Then `POST /app-manifests/{code}/conversions` (once; `manifest_code_invalid` for a code GitHub
   refuses, `github_unreachable` for a timeout or a 5xx, `conversion_response_invalid` for an answer that is not an App's
   credentials) and one transaction stores the six values. The browser is sent on to the Integrations page (a fixed path)
   with the outcome as a code from a closed list in the query.
4. The manifest asks for the repository permissions of `docs/github-app.md`, the account permission **Email addresses:
   read-only** and the organization permission **Members: read-only**; `setup-doc.test.ts` keeps the manifest and the
   guide together.

## The manual form

Validated before anything is saved: the key must be an RSA private key (`normalizePemKey` accepts the escaped `\n` and
single line forms), a call with the App JWT (`GET /app`) must succeed and return the entered id and slug
(`private_key_invalid`, `app_auth_failed` at the key, `slug_mismatch` at the slug, `github_unreachable` when GitHub cannot be
asked), and a client id and a new client secret must be accepted by GitHub as a pair (the client credentials' "check a token"
call; GitHub answers a client id it does not know like a right one, so a wrong id shows at the first sign in). The checks that
call GitHub are limited per admin and for the instance (20 per 10 minutes and 60 for the instance, in `rate_limits`).

## An App that was imported or made by hand

The portal shows **Enable sign-in with GitHub** (the callback address to register, the client id and secret, checked and
stored encrypted), asks whether the App can only be installed on its own account (the flag GitHub's API does not report),
and lists the permissions such an App may lack, with a button that asks GitHub which of them it really lacks. Until the
user authorization is configured the portal says that "Connect GitHub" is unavailable on a multi-tenant instance. An App
that is not in the database cannot take a client id and secret (`app_not_in_database`): it is entered in the form
first, which moves it into the database.

## Tests

`service.integration.test.ts` (the manifest flow, the manual form, the prompts, the credentials as two instances read
them) and `http.integration.test.ts` (who may call the routes, what a request must look like, forged `Host` headers, the
flow through the real proxy) run against the fake GitHub (`fakes/github`, manifest flow switched on). Journey:
`e2e/admin/github-integration.e2e.ts`.
