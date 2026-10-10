import { Suspense } from "react";
import { signInWithGithub } from "@/auth/actions";
import { loginErrorMessage } from "@/auth/login-errors";
import { Button } from "@/ui/button";

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="auth-page">
      <div className="card auth-card">
        <h1>Code Reviewer</h1>
        <p className="muted">Sign in to continue.</p>
        {/* The error code is part of the URL, so it is read at request time, behind a boundary. */}
        <Suspense fallback={null}>
          <LoginError searchParams={searchParams} />
        </Suspense>
        <form action={signInWithGithub}>
          <Button type="submit" className="btn-block">
            Sign in with GitHub
          </Button>
        </form>
      </div>
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
  return (
    <p role="alert" className="alert alert-error">
      {message}
    </p>
  );
}
