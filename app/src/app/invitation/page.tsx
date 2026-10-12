// SPDX-License-Identifier: Apache-2.0

// Where an invitation link lands. Public: whoever holds the link opens it, signed in or not. The link is the
// credential of the page and the page only shows what the invitation is about (the workspace, the role, the
// address it is bound to); nothing is accepted by opening it. Accepting is the button, a POST that needs a
// session, so a mail scanner or a link preview that opens every link of a message cannot use the invitation
// up. A link that is not an invitation (unknown, damaged) gets one generic answer; a revoked, used or expired
// one says so. The token is in the address, so the page asks the browser not to send its address on as a
// referrer (a header, set in next.config.ts, and the same in the metadata).
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { signOut } from "@/auth/actions";
import { currentLookup } from "@/auth/session";
import { Button } from "@/ui/button";
import { canonicalEmail } from "@/signup/rule";
import { getInvitationService } from "@/workspaces/shared";
import { AcceptInvitation } from "@/workspaces/ui/accept-invitation";
import { describeInvitationState } from "@/workspaces/ui/messages";
import { ROLE_LABEL } from "@/workspaces/ui/role-copy";

export const metadata: Metadata = {
  title: "Invitation",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function InvitationPage({
  searchParams,
}: PageProps<"/invitation">) {
  return (
    <main className="auth-page">
      <div className="card auth-card">
        <h1>Invitation</h1>
        <Suspense fallback={null}>
          <InvitationContent searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
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
      <>
        <p role="alert" className="alert alert-warning">
          {describeInvitationState(result.error)}
        </p>
        <Link href="/">Go to the start page</Link>
      </>
    );
  const { workspaceName, role, email } = result.preview;
  const link = `invitation=${encodeURIComponent(String(token))}`;

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
    <>
      <p>
        You are invited to join <strong>{workspaceName}</strong> at Code
        Reviewer as {role === "admin" ? "an" : "a"} {ROLE_LABEL[role]}. The
        invitation is for <strong>{email}</strong>.
      </p>
      {signedInAs === null ? (
        <>
          <p>
            Sign in, or create an account, with that address to accept. The
            invitation works once.
          </p>
          <Link href={`/login?${link}`} className="btn btn-primary btn-block">
            Sign in
          </Link>
          <Link
            href={`/sign-up?${link}`}
            className="btn btn-secondary btn-block"
          >
            Create an account
          </Link>
        </>
      ) : canonicalEmail(signedInAs) === email ? (
        <AcceptInvitation
          which={{ token: String(token) }}
          workspaceName={workspaceName}
        />
      ) : (
        <>
          <p role="alert" className="alert alert-warning">
            You are signed in as another address than the one this invitation is
            for. Sign out and sign in with {email}.
          </p>
          <form action={signOut}>
            <Button type="submit" variant="secondary" className="btn-block">
              Sign out
            </Button>
          </form>
        </>
      )}
    </>
  );
}
