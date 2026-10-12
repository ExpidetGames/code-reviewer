// SPDX-License-Identifier: Apache-2.0

// The sign in limiter of the running server: the shared counters in the server's database.
import "server-only";
import {
  effectiveSignInMethods,
  type SignInMethods,
} from "../admin/sign-in-methods.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { createSignInLimiter, type SignInLimiter } from "./sign-in-limit.ts";
import { isGithubSignInConfigured } from "../github-config/shared.ts";

export function getSignInLimiter(): SignInLimiter {
  return createSignInLimiter(createRateLimitsRepository(getDatabase()));
}

/**
 * Which ways to sign in are on right now: what the admin set (Setup, Ways to sign in), and GitHub only
 * where it is configured. Read from the database on every call, never remembered.
 */
export async function getSignInMethods(): Promise<SignInMethods> {
  const stored =
    await createInstanceSettingsRepository(getDatabase()).get(
      "sign_in_methods",
    );
  return effectiveSignInMethods(stored, await isGithubSignInConfigured());
}
