# fakes/github: the GitHub App API

`app-api.ts` is a fake of the GitHub REST API as the GitHub App provider uses it. It is a real HTTP
server speaking GitHub's protocol, so the production client runs unchanged against it; the app is
pointed at it with `GITHUB_API_BASE_URL`. State is in memory. Dummy values only.

| Endpoint                                                  | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /app/installations`, `GET /app/installations/:id`    | Needs an App JWT: RS256 signature checked against the configured public key, `iss` is the app id, not expired. Paged (`per_page`, `page`).                                                                                                                                                                                                                                                                                       |
| `POST /app/installations/:id/access_tokens`               | App JWT. Issues a random installation token (valid one hour of the fake's clock), optionally narrowed by `repository_ids` or `repositories` (names) and by `permissions`. 422 for a repository the installation does not have and for a permission above what the app holds (`setAppPermissions`, default: pull requests and issues write, contents and metadata read), 403 for a suspended installation, 404 for a removed one. |
| `DELETE /installation/token`                              | Installation token. Switches that token off (204); later use of it gets 401. `revokedInstallationTokens()` lists them.                                                                                                                                                                                                                                                                                                           |
| `GET /installation/repositories`                          | Installation token. `{ total_count, repositories }`, paged; only the repositories the token is narrowed to.                                                                                                                                                                                                                                                                                                                      |
| `GET /repos/:owner/:repo/pulls`, `.../pulls/:n`           | Installation token with pull requests read. Open pull requests (`state` supported), one pull request or 404 (also for a repository the token is not narrowed to); 403 without the permission.                                                                                                                                                                                                                                    |
| `GET /repos/:owner/:repo/collaborators/:login/permission` | Installation token with metadata read. `{ permission }`, `none` for a user without an entry.                                                                                                                                                                                                                                                                                                                                     |

## In a Vitest test

```ts
const fake = await startGithubAppFake({ appId, publicKeyPem, now: clock.now });
fake.addInstallation({
  id: 4242,
  account: { login: "acme", id: 5001, type: "Organization" },
});
fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
fake.fail({
  pathIncludes: "/installation/repositories",
  status: 503,
  times: 1,
}); // or delayMs, headers
fake.fail({
  pathIncludes: "/app/installations",
  responseDelayMs: 300,
  times: 1,
}); // a slow answer that reflects the state when the request arrived
fake.omitFromListings(4242, [7002]); // a page boundary that skipped a repository (total_count still counts it)
fake.rejectAppJwts(true); // every JWT answered with 401
fake.setAppPermissions({ metadata: "read", pull_requests: "read" }); // token requests above this get 422
fake.answerTokensWith({ repository_selection: "all" }); // a token answer that claims to be broader than asked
fake.requests(); // method and path of every request, no credentials
fake.revokedInstallationTokens(); // tokens switched off with DELETE /installation/token
fake.tokenRequests(); // per access token request: repositories, repositoryIds, permissions (null when not sent)
fake.seenCredentials(); // every JWT or token received, to search outputs for leaks
await fake.close();
```

`app/src/test-support/github-app-harness.ts` starts the fake with a throwaway RSA key pair and builds the
environment that points the app at it.

## Webhooks

`webhooks.ts` signs and builds deliveries like GitHub (`X-Hub-Signature-256`, `X-GitHub-Event`,
`X-GitHub-Delivery`): `webhookDelivery({ event, payload, secret })`. `webhookFixture(name)` loads a
payload from `fakes/fixtures/github-webhooks/<name>.json`: payloads reduced to the fields Code Reviewer
reads, with dummy data, named `<event>.<action>[.<variant>].json`.

## Not covered yet

Posting comments and reviews, diffs and file contents (for the runner and the engine tests), and
delivering webhooks over HTTP to a running app.
