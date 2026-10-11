"use server";
// The buttons of the app: "Sign in with GitHub", the email and password form, and "Sign out". They
// are forms that post to these server actions, so they work without client JavaScript.
import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./auth.ts";

export async function signInWithGithub(): Promise<void> {
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
 * The email and password form of the login page. A wrong email address and a wrong password get the
 * same answer, so the page does not tell which email addresses have an account.
 */
export async function signInWithPassword(formData: FormData): Promise<void> {
  const email = formData.get("email");
  const password = formData.get("password");
  let error: string | null = null;
  if (typeof email !== "string" || typeof password !== "string") {
    error = "invalid_credentials";
  } else {
    try {
      await getAuth().api.signInEmail({
        body: { email: email.trim(), password },
        headers: await headers(),
      });
    } catch (cause) {
      error =
        cause instanceof APIError && cause.statusCode === 429
          ? "rate_limited"
          : "invalid_credentials";
      // Never the reason: it may quote the request.
      console.error(
        `[auth] email sign in refused (${error === "rate_limited" ? "rate limited" : "not accepted"}).`,
      );
    }
  }
  // redirect() works by throwing, so it stays outside the try block.
  redirect(error === null ? "/" : `/login?error=${error}`);
}
