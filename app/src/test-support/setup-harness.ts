// SPDX-License-Identifier: Apache-2.0

// The first-run setup, assembled for integration tests: a real SQLite file, the real Better Auth
// instance (email and password only), the real completion, the real route handlers, the real setup
// gate and access proxy in front of them, and a code store with a clock the test moves. The tests
// send real `Request` objects and keep cookies, the way a browser does. Nothing listens on a port.
import { NextRequest } from "next/server";
import type { AccessGates } from "../auth/access-gates.ts";
import { createAccessProxy } from "../auth/access-proxy.ts";
import { createAccessPolicy } from "../auth/access-policy.ts";
import { parseAccessConfig } from "../auth/access-config.ts";
import { createAuth } from "../auth/auth.ts";
import { loadAuthConfig } from "../auth/config.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { createSetupCodeStore } from "../setup/code-store.ts";
import { completeSetup } from "../setup/complete.ts";
import { createCredentialCheck } from "../setup/credential-check.ts";
import { createSetupGate } from "../setup/gate-proxy.ts";
import { createSetupRouteHandlers } from "../setup/http.ts";
import { createSetupStateReader, readSetupState } from "../setup/state.ts";
import { startSetupOnStart } from "../setup/start.ts";
import { SETUP_SESSION_COOKIE } from "../setup/setup-session.ts";
import { cookieHeader, remember, type CookieJar } from "./auth-harness.ts";
import { createTestDatabase } from "./test-database.ts";

export const SETUP_TEST_BASE_URL = "http://localhost:3000";
export const SETUP_TEST_SECRET = "setup-test-secret-0123456789-0123456789";
/** The code the harness's process prints; fixed so that a test can submit it. */
export const SETUP_TEST_CODE = "482913";
export const SETUP_TEST_ADMIN = {
  email: "admin@example.com",
  password: "x7Kq-m2Vd9Lw",
};

export const WIZARD_BODY = {
  tenancy: "single",
  signUp: { kind: "everyone" },
  admin: SETUP_TEST_ADMIN,
} as const;

export type SetupHarnessOptions = {
  /** Cookies get the `Secure` attribute, as over https. */
  secureCookies?: boolean;
};

export async function createSetupHarness(options: SetupHarnessOptions = {}) {
  const { db } = await createTestDatabase();
  return assemble(db, options);
}

export type SetupHarness = Awaited<ReturnType<typeof createSetupHarness>>;

/**
 * One app process over `db`. `restart()` is a second process over the same database: its own code
 * store, its own counters, like the app after a restart (or a second instance).
 */
function assemble(
  db: Awaited<ReturnType<typeof createTestDatabase>>["db"],
  options: SetupHarnessOptions,
  firstCode: string = SETUP_TEST_CODE,
) {
  const config = {
    ...loadAuthConfig({
      APP_SECRET: SETUP_TEST_SECRET,
      BETTER_AUTH_URL: SETUP_TEST_BASE_URL,
    }),
    ...(options.secureCookies === undefined
      ? {}
      : { secureCookies: options.secureCookies }),
  };
  // Whether the instance can send mail, which a test switches: the sign in refuses an unverified address
  // while it can, and the gates in front of the app ask the same.
  const gateState = { mail: false };
  const auth = createAuth({
    db,
    config,
    verificationRequired: () => Promise.resolve(gateState.mail),
  });
  let time = Date.parse("2026-10-11T08:00:00.000Z");
  const store = createSetupCodeStore({
    now: () => time,
    randomCode: () => firstCode,
  });
  const readState = createSetupStateReader(() => readSetupState(db));
  const logs: string[] = [];
  let afterCompletedCalls = 0;

  const handlers = createSetupRouteHandlers({
    appSecret: config.secret,
    secureCookies: config.secureCookies,
    store,
    readState,
    now: () => time,
    log: (line) => logs.push(line),
    afterCompleted: () => {
      afterCompletedCalls += 1;
    },
    async complete(input) {
      const context = await auth.$context;
      return completeSetup(
        {
          db,
          hashPassword: context.password.hash,
          checkCredential: createCredentialCheck(context.password.verify),
        },
        input,
      );
    },
    async signInAdmin(email, password, requestHeaders) {
      const headers = new Headers();
      const agent = requestHeaders.get("user-agent");
      if (agent !== null) headers.set("user-agent", agent);
      const response = await auth.api.signInEmail({
        body: { email, password },
        headers,
        asResponse: true,
      });
      return response.ok ? response.headers.getSetCookie() : null;
    },
  });

  const gate = createSetupGate({ readState });
  // The gates in front of the app: a verified address (while the instance can send mail, which a test
  // switches with `gateState.mail`) and a workspace (read from the database, like the server does).
  const gates: AccessGates = {
    verificationRequired: () => Promise.resolve(gateState.mail),
    hasWorkspace: (userId) =>
      createWorkspacesRepository(db).hasMembership(userId),
    async workspaceRole(userId, slug) {
      const membership = await createWorkspacesRepository(db).findMembership(
        userId,
        slug,
      );
      return membership?.role ?? null;
    },
    async firstWorkspaceSlug(userId) {
      const [first] = await createWorkspacesRepository(db).listForUser(userId);
      return first?.workspace.slug ?? null;
    },
  };
  // The allow list is for GitHub identities; none is configured here, and nobody signs in with GitHub.
  const problems: string[] = [];
  const access = createAccessProxy({
    getAuth: () => auth,
    getPolicy: () =>
      createAccessPolicy({
        config: parseAccessConfig({}, problems),
        loginPins: {
          pin: () => Promise.resolve(null),
          revokeSessions: () => Promise.resolve(),
        },
      }),
    getGates: () => gates,
  });

  /**
   * A request through the whole proxy: the setup gate, then the session check. What passes both
   * reaches "the route": the two setup routes run their real handlers, everything else answers 200
   * with `reached`, so a test can tell that a request got through.
   */
  async function visit(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      cookies?: CookieJar;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    if (init.cookies && init.cookies.size > 0)
      headers.set("cookie", cookieHeader(init.cookies));
    if (init.body !== undefined && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    const bodyText =
      init.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body);
    // One request per consumer: a body can be read once, and a clone is not a NextRequest.
    const build = () =>
      new NextRequest(`${SETUP_TEST_BASE_URL}${path}`, {
        method,
        headers,
        ...(bodyText === undefined ? {} : { body: bodyText }),
      });

    const gated = await gate(build());
    const outcome = gated ?? (await access(build()));
    const passed = outcome.headers.get("x-middleware-next") === "1";
    const rewrite = outcome.headers.get("x-middleware-rewrite");
    if (rewrite !== null) return outcome;
    if (!passed) return outcome;

    const url = new URL(`${SETUP_TEST_BASE_URL}${path}`);
    let response: Response;
    if (url.pathname === "/api/setup/code" && method === "POST")
      response = await handlers.submitCode(build());
    else if (url.pathname === "/api/setup/complete" && method === "POST")
      response = await handlers.complete(build());
    else response = new Response("reached", { status: 200 });
    if (init.cookies) remember(init.cookies, response);
    return response;
  }

  return {
    db,
    auth,
    config,
    store,
    logs,
    /** How many times the follow-up step after a completed setup ran. */
    afterCompletedCount: () => afterCompletedCalls,
    visit,
    /** The two proxies in front of every route, for harnesses that route requests themselves. */
    gate,
    access,
    /** The access gates the proxy uses; `gateState.mail` says whether the instance can send mail. */
    gates,
    gateState,
    /** What the server does at start: reads the state and prints the code (to `logs`). */
    async start() {
      const printed: string[] = [];
      const result = await startSetupOnStart({
        db,
        store,
        log: (line) => printed.push(line),
      });
      return { ...result, printed };
    },
    /** Moves the clock of this process. */
    advance(ms: number) {
      time += ms;
    },
    /** The same database, a new process: another code store and another state cache. */
    restart(code: string = SETUP_TEST_CODE) {
      return assemble(db, options, code);
    },
    /** Submits a code from a client with its own cookies. */
    async submitCode(code: string, cookies: CookieJar = new Map()) {
      const response = await visit("/api/setup/code", {
        method: "POST",
        body: { code },
        cookies,
      });
      return { response, cookies };
    },
    /** Finishes the wizard with the setup session in `cookies`. */
    complete(cookies: CookieJar, body: unknown = WIZARD_BODY) {
      return visit("/api/setup/complete", { method: "POST", body, cookies });
    },
    SETUP_SESSION_COOKIE,
  };
}
