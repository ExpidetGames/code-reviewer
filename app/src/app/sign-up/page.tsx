// SPDX-License-Identifier: LicenseRef-Proprietary

// Where a visitor creates an account with an email address and a password. Public. Whether the sign-up
// is open is the state of the instance (the rule, the mail server, the ways to sign in), read at request
// time behind a boundary. What the page says does not depend on any address. One form, one success card,
// one link back to the sign-in (#170).
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { invitationTokenOf, pathCarrying } from "@/auth/invitation-return";
import { AuthCard } from "@/components/auth-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getSignUpAvailability } from "@/signup/shared";
import { describeSignUpFailure } from "@/signup/ui/messages";
import { SignUpForm } from "@/signup/ui/sign-up-form";
import { getProductIdentity } from "@/product-identity/current";

export const metadata: Metadata = { title: "Create your account" };

const TITLE = "Create your account";

export default function SignUpPage({ searchParams }: PageProps<"/sign-up">) {
  return (
    <Suspense
      fallback={<AuthCard product={getProductIdentity()} title={TITLE} />}
    >
      <SignUpOrNotice searchParams={searchParams} />
    </Suspense>
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
      <AuthCard product={getProductIdentity()} title={TITLE}>
        <Alert variant="warning">
          <AlertDescription>
            {describeSignUpFailure(getProductIdentity(), availability.error)}
          </AlertDescription>
        </Alert>
        <Link className="text-sm underline underline-offset-4" href={signIn}>
          Back to sign in
        </Link>
      </AuthCard>
    );
  return (
    <AuthCard product={getProductIdentity()} title={TITLE}>
      <SignUpForm signInPath={signIn} />
    </AuthCard>
  );
}
