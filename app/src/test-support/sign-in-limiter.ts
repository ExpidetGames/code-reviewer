// SPDX-License-Identifier: LicenseRef-Proprietary

// A sign in limiter that never refuses, for tests that are about something else than the limit.
import { handleAuthRequest } from "../auth/http.ts";
import type { SignInLimiter } from "../auth/sign-in-limit.ts";

export const unlimitedSignIns: SignInLimiter = {
  check: () => Promise.resolve({ allowed: true }),
  succeeded: () => Promise.resolve(),
};

/** `handleAuthRequest` without a limit on the sign in. */
export function handleAuth(
  auth: Parameters<typeof handleAuthRequest>[0],
  request: Request,
): Promise<Response> {
  return handleAuthRequest(auth, request, unlimitedSignIns);
}
