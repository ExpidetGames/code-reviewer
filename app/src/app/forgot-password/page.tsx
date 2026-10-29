// SPDX-License-Identifier: LicenseRef-Proprietary

// Where somebody who forgot their password asks for a link by mail. Public. It exists only while the
// instance can send mail and email with password sign-in is on (the state of the instance, read at request
// time behind a boundary); otherwise it is a 404, like the route behind it. What the page says does not
// depend on any address. One field, one button, no intro; the footer link lives inside the boundary (#170).
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getPasswordResetAvailable } from "@/auth/password-reset-runtime";
import { ForgotPasswordForm } from "@/auth/ui/forgot-password-form";
import { AuthCard } from "@/components/auth-card";
import { CODE_REVIEW_COM } from "@/product-identity/code-review-com";

export const metadata: Metadata = {
  title: "Reset your password",
  robots: { index: false, follow: false },
};

const TITLE = "Reset your password";

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<AuthCard product={CODE_REVIEW_COM} title={TITLE} />}>
      <FormOrNotFound />
    </Suspense>
  );
}

async function FormOrNotFound() {
  await connection();
  if (!(await getPasswordResetAvailable())) notFound();
  return (
    <AuthCard product={CODE_REVIEW_COM} title={TITLE}>
      <ForgotPasswordForm />
      <Link className="text-sm underline underline-offset-4" href="/login">
        Back to sign in
      </Link>
    </AuthCard>
  );
}
