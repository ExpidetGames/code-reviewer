// SPDX-License-Identifier: Apache-2.0

// The first-run setup: the code form, and once the code was accepted, the wizard. While the instance
// is not set up the proxy shows this page in place of every other page (src/setup/gate.ts); once it
// is, the proxy answers 404 for it and this page does the same as a second line. The frame is the
// shared `AuthCard` (#185): the setup brings its own `h1` per step, so the card renders none.
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AuthCard } from "@/components/auth-card";
import { PageLoading } from "@/components/page-loading";
import { SETUP_SESSION_COOKIE } from "@/setup/setup-session";
import { isServerless } from "@/runtime/mode";
import { checkCurrentSetupSession, getSetupStateReader } from "@/setup/shared";
import { CodeForm } from "@/setup/ui/code-form";
import { Wizard } from "@/setup/ui/wizard";

export const metadata: Metadata = {
  title: "Set up",
  robots: { index: false, follow: false },
};

export default function SetupPage() {
  return (
    <AuthCard>
      {/* Everything here depends on the request (the cookie) and the database. */}
      <Suspense fallback={<PageLoading label="Loading the setup" />}>
        <SetupContent />
      </Suspense>
    </AuthCard>
  );
}

async function SetupContent() {
  await connection();
  const state = await getSetupStateReader()();
  if (state.kind === "completed") notFound();

  const session = await checkCurrentSetupSession(
    (await cookies()).get(SETUP_SESSION_COOKIE)?.value,
  );
  // Where the code comes from decides the instructions: the log of a server, `pnpm setup-code` otherwise.
  const hosting = isServerless() ? "serverless" : "server";
  const existingInstallation = state.kind === "existing";
  if (session.ok)
    return (
      <Wizard existingInstallation={existingInstallation} hosting={hosting} />
    );
  return (
    <CodeForm existingInstallation={existingInstallation} hosting={hosting} />
  );
}
