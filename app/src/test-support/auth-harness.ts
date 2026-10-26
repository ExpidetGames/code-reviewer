// SPDX-License-Identifier: LicenseRef-Proprietary

// A complete sign in setup for integration tests: a real Postgres database, the real Better Auth
// instance of the app, and the fake GitHub on a loopback port. The tests call `auth.handler`
// with real `Request` objects, the same entry point the route handler uses, and walk the OAuth
// flow the way a browser does (sign in request, authorize at the fake, callback), keeping cookies.
import type {
  FakeGithub,
  FakeGithubUser,
} from "../../../fakes/github/server.ts";
import type { SignInMethods } from "../admin/sign-in-methods.ts";
import { createAuth } from "../auth/auth.ts";
import { loadAuthConfig } from "../auth/config.ts";
import { createGithubSignInDecider } from "../github-signin/decider.ts";
import type { SignUpRule } from "../signup/rule.ts";
import type { SignUpFacts } from "../signup/state.ts";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import {
  startTestGithub,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
} from "./github-fake.ts";
import { createTestDatabase } from "./test-database.ts";

export { TEST_CLIENT_ID, TEST_CLIENT_SECRET };
export const TEST_BASE_URL = "http://localhost:3000";
export const TEST_AUTH_SECRET = "test-auth-secret-0123456789-0123456789-abc";

export const OCTOCAT: FakeGithubUser = {
  id: 583231,
  login: "octocat",
  name: "The Octocat",
  email: "octocat@example.test",
};

export type CookieJar = Map<string, string>;

export type AuthHarnessOptions = {
  /**
   * The fake GitHub to sign in at. Default: a new one (`startTestGithub`). Pass the instance a
   * GitHub integration test uses to run both against one fake.
   */
  github?: FakeGithub;
  secureCookies?: boolean;
  githubRequestTimeoutMs?: number;
  users?: FakeGithubUser[];
  /** The sign-up rule in force. Default: everyone. */
  signUpRule?: SignUpRule;
  /** Whether the instance can send mail (a mail server is configured). Default: no. */
  mailConfigured?: boolean;
  /** The ways to sign in that are on. Default: both. */
  signInMethods?: SignInMethods;
};

export async function createAuthHarness(options: AuthHarnessOptions = {}) {
  const { db } = await createTestDatabase();
  const github = options.github ?? (await startTestGithub());
  for (const user of options.users ?? [OCTOCAT]) github.addUser(user);
  return assembleHarness(db, github, options);
}

export type AuthHarness = Awaited<ReturnType<typeof createAuthHarness>>;

// Everything that depends on the settings: the Better Auth instance and the request helpers. `restart`
// builds it again over the same database and the same fake GitHub with other settings.
function assembleHarness(
  db: Kysely<Database>,
  github: FakeGithub,
  options: AuthHarnessOptions,
) {
  // The settings come through the same loader as in the app, including the flag that allows the
  // fake GitHub's address. `secureCookies` is what an https BETTER_AUTH_URL yields; the harness
  // keeps its address on http (nothing here listens on it) and forces the flag.
  const loaded = loadAuthConfig({
    APP_SECRET: TEST_AUTH_SECRET,
    BETTER_AUTH_URL: TEST_BASE_URL,
    GITHUB_OAUTH_BASE_URL: github.baseUrl,
    GITHUB_API_BASE_URL: github.baseUrl,
    ALLOW_TEST_GITHUB_ENDPOINTS: "true",
  });
  const config = {
    ...loaded,
    secureCookies: options.secureCookies ?? loaded.secureCookies,
  };
  // What the decision of the sign in rests on, as the app reads it per sign in; a test changes it.
  const facts: SignUpFacts = {
    rule: options.signUpRule ?? { kind: "everyone" },
    signInMethods: options.signInMethods ?? {
      emailPassword: true,
      github: true,
    },
    mailConfigured: options.mailConfigured ?? false,
  };
  const auth = createAuth({
    db,
    config,
    githubSignIn: {
      clientId: TEST_CLIENT_ID,
      clientSecret: TEST_CLIENT_SECRET,
      decide: createGithubSignInDecider({
        db,
        readFacts: () => Promise.resolve({ ...facts }),
      }),
    },
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
  async function signIn(who: string | number = OCTOCAT.login) {
    const { callbackUrl, cookies } = await authorizeSignIn(who);
    const response = await callback(callbackUrl, cookies);
    return { response, cookies };
  }

  /**
   * A sign in up to the callback: start, authorize at the fake. `who` is a login, or an account id
   * when two accounts have the same login. The test completes it with `callback`.
   */
  async function authorizeSignIn(who: string | number) {
    const { authorizeUrl, cookies } = await startSignIn();
    if (!authorizeUrl)
      throw new Error("The sign in did not return a GitHub URL");
    const callbackUrl = await github.authorize(authorizeUrl, who);
    return { callbackUrl, cookies };
  }

  return {
    db,
    github,
    auth,
    config,
    request,
    startSignIn,
    callback,
    signIn,
    authorizeSignIn,
    /** The facts the decision rests on; change them to change the rule, the mail server or the ways to sign in. */
    facts,
    /** The same database and fake GitHub, started again with other settings. */
    restart: (changes: AuthHarnessOptions) =>
      assembleHarness(db, github, { ...options, ...changes }),
  };
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
