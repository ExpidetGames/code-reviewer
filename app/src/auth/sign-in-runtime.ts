// The sign in limiter of the running server: the shared counters in the server's database.
import "server-only";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { createSignInLimiter, type SignInLimiter } from "./sign-in-limit.ts";

export function getSignInLimiter(): SignInLimiter {
  return createSignInLimiter(createRateLimitsRepository(getDatabase()));
}
