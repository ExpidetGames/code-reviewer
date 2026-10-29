// SPDX-License-Identifier: LicenseRef-Proprietary

// The sign-up and the email verification assembled for integration tests: an instance set up through the
// real first-run setup (so the instance admin is made by the same code as in production), the real
// Better Auth, a mail double that keeps an outbox and can be switched between "mail server" and "none",
// the real counters over a real Postgres database, and the real route handlers. Requests are real `Request`
// objects with a JSON body, the way a browser sends them; nothing listens on a port.
import {
  createInstanceSettingsRepository,
  type InstanceSettingValues,
} from "../db/repositories/instance-settings-repository.ts";
import { CODE_REVIEW_COM } from "../product-identity/code-review-com.ts";
import { assembleSignUp } from "../signup/assemble.ts";
import { createFakeMail } from "./fake-mail.ts";
import {
  createSetupHarness,
  SETUP_TEST_ADMIN,
  SETUP_TEST_BASE_URL,
  SETUP_TEST_CODE,
  WIZARD_BODY,
} from "./setup-harness.ts";

export const SIGNUP_TEST_BASE_URL = SETUP_TEST_BASE_URL;
export const SIGNUP_TEST_PASSWORD = "k9Pq-v3Xm7Rt";

export type SignUpHarnessOptions = {
  /** Whether the instance starts with a mail server. Default: no. */
  mail?: boolean;
  /** The sign-up rule the instance starts with. Default: everyone. */
  rule?: InstanceSettingValues["sign_up_rule"];
  githubConfigured?: boolean;
};

export async function createSignUpHarness(options: SignUpHarnessOptions = {}) {
  const setup = await createSetupHarness();
  const { db, auth } = setup;
  await setup.start();
  const { cookies } = await setup.submitCode(SETUP_TEST_CODE);
  const completed = await setup.complete(cookies, WIZARD_BODY);
  if (completed.status !== 200)
    throw new Error(`The setup did not complete: ${completed.status}`);

  const settings = createInstanceSettingsRepository(db);
  if (options.rule !== undefined)
    await settings.set("sign_up_rule", options.rule, null);

  const mail = createFakeMail(options.mail ?? false);
  // One switch for "the instance has a mail server": the sign in and the gates in front of the app ask it
  // from the setup harness, the sign-up asks the mail double.
  Object.defineProperty(setup.gateState, "mail", {
    get: () => mail.configured,
    set: (value: boolean) => {
      mail.configured = value;
    },
  });
  const flags = { github: options.githubConfigured ?? false };
  const clock = { time: Date.parse("2026-10-11T09:00:00.000Z") };
  const now = () => new Date(clock.time);
  const logs: string[] = [];
  const pending: Array<() => Promise<void>> = [];
  const session = { userId: null as string | null };

  const hash = (await auth.$context).password.hash;
  const hashed = { count: 0 };
  const handlers = assembleSignUp({
    db,
    mail,
    verifyPassword: (await auth.$context).password.verify,
    hashPassword: (password) => {
      hashed.count += 1;
      return hash(password);
    },
    githubConfigured: () => flags.github,
    baseUrl: SIGNUP_TEST_BASE_URL,
    product: CODE_REVIEW_COM,
    currentUserId: () => Promise.resolve(session.userId),
    defer: (work) => {
      pending.push(work);
    },
    now,
    log: (line) => logs.push(line),
  });

  function post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Request {
    return new Request(`${SIGNUP_TEST_BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  return {
    ...setup,
    db,
    auth,
    mail,
    settings,
    flags,
    /** How many passwords the sign-up has hashed. */
    hashed,
    logs,
    session,
    admin: SETUP_TEST_ADMIN,
    advance(ms: number) {
      clock.time += ms;
    },
    now,
    /** Runs the work that waits for the answer to be sent (the account and the mail) and waits for it. */
    async flush() {
      await Promise.all(pending.splice(0).map((work) => work()));
    },
    /** How many pieces of work wait for the answer to be sent. Nothing of them has started. */
    waiting: () => pending.length,
    signUp: (body: unknown, headers?: Record<string, string>) =>
      handlers.signUp(post("/api/sign-up", body, headers)),
    verify: (body: unknown, headers?: Record<string, string>) =>
      handlers.verify(post("/api/verify-email", body, headers)),
    resend: (body: unknown, headers?: Record<string, string>) =>
      handlers.resend(post("/api/verify-email/resend", body, headers)),
    post,
    handlers,
    async user(email: string) {
      return db
        .selectFrom("users")
        .selectAll()
        .where("email", "=", email)
        .executeTakeFirst();
    },
    async counts() {
      const count = async (table: "users" | "accounts" | "sessions") =>
        Number(
          (
            await db
              .selectFrom(table)
              .select((eb) => eb.fn.countAll().as("n"))
              .executeTakeFirstOrThrow()
          ).n,
        );
      return {
        users: await count("users"),
        accounts: await count("accounts"),
        sessions: await count("sessions"),
      };
    },
  };
}

export type SignUpHarness = Awaited<ReturnType<typeof createSignUpHarness>>;
