// SPDX-License-Identifier: Apache-2.0

// Where a visitor creates an account with an email address and a password. Public. Whether the sign-up
// is open is the state of the instance (the rule, the mail server, the ways to sign in), read at request
// time behind a boundary. What the page says does not depend on any address.
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { invitationTokenOf, pathCarrying } from "@/auth/invitation-return";
import { getSignUpAvailability } from "@/signup/shared";
import { describeSignUpFailure } from "@/signup/ui/messages";
import { SignUpForm } from "@/signup/ui/sign-up-form";

export const metadata: Metadata = { title: "Create an account" };

export default function SignUpPage({ searchParams }: PageProps<"/sign-up">) {
  return (
    <main className="auth-page">
      <div className="card auth-card">
        <h1>Create an account</h1>
        <Suspense fallback={null}>
          <SignUpOrNotice searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}

async function SignUpOrNotice({
  searchParams,
}: Pick<PageProps<"/sign-up">, "searchParams">) {
  await connection();
  // The invitation link the person came from, if any: the sign-in they go to next carries it on.
  const invitation = invitationTokenOf((await searchParams).invitation);
  const signIn = pathCarrying("/login", invitation);
  const availability = await getSignUpAvailability();
  if (!availability.open)
    return (
      <>
        <p role="alert" className="alert alert-warning">
          {describeSignUpFailure(availability.error)}
        </p>
        <Link href={signIn}>Back to the sign-in</Link>
      </>
    );
  return (
    <>
      <SignUpForm signInPath={signIn} />
      <Link href={signIn}>Back to the sign-in</Link>
    </>
  );
}
