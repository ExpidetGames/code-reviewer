// SPDX-License-Identifier: Apache-2.0

// Where a visitor creates an account with an email address and a password. Public. Whether the sign-up
// is open is the state of the instance (the rule, the mail server, the ways to sign in), read at request
// time behind a boundary. What the page says does not depend on any address.
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getSignUpAvailability } from "@/signup/shared";
import { describeSignUpFailure } from "@/signup/ui/messages";
import { SignUpForm } from "@/signup/ui/sign-up-form";

export const metadata: Metadata = { title: "Create an account" };

export default function SignUpPage() {
  return (
    <main className="auth-page">
      <div className="card auth-card">
        <h1>Create an account</h1>
        <Suspense fallback={null}>
          <SignUpOrNotice />
        </Suspense>
        <Link href="/login">Back to the sign-in</Link>
      </div>
    </main>
  );
}

async function SignUpOrNotice() {
  await connection();
  const availability = await getSignUpAvailability();
  if (!availability.open)
    return (
      <p role="alert" className="alert alert-warning">
        {describeSignUpFailure(availability.error)}
      </p>
    );
  return <SignUpForm />;
}
