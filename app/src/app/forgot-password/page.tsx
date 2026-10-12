// SPDX-License-Identifier: Apache-2.0

// Where somebody who forgot their password asks for a link by mail. Public. It exists only while the
// instance can send mail and email with password sign-in is on (the state of the instance, read at request
// time behind a boundary); otherwise it is a 404, like the route behind it. What the page says does not
// depend on any address.
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getPasswordResetAvailable } from "@/auth/password-reset-runtime";
import { ForgotPasswordForm } from "@/auth/ui/forgot-password-form";

export const metadata: Metadata = {
  title: "Forgot your password?",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <main className="auth-page">
      <div className="card auth-card">
        <h1>Forgot your password?</h1>
        <Suspense fallback={null}>
          <FormOrNotFound />
        </Suspense>
        <Link href="/login">Back to the sign-in</Link>
      </div>
    </main>
  );
}

async function FormOrNotFound() {
  await connection();
  if (!(await getPasswordResetAvailable())) notFound();
  return (
    <>
      <p className="muted">
        Enter the email address of your account. If it signs in with a password,
        we send it a link to choose a new one.
      </p>
      <ForgotPasswordForm />
    </>
  );
}
