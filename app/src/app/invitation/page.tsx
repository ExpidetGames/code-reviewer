// SPDX-License-Identifier: LicenseRef-Proprietary

// Where an invitation link lands. Public: whoever holds the link opens it, signed in or not. The link is the
// credential of the page and the page only shows what the invitation is about (the workspace, the role, the
// address it is bound to); nothing is accepted by opening it. Accepting is the button, a POST that needs a
// session, so a mail scanner or a link preview that opens every link of a message cannot use the invitation
// up. A link that is not an invitation (unknown, damaged) gets one generic answer; a revoked, used or expired
// one says so. The token is in the address, so the page asks the browser not to send its address on as a
// referrer (a header, set in next.config.ts, and the same in the metadata). The frame is the shared AuthCard
// (#170).
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { signOut } from "@/auth/actions";
import { currentLookup } from "@/auth/session";
import { AuthCard } from "@/components/auth-card";
import { Button } from "@/components/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getInvitationService } from "@/workspaces/shared";
import { InvitationView } from "@/workspaces/ui/invitation-view";
import { describeInvitationState } from "@/workspaces/ui/messages";
import { CODE_REVIEW_COM } from "@/product-identity/code-review-com";

export const metadata: Metadata = {
  title: "You have an invitation",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

const TITLE = "You have an invitation";

export default function InvitationPage({
  searchParams,
}: PageProps<"/invitation">) {
  return (
    <Suspense fallback={<AuthCard product={CODE_REVIEW_COM} title={TITLE} />}>
      <InvitationContent searchParams={searchParams} />
    </Suspense>
  );
}

async function InvitationContent({
  searchParams,
}: Pick<PageProps<"/invitation">, "searchParams">) {
  await connection();
  const { token } = await searchParams;
  const result = await getInvitationService().preview(token);
  if (!result.ok)
    return (
      <AuthCard product={CODE_REVIEW_COM} title={TITLE}>
        <Alert variant="warning">
          <AlertDescription>
            {describeInvitationState(result.error)}
          </AlertDescription>
        </Alert>
        <Button asChild className="w-full">
          <Link href="/">Go to the start page</Link>
        </Button>
      </AuthCard>
    );
  const { workspaceName, role, email } = result.preview;

  // Who is looking: the page works without knowing, but a signed in person can accept right here.
  let signedInAs: string | null = null;
  try {
    const lookup = await currentLookup();
    if (
      lookup.kind === "user" ||
      lookup.kind === "no_workspace" ||
      lookup.kind === "unverified"
    )
      signedInAs = lookup.user.email;
  } catch {
    // Treated as not signed in.
  }

  return (
    <AuthCard product={CODE_REVIEW_COM} title={TITLE}>
      <InvitationView
        product={CODE_REVIEW_COM}
        token={String(token)}
        workspaceName={workspaceName}
        role={role}
        email={email}
        signedInAs={signedInAs}
        signOutAction={signOut}
      />
    </AuthCard>
  );
}
