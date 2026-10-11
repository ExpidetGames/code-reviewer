// "Would the sign in take this admin?" asked before the setup writes anything. The rules are the ones
// Better Auth applies on sign in (`z.email()` for the address, at most 128 UTF-16 units for the
// password) and the stored hash must verify with Better Auth's own verifier. Other rules of the app
// (the password list) are in input.ts; this is the last line against creating an admin who can never
// sign in, on an instance whose setup is then over.
import { z } from "zod";
import { PASSWORD_MAX_LENGTH } from "../auth/password-policy.ts";

const emailSchema = z.email();

export type PasswordVerifier = (input: {
  hash: string;
  password: string;
}) => Promise<boolean>;

export function createCredentialCheck(verify: PasswordVerifier) {
  return async ({
    email,
    password,
    hash,
  }: {
    email: string;
    password: string;
    hash: string;
  }): Promise<boolean> => {
    if (!emailSchema.safeParse(email).success) return false;
    // Better Auth counts UTF-16 units; the app counts characters. The stricter of the two decides.
    if (password.length > PASSWORD_MAX_LENGTH) return false;
    try {
      return await verify({ hash, password });
    } catch {
      return false;
    }
  };
}
