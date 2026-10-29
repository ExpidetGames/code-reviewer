// SPDX-License-Identifier: LicenseRef-Proprietary

// The sign-up and the email verification on the running server: the real database, Better Auth's password
// hash and session lookup, and the mail sender of the instance. Handlers are built per request, so the
// state they rest on (the rule, the ways to sign in, whether mail can be sent) is read when it matters.
import "server-only";
import { after } from "next/server";
import { getAuth } from "../auth/auth.ts";
import { loadAuthConfig } from "../auth/config.ts";
import { isGithubSignInConfigured } from "../github-config/shared.ts";
import { getDatabase } from "../db/startup.ts";
import { getMailSender } from "../mail/shared.ts";
import { signUpAvailability, type SignUpAvailability } from "./availability.ts";
import { getProductIdentity } from "../product-identity/current.ts";
import { assembleSignUp } from "./assemble.ts";
import { readSignUpFacts } from "./state.ts";
import type { SignUpRouteHandlers } from "./http.ts";

export function getSignUpRouteHandlers(): SignUpRouteHandlers {
  return assembleSignUp({
    db: getDatabase(),
    mail: getMailSender(),
    hashPassword: async (password) =>
      (await getAuth().$context).password.hash(password),
    verifyPassword: async (input) =>
      (await getAuth().$context).password.verify(input),
    githubConfigured: isGithubSignInConfigured,
    // The address the links point to is the configured one, never a request header.
    baseUrl: loadAuthConfig(process.env).baseUrl,
    product: getProductIdentity(),
    async currentUserId(request) {
      try {
        const session = await getAuth().api.getSession({
          headers: request.headers,
        });
        return session?.user.id ?? null;
      } catch {
        return null;
      }
    },
    // Nothing of the account is looked at before the answer is sent (Next.js runs it after the response),
    // so neither its content nor its time tells whether there was one. The work does not throw; the catch
    // is only a net.
    defer: (work) => {
      after(() => work().catch(() => undefined));
    },
  });
}

/** The facts the login page and the pages next to it decide on, read once. */
export function getSignUpFacts() {
  return readSignUpFacts({
    db: getDatabase(),
    mail: getMailSender(),
    githubConfigured: isGithubSignInConfigured,
  });
}

/** Whether the sign-up is open right now, for the pages that offer it. Read when asked, never remembered. */
export async function getSignUpAvailability(): Promise<SignUpAvailability> {
  return signUpAvailability(
    await readSignUpFacts({
      db: getDatabase(),
      mail: getMailSender(),
      githubConfigured: isGithubSignInConfigured,
    }),
  );
}
