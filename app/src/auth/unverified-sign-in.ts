// SPDX-License-Identifier: LicenseRef-Proprietary

// An email and password sign in is refused, with a session never opened, for an account whose address is
// not verified while the instance can send mail (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.5). The instance admin is the exception: the admin signs in and keeps `/admin`, so a problem
// with the mail server can always be repaired (access-gates.ts, access-proxy.ts).
//
// The refusal comes only after the password was right. A wrong password never goes on to Better Auth for a
// second check: for an account that waits for verification the check made here is the only one, and its
// answer is Better Auth's own (401 INVALID_EMAIL_OR_PASSWORD), so every wrong password costs exactly one hash
// whether the address is unknown, verified or waiting, and a measurement of the time says nothing about
// the account. (The right password is answered here too, with 403, so it costs one hash as well.)
/** The `code` of the error Better Auth answers (403) for an unverified address. */
export const EMAIL_NOT_VERIFIED_CODE = "EMAIL_NOT_VERIFIED";

export type UnverifiedSignInDependencies = {
  /** The user with this (lower case) address and whether it has a password to check, or null. */
  findUser: (email: string) => Promise<{
    emailVerified: boolean;
    isInstanceAdmin: boolean;
    passwordHash: string | null;
  } | null>;
  verifyPassword: (input: {
    hash: string;
    password: string;
  }) => Promise<boolean>;
  /** Whether addresses must be verified: the instance can send mail. Asked only when it matters. */
  verificationRequired: () => Promise<boolean>;
};

export type UnverifiedSignInVerdict =
  /** Not this module's business: Better Auth goes on (and checks the password itself, once). */
  | "go_on"
  /** The password is right and the address is not verified: 403 EMAIL_NOT_VERIFIED. */
  | "not_verified"
  /** The account waits for verification and the password is wrong: Better Auth's own 401, no second hash. */
  | "wrong_password";

export async function judgeUnverifiedSignIn(
  {
    findUser,
    verifyPassword,
    verificationRequired,
  }: UnverifiedSignInDependencies,
  email: string,
  password: string,
): Promise<UnverifiedSignInVerdict> {
  const user = await findUser(email.toLowerCase());
  if (user === null || user.passwordHash === null) return "go_on";
  if (user.emailVerified || user.isInstanceAdmin) return "go_on";
  if (!(await verificationRequired())) return "go_on";
  return (await verifyPassword({ hash: user.passwordHash, password }))
    ? "not_verified"
    : "wrong_password";
}
