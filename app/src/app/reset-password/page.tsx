// SPDX-License-Identifier: Apache-2.0

// Where a reset link lands: the form for the new password. Public (the token in the link is the
// credential; src/auth/password-reset-http.ts). The token is in the address, so the page asks the browser
// not to pass the address on as a referrer, and it is read at request time, behind a boundary.
import type { Metadata } from "next";
import { Suspense } from "react";
import { ResetPasswordForm } from "@/auth/ui/reset-password-form";
import { AuthCard } from "@/components/auth-card";

export const metadata: Metadata = {
  title: "Set a new password",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage({
  searchParams,
}: PageProps<"/reset-password">) {
  return (
    <Suspense fallback={<AuthCard title="Set a new password" />}>
      <ResetForm searchParams={searchParams} />
    </Suspense>
  );
}

async function ResetForm({
  searchParams,
}: Pick<PageProps<"/reset-password">, "searchParams">) {
  const { token } = await searchParams;
  return (
    <AuthCard title="Set a new password">
      <ResetPasswordForm token={typeof token === "string" ? token : null} />
    </AuthCard>
  );
}
