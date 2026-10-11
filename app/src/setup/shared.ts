// The wiring of the running server for the first-run setup: the one setup code store of the process
// (kept on globalThis, because the instrumentation, the proxy and the route bundles do not share
// modules), the state reader on the server's database, and the route handlers with the real hash and
// the real sign in.
import "server-only";
import { anyGithubAppVariableSet } from "../integrations/providers/github-app/configured.ts";
import { loadAuthConfig } from "../auth/config.ts";
import { getAuth } from "../auth/auth.ts";
import { getDatabase } from "../db/startup.ts";
import { checkSetupSession, type SetupSessionCheck } from "./setup-session.ts";
import { createSetupCodeStore, type SetupCodeStore } from "./code-store.ts";
import { completeSetup } from "./complete.ts";
import { createCredentialCheck } from "./credential-check.ts";
import { createSetupRouteHandlers, type SetupRouteHandlers } from "./http.ts";
import {
  createSetupStateReader,
  readSetupState,
  type SetupStateReader,
} from "./state.ts";

const globalKey = Symbol.for("code-reviewer.setup");
type SetupGlobals = { store: SetupCodeStore; readState?: SetupStateReader };
type GlobalWithSetup = typeof globalThis & { [globalKey]?: SetupGlobals };

function globals(): SetupGlobals {
  const holder = globalThis as GlobalWithSetup;
  holder[globalKey] ??= { store: createSetupCodeStore() };
  return holder[globalKey];
}

/** The setup code store of this process. The code lives nowhere else. */
export function getSetupCodeStore(): SetupCodeStore {
  return globals().store;
}

/** Whether the instance is set up, read from the database until it is. */
export function getSetupStateReader(): SetupStateReader {
  const state = globals();
  state.readState ??= createSetupStateReader(() =>
    readSetupState(getDatabase()),
  );
  return state.readState;
}

/** The handlers of `/api/setup/code` and `/api/setup/complete` on the running server. */
export function getSetupRouteHandlers(): SetupRouteHandlers {
  const config = loadAuthConfig(process.env);
  return createSetupRouteHandlers({
    appSecret: config.secret,
    secureCookies: config.secureCookies,
    store: getSetupCodeStore(),
    readState: getSetupStateReader(),
    afterCompleted: runSyncAfterSetup,
    async complete(input) {
      const auth = getAuth();
      const context = await auth.$context;
      return completeSetup(
        {
          db: getDatabase(),
          hashPassword: context.password.hash,
          checkCredential: createCredentialCheck(context.password.verify),
        },
        input,
      );
    },
    async signInAdmin(email, password, requestHeaders) {
      // Only what the session record keeps (address, browser); the setup cookie stays out.
      const headers = new Headers();
      for (const name of ["user-agent", "x-forwarded-for", "x-real-ip"]) {
        const value = requestHeaders.get(name);
        if (value !== null) headers.set(name, value);
      }
      const response = await getAuth().api.signInEmail({
        body: { email, password },
        headers,
        asResponse: true,
      });
      return response.ok ? response.headers.getSetCookie() : null;
    },
  });
}

/** Whether a setup session cookie value is valid now, for the current code of this process. */
export function checkCurrentSetupSession(
  cookieValue: string | undefined,
): SetupSessionCheck {
  return checkSetupSession(
    loadAuthConfig(process.env).secret,
    cookieValue,
    getSetupCodeStore().currentIssueId(),
    Date.now(),
  );
}

/**
 * The synchronization with GitHub that ran when the server started could not put a connection that is
 * new to the instance into a workspace while the setup was open (there was none to put it in). Now
 * there is one, so it runs again, in the background. Not when no GitHub App variable is set: then
 * there is nothing to read.
 */
function runSyncAfterSetup(): void {
  if (!anyGithubAppVariableSet(process.env)) return;
  void import("../integrations/sync/startup.ts").then(({ runStartupSync }) =>
    runStartupSync(),
  );
}
