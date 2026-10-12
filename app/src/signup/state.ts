// SPDX-License-Identifier: Apache-2.0

// The facts a sign-up decision rests on, read from the database and the mail sender when it matters (never
// remembered): the sign-up rule, which ways to sign in are on, and whether the instance can send mail.
// Nothing saved for the rule reads as a rule that lets nobody in, like the admin portal's view of it.
import type { Kysely } from "kysely";
import {
  effectiveSignInMethods,
  type SignInMethods,
} from "../admin/sign-in-methods.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import type { MailSender } from "../mail/sender.ts";
import { CLOSED_RULE, type SignUpRule } from "./rule.ts";

export type SignUpFacts = {
  rule: SignUpRule;
  /** What is actually on. */
  signInMethods: SignInMethods;
  mailConfigured: boolean;
};

export async function readSignUpFacts({
  db,
  mail,
  githubConfigured,
}: {
  db: Kysely<Database>;
  mail: Pick<MailSender, "isConfigured">;
  /** Whether sign-in with GitHub exists (the admin portal asks the same). */
  githubConfigured: () => boolean | Promise<boolean>;
}): Promise<SignUpFacts> {
  const settings = createInstanceSettingsRepository(db);
  const [rule, methods, mailConfigured] = await Promise.all([
    settings.get("sign_up_rule"),
    settings.get("sign_in_methods"),
    mail.isConfigured(),
  ]);
  return {
    rule: rule ?? CLOSED_RULE,
    signInMethods: effectiveSignInMethods(methods, await githubConfigured()),
    mailConfigured,
  };
}
