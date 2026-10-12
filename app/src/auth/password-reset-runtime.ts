// SPDX-License-Identifier: Apache-2.0

// The password reset on the running server: the real database and Better Auth's password hash.
import "server-only";
import { after } from "next/server";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { getMailSender } from "../mail/shared.ts";
import { createSignUpLimits } from "../signup/limits.ts";
import { getSignUpFacts } from "../signup/shared.ts";
import { getAuth } from "./auth.ts";
import { loadAuthConfig } from "./config.ts";
import { completePasswordReset, isKnownResetToken } from "./password-reset.ts";
import { createPasswordResetHandler } from "./password-reset-http.ts";
import {
  passwordResetAvailable,
  requestPasswordReset,
} from "./password-reset-request.ts";
import { createPasswordResetRequestHandler } from "./password-reset-request-http.ts";
import { getSignInMethods } from "./sign-in-runtime.ts";

export function getPasswordResetHandler() {
  const db = getDatabase();
  return createPasswordResetHandler({
    rateLimits: createRateLimitsRepository(db),
    isKnownToken: (token) => isKnownResetToken(db, token),
    async complete(input) {
      const context = await getAuth().$context;
      return completePasswordReset(
        { db, hashPassword: context.password.hash },
        input,
      );
    },
  });
}

/** Whether the reset by mail is offered right now: a mail server, and email with password sign-in on. */
export async function getPasswordResetAvailable(): Promise<boolean> {
  return passwordResetAvailable(await getSignUpFacts());
}

/** `POST /api/password-reset/request`: asks for a reset link by mail. */
export function getPasswordResetRequestHandler() {
  const db = getDatabase();
  return createPasswordResetRequestHandler({
    request: (email) =>
      requestPasswordReset(
        {
          db,
          mail: getMailSender(),
          limits: createSignUpLimits(createRateLimitsRepository(db)),
          emailPasswordOn: async () => (await getSignInMethods()).emailPassword,
          // The address in the link is the configured one, never a request header.
          baseUrl: loadAuthConfig(process.env).baseUrl,
          // Nothing of the account is looked at before the answer is sent (Next.js runs it after the
          // response), so neither its content nor its time tells whether there was one. The work does not
          // throw; the catch is only a net.
          defer: (work) => {
            after(() => work().catch(() => undefined));
          },
        },
        email,
      ),
  });
}
