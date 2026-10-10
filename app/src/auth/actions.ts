"use server";
// The two buttons of the app: "Sign in with GitHub" and "Sign out". They are forms that post to
// these server actions, so they work without client JavaScript.
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
