// SPDX-License-Identifier: Apache-2.0

// The sign-up and the email verification assembled for integration tests: an instance set up through the
// real first-run setup (so the instance admin is made by the same code as in production), the real
// Better Auth, a mail double that keeps an outbox and can be switched between "mail server" and "none",
// the real counters over a real SQLite file, and the real route handlers. Requests are real `Request`
// objects with a JSON body, the way a browser sends them; nothing listens on a port.
import {
  createInstanceSettingsRepository,
  type InstanceSettingValues,
} from "../db/repositories/instance-settings-repository.ts";
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
  const flags = { github: options.githubConfigured ?? false };
  const clock = { time: Date.parse("2026-10-11T09:00:00.000Z") };
  const now = () => new Date(clock.time);
  const logs: string[] = [];
  const pending: Promise<void>[] = [];
  const session = { userId: null as string | null };

  const handlers = assembleSignUp({
    db,
    mail,
    hashPassword: (await auth.$context).password.hash,
    githubConfigured: () => flags.github,
    baseUrl: SIGNUP_TEST_BASE_URL,
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
    logs,
    session,
    admin: SETUP_TEST_ADMIN,
    advance(ms: number) {
      clock.time += ms;
    },
    now,
    /** Waits for the work that runs after an answer (the mails). */
    async flush() {
      await Promise.all(pending.splice(0));
    },
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
