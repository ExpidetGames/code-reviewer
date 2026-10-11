// SPDX-License-Identifier: Apache-2.0

// Where a verification link lands, and where an account that still has to verify its address is sent.
// Public. With a token (the link) it shows the button that verifies; without one it explains and offers a
// new link. The token is in the address, so the page asks the browser not to pass the address on as a
// referrer. Read at request time, behind a boundary.
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { signOut } from "@/auth/actions";
import { currentLookup } from "@/auth/session";
import { Button } from "@/ui/button";
import { ResendForm } from "@/signup/ui/resend-form";
import { VerifyEmailForm } from "@/signup/ui/verify-email-form";

export const metadata: Metadata = {
  title: "Confirm your email address",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function VerifyEmailPage({
  searchParams,
}: PageProps<"/verify-email">) {
  return (
    <main className="auth-page">
      <div className="card auth-card">
        <h1>Confirm your email address</h1>
        <Suspense fallback={null}>
          <VerifyOrExplain searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}

async function VerifyOrExplain({
  searchParams,
}: Pick<PageProps<"/verify-email">, "searchParams">) {
  const { token } = await searchParams;
  if (typeof token === "string") return <VerifyEmailForm token={token} />;
  await connection();

  // Somebody who is signed in but still has to verify the address is sent here by the app.
  let email: string | null = null;
  let isAdmin = false;
  try {
    const lookup = await currentLookup();
    if (lookup.kind === "unverified") {
      email = lookup.user.email;
      isAdmin = lookup.user.isInstanceAdmin;
    }
  } catch {
    // The page works without knowing who is asking.
  }
  return (
    <>
      <p>
        Open the link in the email we sent to the address you signed up with.
        The account can be used once the address is confirmed. A link works once
        and for 24 hours.
      </p>
      <ResendForm initialEmail={email ?? ""} />
      {isAdmin ? (
        <p className="muted small">
          You are the admin of this instance, so you can still{" "}
          <Link href="/admin">open the admin portal</Link> to check the mail
          settings.
        </p>
      ) : null}
      {email === null ? (
        <Link href="/login">Back to the sign-in</Link>
      ) : (
        <form action={signOut}>
          <Button type="submit" variant="ghost" className="btn-block">
            Sign out
          </Button>
        </form>
      )}
    </>
  );
}
