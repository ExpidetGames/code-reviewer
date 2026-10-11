// SPDX-License-Identifier: Apache-2.0

import { connection } from "next/server";
import { Suspense } from "react";
import { signInWithGithub, signInWithPassword } from "@/auth/actions";
import { loginErrorMessage } from "@/auth/login-errors";
import { getSignInMethods } from "@/auth/sign-in-runtime";
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
        {/* The ways to sign in are the admin's setting (Setup, Ways to sign in) and GitHub exists while
            it is configured: both are read at request time, behind a boundary. */}
        <Suspense fallback={null}>
          <SignInForms />
        </Suspense>
      </div>
    </main>
  );
}

async function SignInForms() {
  // Reads the database and the environment at request time (not when the page is built).
  await connection();
  const methods = await getSignInMethods();
  return (
    <>
      {methods.emailPassword ? (
        <form action={signInWithPassword} className="login-form">
          <div className="field">
            <label htmlFor="login-email" className="field-label">
              Email address
            </label>
            <input
              id="login-email"
              name="email"
              type="email"
              autoComplete="username"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="login-password" className="field-label">
              Password
            </label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <Button type="submit" className="btn-block">
            Sign in
          </Button>
        </form>
      ) : null}
      {methods.github ? (
        <form action={signInWithGithub}>
          <Button type="submit" variant="secondary" className="btn-block">
            Sign in with GitHub
          </Button>
        </form>
      ) : null}
    </>
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
