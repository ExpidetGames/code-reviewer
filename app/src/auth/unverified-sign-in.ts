// SPDX-License-Identifier: Apache-2.0

// An email and password sign in is refused, with a session never opened, for an account whose address is
// not verified while the instance can send mail (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.5). The instance admin is the exception: the admin signs in and keeps `/admin`, so a problem
// with the mail server can always be repaired (access-gates.ts, access-proxy.ts).
//
// The refusal comes only after the password was right. A wrong password, and an address nobody has, are
// answered by Better Auth exactly as before, so the answer never says whether an account exists or waits
// for verification to somebody who does not know the password. The password is checked a second time here
// (Better Auth checks it again when this lets the request through); that costs one more hash, and only for
// an account that is unverified.
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

export async function refusesUnverifiedSignIn(
  {
    findUser,
    verifyPassword,
    verificationRequired,
  }: UnverifiedSignInDependencies,
  email: string,
  password: string,
): Promise<boolean> {
  const user = await findUser(email.toLowerCase());
  if (user === null || user.passwordHash === null) return false;
  if (user.emailVerified || user.isInstanceAdmin) return false;
  if (!(await verificationRequired())) return false;
  return verifyPassword({ hash: user.passwordHash, password });
}
