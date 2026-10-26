// SPDX-License-Identifier: LicenseRef-Proprietary

// The first-run setup, assembled for integration tests: a real Postgres database, the real Better Auth
// instance (email and password only), the real completion, the real route handlers, the real setup
// gate and access proxy in front of them, and a database code store with a clock the test moves. The tests
// send real `Request` objects and keep cookies, the way a browser does. Nothing listens on a port.
import { NextRequest } from "next/server";
import type { AccessGates } from "../auth/access-gates.ts";
import { createAccessProxy } from "../auth/access-proxy.ts";
import { createAuth } from "../auth/auth.ts";
import { loadAuthConfig } from "../auth/config.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { SETUP_CODE_TTL_MS } from "../setup/code-store.ts";
import { createDatabaseSetupCodeStore } from "../setup/database-code-store.ts";
import { completeSetup } from "../setup/complete.ts";
import { createCredentialCheck } from "../setup/credential-check.ts";
import { createSetupGate } from "../setup/gate-proxy.ts";
import { createSetupRouteHandlers } from "../setup/http.ts";
import { SETUP_PAGE, SETUP_REWRITE_HEADER } from "../setup/paths.ts";
import { createSetupStateReader, readSetupState } from "../setup/state.ts";
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
  /** The clock the instances of the harness share; made by `createSetupHarness`. */
  clock?: { time: number };
};

export async function createSetupHarness(options: SetupHarnessOptions = {}) {
  const { db } = await createTestDatabase();
  return assemble(db, {
    ...options,
    clock: { time: Date.parse("2026-10-11T08:00:00.000Z") },
  });
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
  const logs: string[] = [];
  // The instances of the harness share one clock.
  const clock = options.clock ?? {
    time: Date.parse("2026-10-11T08:00:00.000Z"),
  };
  const store = createDatabaseSetupCodeStore({
    db,
    appSecret: SETUP_TEST_SECRET,
    now: () => clock.time,
    randomCode: () => firstCode,
    log: (line) => logs.push(line),
  });
  const readState = createSetupStateReader(() => readSetupState(db));
  let afterCompletedCalls = 0;

  const handlers = createSetupRouteHandlers({
    appSecret: config.secret,
    secureCookies: config.secureCookies,
    store,
    readState,
    now: () => clock.time,
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
  const access = createAccessProxy({
    getAuth: () => auth,
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

    // A page request the gate marked is served from the setup page by next.config.ts (the proxy builds
    // no address, src/setup/paths.ts); model that rewrite here, the way admin-harness.ts models the
    // portal's. The setup page is not a handler in this harness, so "setup-page" stands for it, and a
    // test can tell it from a request that merely got through.
    const setupMarked =
      outcome.headers.get(`x-middleware-request-${SETUP_REWRITE_HEADER}`) !==
      null;
    const url = new URL(
      `${SETUP_TEST_BASE_URL}${setupMarked ? SETUP_PAGE : path}`,
    );
    let response: Response;
    if (url.pathname === "/api/setup/code" && method === "POST")
      response = await handlers.submitCode(build());
    else if (url.pathname === "/api/setup/complete" && method === "POST")
      response = await handlers.complete(build());
    else if (url.pathname === SETUP_PAGE)
      response = new Response("setup-page", { status: 200 });
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
    /** What `pnpm setup-code` does: while the instance is not set up, it makes a code and prints it (to `printed`). */
    async start() {
      const printed: string[] = [];
      const state = await readSetupState(db);
      if (state.kind === "completed") return { setUp: true as const, printed };
      const issued = await store.issue();
      printed.push(
        `[setup] Setup code: ${issued.code}  (valid for ${String(SETUP_CODE_TTL_MS / 60_000)} minutes)`,
      );
      return { setUp: false as const, state, printed };
    },
    /** Moves the clock of this process. */
    advance(ms: number) {
      clock.time += ms;
    },
    /** The code store of this instance. */
    databaseStore: store,
    /** The time this instance sees. */
    now: () => clock.time,
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
