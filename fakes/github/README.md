# fakes/github

The fake GitHub: one HTTP server that speaks every part of GitHub that Code Reviewer talks to, so the
sign in tests and the GitHub integration tests share one fake and one address. The app is pointed at
it with `GITHUB_OAUTH_BASE_URL` and `GITHUB_API_BASE_URL` (both set to the fake's address; they
default to the real GitHub). The app refuses both unless `ALLOW_TEST_GITHUB_ENDPOINTS=true` is set as
well, because the client secret, the App JWT and the tokens are sent to that address. State is in
memory. Dummy values only.

| File            | Part                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `server.ts`     | The server (`startGithubFake`), the request log, failure injection, the control endpoints.     |
| `oauth.ts`      | Sign in: OAuth authorize and token endpoints, the user, e-mail and organization membership.    |
| `app-api.ts`    | The REST API as the GitHub App uses it: installations, tokens, repositories, pull requests.    |
| `review-api.ts` | What a reviewer reads and writes: diff, commits, file contents and comments of a pull request. |
| `webhooks.ts`   | Signed webhook deliveries, `webhookFixture(name)` loads a payload from `../fixtures`.          |
| `http.ts`       | Small helpers for answering and reading HTTP messages.                                         |
| `main.ts`       | Starts the sign in part as its own process (Playwright).                                       |

A part is switched on by its options. `clientId` and `clientSecret` give the sign in; `appId` and
`publicKeyPem` give the GitHub App API (give both options of a part or neither). A part that is not
switched on answers 404, and its controls (`addUser`, `addInstallation`, ...) are not there. In the
app's tests `startTestGithub()` (`app/src/test-support/github-fake.ts`) starts it with both parts.

## Sign in

| Endpoint                                                                                     | Behavior                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /login/oauth/authorize`                                                                 | An HTML page with one "Authorize `<login>`" button per account and a "Cancel" button. Needs the registered `client_id` and a `redirect_uri`.                                                                                                                    |
| `POST /login/oauth/authorize/confirm`                                                        | What the buttons post. Redirects to `redirect_uri` with `code` and `state`, or with `error=access_denied` after "Cancel".                                                                                                                                       |
| `POST /login/oauth/access_token`                                                             | Exchanges the code (single use, bound to `redirect_uri` and to the PKCE challenge) for an access token. Like GitHub, a refused code is answered with status 200 and an `error` field; answers JSON when asked for it, form encoded otherwise.                   |
| `GET /user`                                                                                  | The profile for a bearer token: `id`, `login`, `name`, `email` (may be `null`), `avatar_url`. 401 `Bad credentials` for an unknown token.                                                                                                                       |
| `GET /user/emails`                                                                           | The email list; needs the `user:email` scope, else 404 as on GitHub.                                                                                                                                                                                            |
| `GET /user/memberships/orgs/:org`                                                            | The signed in account's own membership in an organization, like GitHub: needs the `read:org` scope (else 403), 401 for an unknown or revoked token, 404 when not a member, otherwise 200 with `state` (`active` or `pending`), `role` and `organization.login`. |
| `GET /__fake/health`, `POST /__fake/users`, `POST /__fake/org-members`, `POST /__fake/reset` | Control endpoints for tests that run the fake as its own process (Playwright). `POST /__fake/users` takes a JSON `FakeGithubUser`; `POST /__fake/org-members` takes `{ org, login, state? }`.                                                                   |

The app does not call `/user/emails` (it stores a noreply address); the endpoint is there for tickets
that may need it.

## The GitHub App API

| Endpoint                                                  | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /app/installations`, `GET /app/installations/:id`    | Needs an App JWT: RS256 signature checked against the configured public key, `iss` is the app id, not expired. Paged (`per_page`, `page`).                                                                                                                                                                                                                                                                                       |
| `POST /app/installations/:id/access_tokens`               | App JWT. Issues a random installation token (valid one hour of the fake's clock), optionally narrowed by `repository_ids` or `repositories` (names) and by `permissions`. 422 for a repository the installation does not have and for a permission above what the app holds (`setAppPermissions`, default: pull requests and issues write, contents and metadata read), 403 for a suspended installation, 404 for a removed one. |
| `DELETE /installation/token`                              | Installation token. Switches that token off (204); later use of it gets 401. `revokedInstallationTokens()` lists them.                                                                                                                                                                                                                                                                                                           |
| `GET /installation/repositories`                          | Installation token. `{ total_count, repositories }`, paged; only the repositories the token is narrowed to.                                                                                                                                                                                                                                                                                                                      |
| `GET /repos/:owner/:repo/pulls`, `.../pulls/:n`           | Installation token with pull requests read. Open pull requests (`state` supported), one pull request or 404 (also for a repository the token is not narrowed to); 403 without the permission.                                                                                                                                                                                                                                    |
| `GET /repos/:owner/:repo/collaborators/:login/permission` | Installation token with metadata read. `{ permission }`, `none` for a user without an entry.                                                                                                                                                                                                                                                                                                                                     |
| `POST /__fake/pull-requests`                              | Control endpoint for the fake as its own process: body `{ repository: "owner/name", pullRequest }` (a `FakePullRequest`: `number`, `title`, `state`, `headSha`, `headRef`, `baseRef`, `author`) adds the pull request, replacing one with the same number. 400 for a body that is not one.                                                                                                                                       |
| `POST /__fake/installations`                              | Control endpoint for the fake as its own process: body `{ installation, repositories }` installs the app for the account (or replaces the repositories of an installation that exists). Needs the GitHub App part (`GITHUB_FAKE_APP_ID`, `GITHUB_FAKE_APP_PUBLIC_KEY`).                                                                                                                                                          |

## What a reviewer reads and writes

The calls the GitHub provider of PR-Agent makes (through PyGithub, with the `token` scheme of the
`Authorization` header), so the runner's real PR-Agent can review a pull request here. They need an
installation token with the permission GitHub asks for (`pull_requests`, `issues`, `contents`,
`metadata`) and a repository the token reaches.

| Endpoint                                                                                  | Behavior                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /repos/:o/:r`, `.../languages`, `.../branches/:b`                                    | The repository, a language list, a branch.                                                                                                                                                                    |
| `GET/PATCH /repos/:o/:r/pulls/:n`                                                         | The pull request (head, base, changed files); `PATCH` changes title and body.                                                                                                                                 |
| `GET .../pulls/:n/files`, `.../pulls/:n/commits`, `.../commits/:sha`, `.../compare/:spec` | The diff (`patch`, `additions`, `deletions`) and the commit of the pull request. A `FakePullRequest` carries `files` (`filename`, `baseContent`, `headContent`, `patch`); a small Python change when omitted. |
| `GET .../contents/:path?ref=`                                                             | The file at the head of the pull request (by sha or branch) or at the base (default branch); 404 for anything else, like `AGENTS.md`.                                                                         |
| `GET/POST .../issues/:n/comments`, `PATCH/DELETE .../issues/comments/:id`                 | Comments below a pull request, written as `<slug>[bot]` (`appSlug`, default `fake-app`), refused above 65,536 characters with a 422. `revision` counts the writes of a comment, so an edit in place shows.    |
| `GET /rate_limit`, `POST /graphql`                                                        | An answer that lets PR-Agent go on (no review threads).                                                                                                                                                       |
| `GET /__fake/comments?repository=owner/name&number=7`                                     | Control endpoint: the comments below a pull request (`id`, `body`, `login`, `htmlUrl`, `revision`).                                                                                                           |
| `GET /__fake/installation-tokens`                                                         | Control endpoint: every installation token issued so far, to search outputs for them.                                                                                                                         |

Links (`html_url`) point to `https://github.test` unless the fake is started with `selfLinks`
(`GITHUB_FAKE_SELF_LINKS=true` as its own process): then they point to the fake itself, which is what
the runner needs, because it demands that the pull request and the API address of a job are on one
host. Routes that name a commit or a ref (`commits`, `compare`, `contents`) serve the pull request
with that head and otherwise the newest one. Not modelled: inline review comments, reviews, labels,
check runs and paging (the engine suite's own fake, `runner/tests/engine/fake_github.py`, has the same
limits and stays: it serves the job entry point on its own, with `/api/v3` in its address).

## In a Vitest test (same process)

```ts
const github = await startGithubFake({
  clientId: "id",
  clientSecret: "secret",
  appId: "424242",
  publicKeyPem, // SPKI PEM; App JWTs are checked against it
  now: clock.now, // optional: the fake's clock for tokens and JWTs
});

// sign in
github.addUser({
  id: 1,
  login: "octocat",
  name: "The Octocat",
  email: null,
  emails: [],
});
// ... point the app at github.baseUrl ...
const callback = await github.authorize(authorizeUrl, "octocat"); // what the "Authorize" button does
github.failTokenEndpoint({ kind: "status", status: 500 }); // or { kind: "delay", delayMs: 5000 }
github.addOrgMember("my-org", "octocat"); // or (…, "pending"); removeOrgMember undoes it
github.failMembershipEndpoint({ kind: "status", status: 503 }); // or a delay; null is normal again
github.revokeToken(github.issuedAccessTokens()[0]); // the token stops working (401)
github.authorize(authorizeUrl, 2002); // a number is the account id: two accounts can share a login
github.holdTokenRequests(2); // the next two token exchanges are answered together (concurrent sign ins)

// GitHub App API
github.addInstallation({
  id: 4242,
  account: { login: "acme", id: 5001, type: "Organization" },
});
github.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
github.omitFromListings(4242, [7002]); // a page boundary that skipped a repository (total_count still counts it)
github.rejectAppJwts(true); // every JWT answered with 401
github.setAppPermissions({ metadata: "read", pull_requests: "read" }); // token requests above this get 422
github.answerTokensWith({ repository_selection: "all" }); // a token answer that claims to be broader than asked
github.pullRequestComments("acme/widgets", 7); // the comments below a pull request: id, body, login, htmlUrl, revision
github.addPullRequestComment("acme/widgets", 7, "text"); // written as <slug>[bot] unless a login is given
github.tokenRequests(); // per access token request: repositories, repositoryIds, permissions (null when not sent)
github.revokedInstallationTokens(); // tokens switched off with DELETE /installation/token

// both parts
github.fail({
  pathIncludes: "/installation/repositories",
  status: 503,
  times: 1,
}); // or delayMs, headers; any path except the /__fake/* control endpoints
github.fail({
  pathIncludes: "/app/installations",
  responseDelayMs: 300,
  times: 1,
}); // a slow answer that reflects the state when the request arrived (GitHub App API answers)
github.requests(); // method and path of every request, no credentials
github.seenCredentials(); // every JWT or token received, to search outputs for leaks
github.reset(); // all state, the request log and the injected failures (not failTokenEndpoint / failMembershipEndpoint)
await github.close();
```

`app/src/test-support/auth-harness.ts` wraps the sign in side together with a real database and the
app's real Better Auth instance. `app/src/test-support/github-app-harness.ts` builds the environment
that points the app's GitHub App settings at the fake. Both start the fake with
`startTestGithub()` unless a test hands them an instance, so a test can use one fake for both.

## Webhooks

`webhooks.ts` signs and builds deliveries like GitHub (`X-Hub-Signature-256`, `X-GitHub-Event`,
`X-GitHub-Delivery`): `webhookDelivery({ event, payload, secret })`. `webhookFixture(name)` loads a
payload from `fakes/fixtures/github-webhooks/<name>.json`: payloads reduced to the fields Code Reviewer
reads, with dummy data, named `<event>.<action>[.<variant>].json`.

## As its own process (Playwright, later the Docker test stack)

```sh
GITHUB_FAKE_CLIENT_ID=id GITHUB_FAKE_CLIENT_SECRET=secret GITHUB_FAKE_PORT=4010 node fakes/github/main.ts
```

`app/playwright.config.ts` starts it next to the app with fixed dummy credentials, including the
public half of the throwaway GitHub App key it gives the app (`GITHUB_FAKE_APP_ID`,
`GITHUB_FAKE_APP_PUBLIC_KEY`), so the process serves the sign in and the GitHub App API. Each journey
adds the accounts and installations it needs (`app/e2e/helpers/github-fake.ts`: `POST /__fake/users`,
`POST /__fake/installations` with `{ installation, repositories }`) and never resets the fake, because
other spec files run at the same time.

## Not covered yet

Inline review comments and reviews, and delivering webhooks over HTTP to a running app (the
journeys sign and send them themselves, `app/e2e/helpers/webhooks.ts`).
