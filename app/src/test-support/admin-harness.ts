// SPDX-License-Identifier: Apache-2.0

// The admin portal assembled for integration tests: an instance set up through the real first-run setup
// (so the instance admin is made by the same code as in production), the real Better Auth, the setup
// gate and the access proxy in front, the real admin data routes behind them, and the real settings
// service and secret store over a real SQLite file. Requests are real `Request` objects with cookies, the
// way a browser sends them; nothing listens on a port.
import { sql } from "kysely";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { NextRequest } from "next/server";
import { adminAccessOf } from "../admin/access.ts";
import { MISSING_PATH, isAdminPath } from "../admin/paths.ts";
import { PORTAL_REWRITE_HEADER } from "../auth/access-proxy.ts";
import { createAdminRouteHandlers } from "../admin/http.ts";
import { createAdminService } from "../admin/service.ts";
import { createSecretStore } from "../secrets/store.ts";
import { lookupSession } from "../auth/session-user.ts";
import { createAccessPolicy } from "../auth/access-policy.ts";
import { parseAccessConfig } from "../auth/access-config.ts";
import { cookieHeader, remember, type CookieJar } from "./auth-harness.ts";
import {
  createSetupHarness,
  SETUP_TEST_ADMIN,
  SETUP_TEST_CODE,
  SETUP_TEST_BASE_URL,
  SETUP_TEST_SECRET,
  WIZARD_BODY,
} from "./setup-harness.ts";

export const ADMIN_TEST_BASE_URL = SETUP_TEST_BASE_URL;
export { SETUP_TEST_ADMIN as ADMIN_TEST_CREDENTIALS };

/** What `notFound()` of Next.js throws: the handlers call it for a person who is not an admin. */
export class NotFoundSignal extends Error {
  readonly digest = "NEXT_HTTP_ERROR_FALLBACK;404";
  constructor() {
    super("NEXT_HTTP_ERROR_FALLBACK;404");
  }
}

/** Marks the answer of a path that is no route of the app (the stand-in for Next.js's own 404). */
export const MISSING_ANSWER_MARKER = "x-answer-of-a-missing-path";

export type AdminHarnessOptions = {
  githubConfigured?: boolean;
  mailConfigured?: boolean;
};

export async function createAdminHarness(options: AdminHarnessOptions = {}) {
  const setup = await createSetupHarness();
  const { db, auth } = setup;

  // The instance is set up the way an operator does it: the code, then the wizard.
  await setup.start();
  const { cookies: setupCookies } = await setup.submitCode(SETUP_TEST_CODE);
  const completed = await setup.complete(setupCookies, WIZARD_BODY);
  if (completed.status !== 200)
    throw new Error(`The setup did not complete: ${completed.status}`);

  setup.gateState.mail = options.mailConfigured ?? false;
  const flags = {
    github: options.githubConfigured ?? false,
    /** Whether the instance can send mail; the access gates in front of the app read the same flag. */
    get mail(): boolean {
      return setup.gateState.mail;
    },
    set mail(value: boolean) {
      setup.gateState.mail = value;
    },
    /** What the access policy answers for a GitHub identity. */
    githubAllowed: true,
  };
  const secrets = createSecretStore({ db, appSecret: SETUP_TEST_SECRET });
  const service = createAdminService({
    db,
    secrets,
    githubConfigured: () => flags.github,
    mailConfigured: () => Promise.resolve(flags.mail),
    accessPolicy: () =>
      Promise.resolve(
        flags.githubAllowed
          ? { allowed: true }
          : { allowed: false, reason: "not_allowed" },
      ),
  });

  const policy = createAccessPolicy({
    config: parseAccessConfig({}, []),
    loginPins: {
      pin: () => Promise.resolve(null),
      revokeSessions: () => Promise.resolve(),
    },
  });
  // The headers of the request being served, as the page code reads them with `headers()`.
  const current = { headers: new Headers() };
  const handlers = createAdminRouteHandlers({
    access: async () => {
      const lookup = await lookupSession(
        auth,
        current.headers,
        policy,
        setup.gates,
      );
      return adminAccessOf(lookup);
    },
    notFound: () => {
      throw new NotFoundSignal();
    },
    service,
  });

  /** Makes a user with a password (and, if asked, the instance admin flag). */
  async function createUser(user: {
    id: string;
    email: string;
    password: string;
    isInstanceAdmin?: boolean;
    emailVerified?: boolean;
    /**
     * Whether the user is a Member of the instance's workspace. Default: yes, so a test about the portal's
     * guard meets the person who is not an admin and has access to the app. Pass `false` for an account
     * that has none, like a new sign-up.
     */
    member?: boolean;
  }): Promise<void> {
    const context = await auth.$context;
    const hash = await context.password.hash(user.password);
    const at = "2026-10-11T08:00:00.000Z";
    await db
      .insertInto("users")
      .values({
        id: user.id,
        name: user.email.split("@")[0] ?? user.email,
        email: user.email,
        email_verified: user.emailVerified === true ? 1 : 0,
        image: null,
        github_login: null,
        imported_at: null,
        is_instance_admin: user.isInstanceAdmin === true ? 1 : 0,
        org_checked_at: null,
        org_checked_for: null,
        created_at: at,
        updated_at: at,
      })
      .execute();
    await db
      .insertInto("accounts")
      .values({
        id: `account-${user.id}`,
        account_id: user.id,
        provider_id: "credential",
        user_id: user.id,
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scope: null,
        password: hash,
        created_at: at,
        updated_at: at,
      })
      .execute();
    if (user.member !== false && user.isInstanceAdmin !== true) {
      const workspace = await createWorkspacesRepository(db).findDefault();
      if (workspace === undefined)
        throw new Error("The set-up instance has no workspace to join.");
      await createWorkspacesRepository(db).addMember(
        workspace.id,
        user.id,
        "member",
      );
    }
  }

  /** Signs in with email and password the way the login form does; returns the cookies. */
  async function signIn(email: string, password: string): Promise<CookieJar> {
    const response = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    if (!response.ok) throw new Error(`Sign in failed: ${response.status}`);
    const cookies: CookieJar = new Map();
    remember(cookies, response);
    return cookies;
  }

  /**
   * A request through the setup gate and the access proxy; what passes both reaches "the route": the
   * admin data route runs its real handler, everything else answers 200 `reached`. A rewrite (the 404
   * for a person who is not an admin) is returned as the proxy made it.
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
    const build = () =>
      new NextRequest(`${ADMIN_TEST_BASE_URL}${path}`, {
        method,
        headers,
        ...(bodyText === undefined ? {} : { body: bodyText }),
      });
    const gated = await setup.gate(build());
    const outcome = gated ?? (await setup.access(build()));
    if (
      outcome.headers.get("x-middleware-next") !== "1" &&
      outcome.headers.get("x-middleware-rewrite") === null
    )
      return outcome;
    // The instance admin's request is rewritten to the files of the portal; anybody else's goes on as it
    // is. The files are all there is: `/admin` itself is no route.
    const rewrite = outcome.headers.get("x-middleware-rewrite");
    if (rewrite !== null) {
      const target = new URL(rewrite);
      // Next.js runs the proxy again on the path a rewrite leads to, with the headers the rewrite set.
      const again = new Headers(headers);
      const mark = outcome.headers.get(
        `x-middleware-request-${PORTAL_REWRITE_HEADER}`,
      );
      if (mark !== null) again.set(PORTAL_REWRITE_HEADER, mark);
      const second = await setup.access(
        new NextRequest(
          `${ADMIN_TEST_BASE_URL}${target.pathname}${target.search}`,
          {
            method,
            headers: again,
            ...(bodyText === undefined ? {} : { body: bodyText }),
          },
        ),
      );
      const followed = second.headers.get("x-middleware-rewrite");
      if (second.headers.get("x-middleware-next") !== "1")
        return followed === null
          ? second
          : reach(new Request(followed), headers);
      return reach(
        new Request(
          `${ADMIN_TEST_BASE_URL}${target.pathname}${target.search}`,
          {
            method,
            headers,
            ...(bodyText === undefined ? {} : { body: bodyText }),
          },
        ),
        headers,
      );
    }
    return reach(build(), headers);
  }

  /** The request as the route sees it, after the proxy let it through (or without a proxy at all). */
  async function reach(request: Request, headers: Headers): Promise<Response> {
    current.headers = headers;
    const { pathname } = new URL(request.url);
    // What is no route of the app is a missing path: 404, as the app answers it.
    if (pathname === MISSING_PATH || isAdminPath(pathname))
      return new Response("not found", {
        status: 404,
        headers: { [MISSING_ANSWER_MARKER]: "1" },
      });
    try {
      if (
        pathname === "/api/instance-portal/settings" &&
        request.method === "GET"
      )
        return await handlers.getSettings(request);
      if (
        pathname === "/api/instance-portal/settings" &&
        request.method === "PUT"
      )
        return await handlers.putSettings(request);
    } catch (error) {
      if (error instanceof NotFoundSignal)
        return new Response("not found", { status: 404 });
      throw error;
    }
    return new Response("reached", { status: 200 });
  }

  /** What the access proxy itself answers, before any route (for comparing two paths). */
  async function askProxy(
    path: string,
    init: { method?: string; cookies?: CookieJar } = {},
  ): Promise<Response> {
    const headers = new Headers();
    if (init.cookies && init.cookies.size > 0)
      headers.set("cookie", cookieHeader(init.cookies));
    return setup.access(
      new NextRequest(`${ADMIN_TEST_BASE_URL}${path}`, {
        method: init.method ?? "GET",
        headers,
      }),
    );
  }

  /** Calls the data route's handler directly, as if the proxy had not been there. */
  function callRoute(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      cookies?: CookieJar;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.cookies && init.cookies.size > 0)
      headers.set("cookie", cookieHeader(init.cookies));
    if (init.body !== undefined && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    return reach(
      new Request(`${ADMIN_TEST_BASE_URL}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
      headers,
    );
  }

  const adminCookies = await signIn(
    SETUP_TEST_ADMIN.email,
    SETUP_TEST_ADMIN.password,
  );
  const adminRow = await db
    .selectFrom("users")
    .select("id")
    .where("email", "=", SETUP_TEST_ADMIN.email)
    .executeTakeFirstOrThrow();

  // The file the database lives in, for the command line, which opens its own connection.
  const { rows: files } = await sql<{
    file: string;
  }>`select file from pragma_database_list where name = 'main'`.execute(db);

  return {
    ...setup,
    databasePath: files[0]?.file ?? "",
    adminId: adminRow.id,
    adminCookies,
    secrets,
    service,
    flags,
    createUser,
    signIn,
    visit,
    askProxy,
    callRoute,
  };
}

export type AdminHarness = Awaited<ReturnType<typeof createAdminHarness>>;
