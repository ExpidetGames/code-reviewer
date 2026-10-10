// A complete sign in setup for integration tests: a real SQLite file, the real Better Auth
// instance of the app, and the fake GitHub on a loopback port. The tests call `auth.handler`
// with real `Request` objects, the same entry point the route handler uses, and walk the OAuth
// flow the way a browser does (sign in request, authorize at the fake, callback), keeping cookies.
import {
  startGithubFake,
  type FakeGithub,
  type FakeGithubUser,
} from "../../../fakes/github/server.ts";
import { createAuth } from "../auth/auth.ts";
import { loadAuthConfig } from "../auth/config.ts";
import { cleanUpAfterTest, createTestDatabase } from "./test-database.ts";

export const TEST_BASE_URL = "http://localhost:3000";
export const TEST_CLIENT_ID = "test-client-id";
export const TEST_CLIENT_SECRET = "test-client-secret-value";
export const TEST_AUTH_SECRET = "test-auth-secret-0123456789-0123456789-abc";

export const OCTOCAT: FakeGithubUser = {
  id: 583231,
  login: "octocat",
  name: "The Octocat",
  email: "octocat@example.test",
};

export type CookieJar = Map<string, string>;

export async function createAuthHarness(
  options: {
    secureCookies?: boolean;
    githubRequestTimeoutMs?: number;
    users?: FakeGithubUser[];
  } = {},
) {
  const { db } = await createTestDatabase();
  const github: FakeGithub = await startGithubFake({
    clientId: TEST_CLIENT_ID,
    clientSecret: TEST_CLIENT_SECRET,
  });
  cleanUpAfterTest(() => github.close());
  for (const user of options.users ?? [OCTOCAT]) github.addUser(user);

  // The settings come through the same loader as in the app, including the flag that allows the
  // fake GitHub's address. `secureCookies` is what an https BETTER_AUTH_URL yields; the harness
  // keeps its address on http (nothing here listens on it) and forces the flag.
  const loaded = loadAuthConfig({
    BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
    BETTER_AUTH_URL: TEST_BASE_URL,
    GITHUB_OAUTH_CLIENT_ID: TEST_CLIENT_ID,
    GITHUB_OAUTH_CLIENT_SECRET: TEST_CLIENT_SECRET,
    GITHUB_OAUTH_BASE_URL: github.baseUrl,
    GITHUB_API_BASE: github.baseUrl,
    ALLOW_TEST_GITHUB_ENDPOINTS: "true",
  });
  const config = {
    ...loaded,
    secureCookies: options.secureCookies ?? loaded.secureCookies,
  };
  const auth = createAuth({
    db,
    config,
    githubRequestTimeoutMs: options.githubRequestTimeoutMs,
  });

  /** Sends a request to the auth handler the way the route handler does. */
  function request(
    path: string,
    init: RequestInit & { cookies?: CookieJar } = {},
  ): Promise<Response> {
    const { cookies, headers, ...rest } = init;
    const merged = new Headers(headers);
    if (!merged.has("origin")) merged.set("origin", TEST_BASE_URL);
    if (cookies && cookies.size > 0)
      merged.set("cookie", cookieHeader(cookies));
    return auth.handler(
      new Request(`${TEST_BASE_URL}${path}`, { ...rest, headers: merged }),
    );
  }

  /** The first step of a sign in: asks for the GitHub URL and keeps the cookies it sets. */
  async function startSignIn(
    body: Record<string, unknown> = { callbackURL: "/" },
    cookies: CookieJar = new Map(),
  ) {
    const response = await request("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", ...body }),
      cookies,
    });
    remember(cookies, response);
    const bodyText = await response.text();
    let authorizeUrl: string | undefined;
    try {
      authorizeUrl = (JSON.parse(bodyText) as { url?: string }).url;
    } catch {
      // Not JSON: the sign in was refused and there is no address to go to.
    }
    return { response, bodyText, authorizeUrl, cookies };
  }

  /** The last step: the browser arrives at the callback address. */
  async function callback(callbackUrl: URL, cookies: CookieJar) {
    const response = await request(
      `${callbackUrl.pathname}${callbackUrl.search}`,
      {
        cookies,
        redirect: "manual",
      },
    );
    remember(cookies, response);
    return response;
  }

  /** A whole sign in as `login`: start, authorize at the fake, callback. */
  async function signIn(login = OCTOCAT.login) {
    const { authorizeUrl, cookies } = await startSignIn();
    if (!authorizeUrl)
      throw new Error("The sign in did not return a GitHub URL");
    const callbackUrl = await github.authorize(authorizeUrl, login);
    const response = await callback(callbackUrl, cookies);
    return { response, cookies };
  }

  return { db, github, auth, config, request, startSignIn, callback, signIn };
}

export function remember(cookies: CookieJar, response: Response): void {
  for (const line of response.headers.getSetCookie()) {
    const [pair = ""] = line.split(";");
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    // An expired or emptied cookie is a deletion.
    if (value === "" || /max-age=0/i.test(line)) cookies.delete(name);
    else cookies.set(name, value);
  }
}

export function cookieHeader(cookies: CookieJar): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}
