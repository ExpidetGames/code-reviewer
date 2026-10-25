// SPDX-License-Identifier: LicenseRef-Proprietary

// The page without a token on it: a signed out visitor who opens it, or a signed in account that still
// has to confirm its address. One line says what to do; the longer explanation (how long a link lives,
// what to do when it does not accept the password) is behind a disclosure, and the form asks for a new
// link. The instance admin gets the one link to the portal that always works for them. A signed in
// session keeps a way out: signing out is the one control this public page has for it.
import Link from "next/link";
import { Button } from "@/components/button";
import { HelpDisclosure } from "@/components/help-disclosure";
import { ResendForm } from "./resend-form.tsx";

export function VerifyEmailHelp({
  email,
  isAdmin,
  signOutAction,
}: {
  /** The signed in address this page is about, or null when nobody is signed in. */
  email: string | null;
  /** Whether the person runs this instance. */
  isAdmin: boolean;
  /** The server action that ends the session; the way out for the signed in person. */
  signOutAction: () => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground text-pretty">
        Open the confirmation link in the email we sent you and enter the
        password you chose when you signed up.
      </p>
      <ResendForm initialEmail={email ?? ""} />
      <HelpDisclosure label="How confirmation works">
        The account can be used once the address is confirmed. A link works once
        and for 24 hours. If a link does not accept your password, sign up again
        with the same address and the password you want to use: that sends a
        link of its own.
      </HelpDisclosure>
      {isAdmin ? (
        <p className="text-sm text-muted-foreground">
          You run code-review.com:{" "}
          <Link href="/admin" className="underline underline-offset-4">
            open the admin portal
          </Link>
          .
        </p>
      ) : null}
      {email === null ? (
        <Link
          href="/login"
          className="text-sm text-muted-foreground underline underline-offset-4"
        >
          Back to the sign-in
        </Link>
      ) : (
        <form action={signOutAction} className="self-start">
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      )}
    </div>
  );
}
