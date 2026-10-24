// SPDX-License-Identifier: LicenseRef-Proprietary

// What the page of a valid invitation shows: who is invited and where to, exactly once, and the one
// action that fits who is looking. Opening the link accepts nothing; only the button behind a session
// does. Both the workspace name and the invited address come from the database and are rendered as
// text, never markup.
import Link from "next/link";
import { Button } from "@/components/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ProductName } from "@/components/brand";
import { canonicalEmail } from "../../signup/rule.ts";
import type { WorkspaceRole } from "../roles.ts";
import { AcceptInvitation } from "./accept-invitation.tsx";
import type { AccountApi } from "./api.ts";
import { ROLE_LABEL } from "./role-copy.ts";

export function InvitationView({
  token,
  workspaceName,
  role,
  email,
  signedInAs,
  signOutAction,
  api,
  open,
}: {
  token: string;
  workspaceName: string;
  role: WorkspaceRole;
  email: string;
  /** The signed in address, or null when nobody is signed in. */
  signedInAs: string | null;
  /** The server action that ends the session (the mismatch branch). */
  signOutAction: () => Promise<void>;
  /** Only tests pass these two. */
  api?: AccountApi;
  open?: (path: string) => void;
}) {
  const withApi = {
    ...(api === undefined ? {} : { api }),
    ...(open === undefined ? {} : { open }),
  };
  const link = `invitation=${encodeURIComponent(token)}`;
  const matches = signedInAs !== null && canonicalEmail(signedInAs) === email;

  return (
    <>
      <p className="text-sm text-muted-foreground text-pretty">
        You are invited to join <strong>{workspaceName}</strong> at{" "}
        <ProductName /> as {role === "admin" ? "an" : "a"} {ROLE_LABEL[role]}.
        The invitation is for <strong>{email}</strong>.
      </p>
      {signedInAs === null ? (
        <div className="flex flex-col gap-3">
          <Button asChild className="w-full">
            <Link href={`/login?${link}`}>Sign in</Link>
          </Button>
          <Button asChild variant="secondary" className="w-full">
            <Link href={`/sign-up?${link}`}>Create an account</Link>
          </Button>
        </div>
      ) : matches ? (
        <AcceptInvitation
          which={{ token }}
          workspaceName={workspaceName}
          {...withApi}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <Alert variant="warning">
            <AlertDescription>
              You are signed in with a different address than this invitation is
              for. Sign out and sign in with the invited address.
            </AlertDescription>
          </Alert>
          <form action={signOutAction}>
            <Button type="submit" variant="secondary" className="w-full">
              Sign out
            </Button>
          </form>
        </div>
      )}
    </>
  );
}
