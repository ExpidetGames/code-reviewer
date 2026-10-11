// SPDX-License-Identifier: Apache-2.0

"use server";
// The buttons of the app: "Sign in with GitHub", the email and password form, and "Sign out". They
// are forms that post to these server actions, so they work without client JavaScript.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAccessGates } from "./access-gates-runtime.ts";
import { getAuth } from "./auth.ts";
import { pathAfterPasswordSignIn } from "./post-sign-in.ts";
import { signInWithPasswordChecked } from "./password-sign-in.ts";
import { getSignInLimiter, getSignInMethods } from "./sign-in-runtime.ts";

export async function signInWithGithub(): Promise<void> {
  // A way the admin switched off is off here too, not only on the login page. (redirect() works by
  // throwing, so it stays outside the try block.)
  if (!(await getSignInMethods()).github)
    redirect("/login?error=sign_in_method_disabled");
  let githubUrl: string | undefined;
  try {
    const result = await getAuth().api.signInSocial({
      body: { provider: "github", callbackURL: "/" },
      headers: await headers(),
    });
    githubUrl = result.url;
  } catch (error) {
    console.error(
      `[auth] could not start the GitHub sign in: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // redirect() works by throwing, so it stays outside the try block.
  redirect(githubUrl ?? "/login?error=sign_in_unavailable");
}

export async function signOut(): Promise<void> {
  await getAuth().api.signOut({ headers: await headers() });
  redirect("/login");
}

/**
 * The email and password form of the login page. The attempts are counted per email address and for
 * the whole instance (sign-in-limit.ts), and a wrong email address and a wrong password get the same
 * answer, so the page does not tell which email addresses have an account.
 */
export async function signInWithPassword(formData: FormData): Promise<void> {
  if (!(await getSignInMethods()).emailPassword)
    redirect("/login?error=sign_in_method_disabled");
  const email = formData.get("email");
  const password = formData.get("password");
  let error: string | null = "invalid_credentials";
  if (typeof email === "string" && typeof password === "string") {
    const requestHeaders = await headers();
    const outcome = await signInWithPasswordChecked(
      {
        limiter: getSignInLimiter(),
        signIn: (address, secret) =>
          getAuth().api.signInEmail({
            body: { email: address.trim(), password: secret },
            headers: requestHeaders,
          }),
      },
      email,
      password,
    );
    error = outcome.kind === "ok" ? null : outcome.kind;
  }
  // redirect() works by throwing, so it stays outside the try block.
  redirect(
    error === null
      ? await landingAfterSignIn(email as string)
      : `/login?error=${error}`,
  );
}

/** The page a person who just signed in with this address lands on (post-sign-in.ts). */
async function landingAfterSignIn(email: string): Promise<string> {
  try {
    const context = await getAuth().$context;
    const found = await context.internalAdapter.findUserByEmail(
      email.trim().toLowerCase(),
    );
    if (found === null) return "/";
    return await pathAfterPasswordSignIn(
      {
        id: found.user.id,
        emailVerified: found.user.emailVerified,
        // The adapter's type does not list our additional fields; the value is there.
        isInstanceAdmin:
          (found.user as { isInstanceAdmin?: unknown }).isInstanceAdmin ===
          true,
      },
      getAccessGates(),
    );
  } catch {
    // The proxy decides on the next request anyway.
    return "/";
  }
}
