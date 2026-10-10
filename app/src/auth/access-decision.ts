// The vocabulary shared by every place that decides "may this person use the instance": the sign in
// (`sign-in-access.ts`) and the check on each request (`access-policy.ts`). A refusal is the same
// value in both, so the login page needs only one set of codes (`login-errors.ts`).

/**
 * Why somebody was turned away. The login page translates the code to copy.
 * - `not_allowed`: the account is not on the list and not in the organization.
 * - `check_failed`: the organization check could not be made (GitHub unreachable, odd answer).
 * - `sign_in_again`: the stored GitHub token no longer works or lacks the scope; a new sign in
 *   replaces it. Only the check on a request gives this one.
 */
export const ACCESS_DENIAL_REASONS = [
  "not_allowed",
  "check_failed",
  "sign_in_again",
] as const;
export type AccessDenialReason = (typeof ACCESS_DENIAL_REASONS)[number];

export type AccessDenied = { allowed: false; reason: AccessDenialReason };

export type AccessDecision = { allowed: true } | AccessDenied;

export function deny(reason: AccessDenialReason): AccessDenied {
  return { allowed: false, reason };
}

export function isAccessDenialReason(
  value: unknown,
): value is AccessDenialReason {
  return (ACCESS_DENIAL_REASONS as readonly unknown[]).includes(value);
}
