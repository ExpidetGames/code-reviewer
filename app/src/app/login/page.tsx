import { Suspense } from "react";
import { signInWithGithub } from "@/auth/actions";
import { loginErrorMessage } from "@/auth/login-errors";

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main>
      <h1>Code Reviewer</h1>
      <p>Sign in to continue.</p>
      {/* The error code is part of the URL, so it is read at request time, behind a boundary. */}
      <Suspense fallback={null}>
        <LoginError searchParams={searchParams} />
      </Suspense>
      <form action={signInWithGithub}>
        <button type="submit">Sign in with GitHub</button>
      </form>
    </main>
  );
}

async function LoginError({
  searchParams,
}: Pick<PageProps<"/login">, "searchParams">) {
  const { error } = await searchParams;
  const message = loginErrorMessage(
    typeof error === "string" ? error : undefined,
  );
  if (!message) return null;
  return <p role="alert">{message}</p>;
}
