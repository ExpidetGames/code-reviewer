// SPDX-License-Identifier: Apache-2.0

// Puts the sign-up, the resend and the verification together over one database, one mail sender and one set
// of counters. The running server (`shared.ts`) and the integration tests (`src/test-support/signup-
// harness.ts`) both build their handlers here, so a test runs the code that serves requests.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import type { MailSender } from "../mail/sender.ts";
import { createSignUpRouteHandlers } from "./http.ts";
import { createSignUpLimits } from "./limits.ts";
import { resendVerification } from "./resend.ts";
import { signUp } from "./sign-up.ts";
import { readSignUpFacts } from "./state.ts";
import {
  completeVerification,
  type VerifyPassword,
} from "./verification-tokens.ts";

export type AssembleSignUpOptions = {
  db: Kysely<Database>;
  mail: MailSender;
  /** Better Auth's password hash (`context.password.hash`). */
  hashPassword: (password: string) => Promise<string>;
  /** Better Auth's password check (`context.password.verify`). */
  verifyPassword: VerifyPassword;
  githubConfigured: () => boolean | Promise<boolean>;
  /** The configured public address of the app. */
  baseUrl: string;
  currentUserId: (request: Request) => Promise<string | null>;
  /** Runs work after the answer is sent (Next's `after()` on the server). */
  defer: (work: () => Promise<void>) => void;
  now?: () => Date;
  newId?: () => string;
  log?: (message: string) => void;
};

export function assembleSignUp(options: AssembleSignUpOptions) {
  const { db, mail, now } = options;
  const limits = createSignUpLimits(createRateLimitsRepository(db, now), now);
  const facts = () =>
    readSignUpFacts({ db, mail, githubConfigured: options.githubConfigured });
  const common = {
    db,
    mail,
    limits,
    baseUrl: options.baseUrl,
    defer: options.defer,
    now,
    log: options.log,
  };
  return createSignUpRouteHandlers({
    signUp: (input) =>
      signUp(
        {
          ...common,
          hashPassword: options.hashPassword,
          facts,
          newId: options.newId,
        },
        input,
      ),
    resend: (email) => resendVerification(common, email),
    currentUserId: options.currentUserId,
    database: db,
    limits,
    verify: (token, password) =>
      completeVerification(db, token, password, {
        verifyPassword: options.verifyPassword,
        now,
      }),
    log: options.log,
  });
}
