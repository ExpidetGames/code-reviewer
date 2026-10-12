// SPDX-License-Identifier: Apache-2.0

import { connection } from "next/server";
import Link from "next/link";
import { Suspense } from "react";
import { signInWithGithub, signInWithPassword } from "@/auth/actions";
import { loginErrorMessage } from "@/auth/login-errors";
import { passwordResetAvailable } from "@/auth/password-reset-request";
import { signUpAvailability } from "@/signup/availability";
import { getSignUpFacts } from "@/signup/shared";
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
  // The state of the instance, read once: the ways to sign in that are on, the sign-up rule, whether mail
  // can be sent.
  const facts = await getSignUpFacts();
  const methods = facts.signInMethods;
  // The link to the sign-up is offered while the sign-up is open.
  const signUp = methods.emailPassword
    ? signUpAvailability(facts)
    : { open: false as const };
  // The link to "forgot your password" is offered while the instance can send the mail.
  const canReset = passwordResetAvailable(facts);
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
          {canReset ? (
            <p className="muted small">
              <Link href="/forgot-password">Forgot your password?</Link>
            </p>
          ) : null}
        </form>
      ) : null}
      {signUp.open ? (
        <p className="muted small">
          No account yet? <Link href="/sign-up">Create one</Link>.
        </p>
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
