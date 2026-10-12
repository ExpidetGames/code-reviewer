// SPDX-License-Identifier: Apache-2.0

// Where a verification link lands, and where an account that still has to verify its address is sent.
// Public. With a token (the link) it shows the button that verifies; without one it explains and offers a
// new link. The token is in the address, so the page asks the browser not to pass the address on as a
// referrer. Read at request time, behind a boundary.
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { currentLookup } from "@/auth/session";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { VerifyEmailForm } from "@/signup/ui/verify-email-form";
import { VerifyEmailHelp } from "@/signup/ui/verify-email-help";

export const metadata: Metadata = {
  title: "Confirm your email address",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function VerifyEmailPage({
  searchParams,
}: PageProps<"/verify-email">) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Confirm your email address
          </h1>
        </CardHeader>
        <CardContent>
          <Suspense fallback={null}>
            <VerifyOrExplain searchParams={searchParams} />
          </Suspense>
        </CardContent>
      </Card>
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
  return <VerifyEmailHelp email={email} isAdmin={isAdmin} />;
}
