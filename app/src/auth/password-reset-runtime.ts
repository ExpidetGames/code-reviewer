// SPDX-License-Identifier: Apache-2.0

// The password reset on the running server: the real database and Better Auth's password hash.
import "server-only";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { getAuth } from "./auth.ts";
import { completePasswordReset, isKnownResetToken } from "./password-reset.ts";
import { createPasswordResetHandler } from "./password-reset-http.ts";

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
