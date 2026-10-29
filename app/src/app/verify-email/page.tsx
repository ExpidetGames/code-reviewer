// SPDX-License-Identifier: LicenseRef-Proprietary

// Where a verification link lands, and where an account that still has to verify its address is sent.
// Public. With a token (the link) it shows the button that verifies; without one it explains and offers a
// new link. The token is in the address, so the page asks the browser not to pass the address on as a
// referrer. Read at request time, behind a boundary. The frame is the shared AuthCard (#170).
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { signOut } from "@/auth/actions";
import { currentLookup } from "@/auth/session";
import { AuthCard } from "@/components/auth-card";
import { VerifyEmailForm } from "@/signup/ui/verify-email-form";
import { VerifyEmailHelp } from "@/signup/ui/verify-email-help";
import { getProductIdentity } from "@/product-identity/current";

export const metadata: Metadata = {
  title: "Confirm your email address",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

const TITLE = "Confirm your email address";

export default function VerifyEmailPage({
  searchParams,
}: PageProps<"/verify-email">) {
  return (
    <Suspense
      fallback={<AuthCard product={getProductIdentity()} title={TITLE} />}
    >
      <VerifyOrExplain searchParams={searchParams} />
    </Suspense>
  );
}

async function VerifyOrExplain({
  searchParams,
}: Pick<PageProps<"/verify-email">, "searchParams">) {
  const { token } = await searchParams;
  if (typeof token === "string")
    return (
      <AuthCard product={getProductIdentity()} title={TITLE}>
        <VerifyEmailForm token={token} />
      </AuthCard>
    );
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
    <AuthCard product={getProductIdentity()} title={TITLE}>
      <VerifyEmailHelp
        product={getProductIdentity()}
        email={email}
        isAdmin={isAdmin}
        signOutAction={signOut}
      />
    </AuthCard>
  );
}
