# fakes/github

A fake GitHub for the sign in. One HTTP server speaks the parts of GitHub that Code Reviewer uses to
log a person in; the app is pointed at it with `GITHUB_OAUTH_BASE_URL` and `GITHUB_API_BASE` (both
set to the fake's address; they default to the real GitHub). State is in memory.

| Endpoint                                                         | Behavior                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /login/oauth/authorize`                                     | An HTML page with one "Authorize `<login>`" button per account and a "Cancel" button. Needs the registered `client_id` and a `redirect_uri`.                                                                                                  |
| `POST /login/oauth/authorize/confirm`                            | What the buttons post. Redirects to `redirect_uri` with `code` and `state`, or with `error=access_denied` after "Cancel".                                                                                                                     |
| `POST /login/oauth/access_token`                                 | Exchanges the code (single use, bound to `redirect_uri` and to the PKCE challenge) for an access token. Like GitHub, a refused code is answered with status 200 and an `error` field; answers JSON when asked for it, form encoded otherwise. |
| `GET /user`                                                      | The profile for a bearer token: `id`, `login`, `name`, `email` (may be `null`), `avatar_url`. 401 `Bad credentials` for an unknown token.                                                                                                     |
| `GET /user/emails`                                               | The email list; needs the `user:email` scope, else 404 as on GitHub.                                                                                                                                                                          |
| `GET /__fake/health`, `POST /__fake/users`, `POST /__fake/reset` | Control endpoints for tests that run the fake as its own process (Playwright). `POST /__fake/users` takes a JSON `FakeGithubUser`.                                                                                                            |

## In a Vitest test (same process)

```ts
const github = await startGithubFake({
  clientId: "id",
  clientSecret: "secret",
});
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
await github.close();
```

`app/src/test-support/auth-harness.ts` wraps this together with a real database and the app's real
Better Auth instance.

## As its own process (Playwright, later the Docker test stack)

```sh
GITHUB_FAKE_CLIENT_ID=id GITHUB_FAKE_CLIENT_SECRET=secret GITHUB_FAKE_PORT=4010 node fakes/github/main.ts
```

`app/playwright.config.ts` starts it next to the app with fixed dummy credentials. Each journey adds
the accounts it needs (`app/e2e/helpers/github-fake.ts`) and never resets the fake, because other
spec files run at the same time.

## Not covered yet

The REST API for pull requests, installation tokens (GitHub App) and signed webhook deliveries
belong to the tickets that need them and will be added here.
