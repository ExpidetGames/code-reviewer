// SPDX-License-Identifier: Apache-2.0

// The sign-up with email and password (docs/decisions/0001-editions-setup-and-accounts.md, sections 2.5
// and 2.6). An account is created only when the sign-up is open (`signUpAvailability`), the address
// passes the rule and no account has it yet. Nothing about that is visible from outside: a visitor
// whose address is not allowed, or already has an account, gets exactly the answer of a new account, and
// the work is the same size (the password is hashed in every case, the mail is sent after the answer).
// What a visitor can learn is only what does not depend on the address: that the sign-up is closed, that
// it is switched off, that the form is wrong, that they are going too fast.
//
// With a mail server the account is created unverified and a link goes to the address; it cannot be used
// until the address is verified (src/auth/access-gates.ts). Without one, nothing can be verified and the
// account is usable at once under the rule everyone (a rule that names addresses is closed then). The new
// user has an account but no workspace: in a single-tenant instance they ask an admin for an invitation
// (the workspaces issue); nothing here joins them to anything.
import type { Kysely } from "kysely";
import { checkPassword } from "../auth/password-policy.ts";
import { CREDENTIAL_PROVIDER_ID } from "../auth/session-user.ts";
import { formatTimestamp } from "../db/codecs.ts";
import type { Database } from "../db/schema.ts";
import type { MailSender } from "../mail/sender.ts";
import {
  signUpAvailability,
  type SignUpUnavailableCode,
} from "./availability.ts";
import type { SignUpLimits } from "./limits.ts";
import { canonicalEmail, evaluateSignUpRule } from "./rule.ts";
import type { SignUpFacts } from "./state.ts";
import { sendVerificationMail } from "./verification-mail.ts";

export type SignUpIssue = {
  field: "email" | "password";
  /** `invalid_email` or a password code (`password_too_short`, ...). */
  code: string;
};

export type SignUpOutcome =
  /** `next`: what the person does now. The same for a new account and for none. */
  | { kind: "accepted"; next: "verify_email" | "sign_in" }
  | { kind: "unavailable"; error: SignUpUnavailableCode }
  | { kind: "invalid"; issues: SignUpIssue[] }
  | { kind: "rate_limited"; retryAfterSeconds: number };

export type SignUpDependencies = {
  db: Kysely<Database>;
  /** Better Auth's password hash (`context.password.hash`), so the sign in verifies the password. */
  hashPassword: (password: string) => Promise<string>;
  mail: MailSender;
  limits: SignUpLimits;
  facts: () => Promise<SignUpFacts>;
  baseUrl: string;
  /** Runs work after the answer is on its way (the mail), so its duration does not show. */
  defer: (work: Promise<void>) => void;
  now?: () => Date;
  newId?: () => string;
  log?: (message: string) => void;
};

/** Creates the user and its credential account in one transaction; false when the address is taken. */
async function createAccount(
  {
    db,
    now = () => new Date(),
    newId = () => crypto.randomUUID(),
  }: Pick<SignUpDependencies, "db" | "now" | "newId">,
  email: string,
  passwordHash: string,
): Promise<{ id: string } | null> {
  const timestamp = formatTimestamp(now());
  const id = newId();
  try {
    return await db.transaction().execute(async (trx) => {
      const taken = await trx
        .selectFrom("users")
        .select("id")
        .where("email", "=", email)
        .executeTakeFirst();
      if (taken !== undefined) return null;
      await trx
        .insertInto("users")
        .values({
          id,
          name: email.split("@")[0] ?? email,
          email,
          email_verified: 0,
          image: null,
          github_login: null,
          imported_at: null,
          is_instance_admin: 0,
          org_checked_at: null,
          org_checked_for: null,
          created_at: timestamp,
          updated_at: timestamp,
        })
        .execute();
      await trx
        .insertInto("accounts")
        .values({
          id: newId(),
          // Better Auth's credential account: the account id is the user id.
          account_id: id,
          provider_id: CREDENTIAL_PROVIDER_ID,
          user_id: id,
          access_token: null,
          refresh_token: null,
          id_token: null,
          access_token_expires_at: null,
          refresh_token_expires_at: null,
          scope: null,
          password: passwordHash,
          created_at: timestamp,
          updated_at: timestamp,
        })
        .execute();
      return { id };
    });
  } catch (error) {
    // Two sign-ups for one address at the same moment: the second one runs into the unique column.
    const taken = await db
      .selectFrom("users")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirst();
    if (taken !== undefined) return null;
    throw error;
  }
}

export async function signUp(
  dependencies: SignUpDependencies,
  input: { email: unknown; password: unknown },
): Promise<SignUpOutcome> {
  const { hashPassword, mail, limits, facts, defer } = dependencies;

  // What does not depend on the address comes first: is the sign-up open at all.
  const state = await facts();
  const availability = signUpAvailability(state);
  if (!availability.open)
    return { kind: "unavailable", error: availability.error };

  // The form: a reading of the request, which says nothing about any account.
  const email = canonicalEmail(input.email);
  const issues: SignUpIssue[] = [];
  if (email === null) issues.push({ field: "email", code: "invalid_email" });
  const password = typeof input.password === "string" ? input.password : "";
  const strength = checkPassword(password);
  if (!strength.ok) issues.push({ field: "password", code: strength.code });
  if (email === null || issues.length > 0) return { kind: "invalid", issues };

  // Counted before anything is looked up, so a refusal by the limit is the same for every address.
  for (const permission of [
    await limits.signUp(email),
    ...(availability.verifyByMail ? [await limits.mail(email)] : []),
  ])
    if (!permission.allowed)
      return {
        kind: "rate_limited",
        retryAfterSeconds: permission.retryAfterSeconds,
      };

  // Always hashed, whether or not an account is made: the work of an answer does not show it.
  const passwordHash = await hashPassword(password);
  const next = availability.verifyByMail ? "verify_email" : "sign_in";

  if (!evaluateSignUpRule(state.rule, email).ok)
    return { kind: "accepted", next };
  const account = await createAccount(dependencies, email, passwordHash);
  if (account !== null && availability.verifyByMail)
    defer(
      sendVerificationMail(
        {
          db: dependencies.db,
          mail,
          baseUrl: dependencies.baseUrl,
          now: dependencies.now,
          log: dependencies.log,
        },
        { id: account.id, email },
      ),
    );
  return { kind: "accepted", next };
}
