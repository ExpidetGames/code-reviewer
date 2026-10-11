// The fake GitHub: one HTTP server that speaks every part of GitHub that Code Reviewer talks to, so
// the tests of the sign in and the tests of the GitHub integration share one fake and one address.
//
//   sign in         oauth.ts    /login/oauth/*, /user, /user/emails, /user/memberships/orgs/:org
//   GitHub App API  app-api.ts  /app/installations*, /installation/*, /repos/:owner/:repo/*
//   control         here        /__fake/health, /__fake/reset (and /__fake/users, /__fake/org-members
//                               from the sign in part) for tests that run the fake as its own process
//
// A part is switched on by its options: `clientId` and `clientSecret` give the sign in, `appId` and
// `publicKeyPem` give the GitHub App API. A part that is not switched on answers 404, like a GitHub
// that does not know the path. The app under test is pointed at the fake with `GITHUB_OAUTH_BASE_URL`
// and `GITHUB_API_BASE_URL` (both set to `baseUrl`).
//
// State lives in memory. Dummy values only. Runs in the same process as a Vitest test or as its own
// process for the Playwright journeys (`main.ts`).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createAppPart,
  type AppPart,
  type FakeGithubAppControls,
} from "./app-api.ts";
import { send, sendJson } from "./http.ts";
import {
  createOAuthPart,
  type FakeGithubOAuth,
  type OAuthPart,
} from "./oauth.ts";

export type {
  FakeCollaboratorPermission,
  FakeInstallation,
  FakePermissions,
  FakePullRequest,
  FakeRepository,
  FakeTokenRequest,
} from "./app-api.ts";
export { DEFAULT_FAKE_APP_PERMISSIONS } from "./app-api.ts";
export type {
  FakeGithubUser,
  FakeMembershipState,
  MembershipEndpointFailure,
  TokenEndpointFailure,
} from "./oauth.ts";

export type FakeGithubOptions = {
  /** Switches the sign in on: the credentials of the OAuth app (give both or neither). */
  clientId?: string;
  clientSecret?: string;
  /** Switches the GitHub App API on: the app id and the SPKI PEM its JWTs are checked with (both or neither). */
  appId?: string;
  publicKeyPem?: string;
  /** The fake's clock in milliseconds since the epoch, for tokens and JWTs. Default Date.now. */
  now?: () => number;
  /**
   * The slug of the GitHub App: the comments it writes are authored as `<slug>[bot]` (GitHub App
   * API only). Default "fake-app".
   */
  appSlug?: string;
  /**
   * Makes the links in answers (`html_url` of repositories, pull requests, comments) point to the
   * fake itself instead of the unreachable `https://github.test`. Needed where something reads a
   * pull request through the fake and checks its address: the runner demands that the pull request
   * and the API address of a job are on the same host. Default false.
   */
  selfLinks?: boolean;
  /** Default 127.0.0.1. */
  host?: string;
  /** Default 0: a free port. */
  port?: number;
};

export type FakeGithubRequest = { method: string; path: string };

/** Makes matching requests fail before they are looked at. */
export type FakeFailure = {
  /** Applies to requests whose path (without query) contains this text; every request when omitted. */
  pathIncludes?: string;
  /** Applies to requests whose query string contains this text, for example "page=2". */
  queryIncludes?: string;
  /** Answers with this status and an empty JSON error body. */
  status?: number;
  headers?: Record<string, string>;
  /** Waits this long before looking at the request (and before the status, if both are given). */
  delayMs?: number;
  /**
   * Looks at the request at once but sends the answer only after this long: the answer reflects the
   * state of GitHub when the request arrived, and reaches the client later, like a slow response.
   * Applies to the answers of the GitHub App API.
   */
  responseDelayMs?: number;
  /** How many requests it applies to; forever when omitted. */
  times?: number;
};

/** The whole fake: the controls of the sign in and of the GitHub App API, plus what both share. */
export type FakeGithub = FakeGithubOAuth &
  FakeGithubAppControls & {
    /** For example http://127.0.0.1:41234; serves the OAuth pages and the API alike. */
    baseUrl: string;
    /** Makes matching requests fail, on any path. */
    fail(failure: FakeFailure): void;
    clearFailures(): void;
    /**
     * Removes all state of every part, the recorded requests and the injected failures. The failure
     * modes of the token and membership endpoints stay (`failTokenEndpoint`, `failMembershipEndpoint`).
     */
    reset(): void;
    /** Every request received, in order (method and path only: no headers, no bodies, no tokens). */
    requests(): FakeGithubRequest[];
    /** Every credential (JWT or token) any request carried; lets a test search outputs for them. */
    seenCredentials(): string[];
    close(): Promise<void>;
  };

export async function startGithubFake(
  options: FakeGithubOptions,
): Promise<FakeGithub> {
  const { clientId, clientSecret, appId, publicKeyPem } = options;
  if ((clientId === undefined) !== (clientSecret === undefined))
    throw new Error("The fake GitHub needs clientId and clientSecret together");
  if ((appId === undefined) !== (publicKeyPem === undefined))
    throw new Error("The fake GitHub needs appId and publicKeyPem together");

  const host = options.host ?? "127.0.0.1";
  let baseUrl = "";
  const oauth: OAuthPart | undefined =
    clientId !== undefined && clientSecret !== undefined
      ? createOAuthPart({ clientId, clientSecret }, () => baseUrl)
      : undefined;
  const app: AppPart | undefined =
    appId !== undefined && publicKeyPem !== undefined
      ? createAppPart({
          appId,
          publicKeyPem,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.appSlug === undefined
            ? {}
            : { appSlug: options.appSlug }),
          ...(options.selfLinks === true
            ? { webBase: () => baseUrl, apiBase: () => baseUrl }
            : {}),
        })
      : undefined;

  let log: FakeGithubRequest[] = [];
  let credentials: string[] = [];
  let failures: Array<FakeFailure & { remaining: number }> = [];

  function takeFailure(path: string, query: string): FakeFailure | undefined {
    const failure = failures.find(
      (candidate) =>
        candidate.remaining > 0 &&
        (candidate.pathIncludes === undefined ||
          path.includes(candidate.pathIncludes)) &&
        (candidate.queryIncludes === undefined ||
          query.includes(candidate.queryIncludes)),
    );
    if (failure === undefined) return undefined;
    failure.remaining -= 1;
    return failure;
  }

  function resetAll(): void {
    oauth?.reset();
    app?.reset();
    log = [];
    credentials = [];
    failures = [];
  }

  const server: Server = createServer((request, response) => {
    handle().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 500, {
        message: `fake github failed: ${String(error)}`,
      });
    });

    async function handle(): Promise<void> {
      const url = new URL(request.url ?? "/", "http://fake.invalid");
      const path = url.pathname;
      const method = request.method ?? "GET";
      log.push({ method, path });

      // GitHub takes both schemes; PyGithub (PR-Agent) sends `token <value>`, the app `Bearer <value>`.
      const header = request.headers.authorization;
      const bearer = header?.startsWith("Bearer ")
        ? header.slice(7)
        : header?.startsWith("token ")
          ? header.slice(6)
          : undefined;
      if (bearer !== undefined) credentials.push(bearer);

      // The control endpoints of the test itself are not GitHub and never fail on purpose.
      const failure = path.startsWith("/__fake/")
        ? undefined
        : takeFailure(path, url.search);
      if (failure?.delayMs !== undefined)
        await new Promise((resolve) => setTimeout(resolve, failure.delayMs));
      if (failure?.status !== undefined) {
        send(
          response,
          failure.status,
          "application/json",
          JSON.stringify({ message: "Injected failure" }),
          failure.headers,
        );
        return;
      }

      if (method === "GET" && path === "/__fake/health")
        return sendJson(response, 200, { ok: true });
      if (method === "POST" && path === "/__fake/reset") {
        resetAll();
        return sendJson(response, 200, { ok: true });
      }

      if (oauth && (await oauth.handle(request, response, url))) return;
      if (
        app &&
        (await app.handle({
          request,
          response,
          url,
          bearer,
          // The answer is worked out now (when the request arrived) and sent later.
          reply: async (status, body) => {
            if (failure?.responseDelayMs !== undefined)
              await new Promise((resolve) =>
                setTimeout(resolve, failure.responseDelayMs),
              );
            sendJson(response, status, body);
          },
        }))
      )
        return;

      sendJson(response, 404, { message: "Not Found" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${String(address.port)}`;

  // The controls of a part that is switched off are absent: calling one is a TypeError, which is
  // what a test that forgot the option should get.
  const parts = { ...oauth?.controls, ...app?.controls } as FakeGithubOAuth &
    FakeGithubAppControls;

  return {
    ...parts,
    baseUrl,
    fail(failure) {
      failures.push({ ...failure, remaining: failure.times ?? Infinity });
    },
    clearFailures() {
      failures = [];
    },
    reset: resetAll,
    requests: () => [...log],
    seenCredentials: () => [...credentials],
    async close() {
      oauth?.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
