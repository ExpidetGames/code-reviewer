// Setup: the tenancy, the sign-up rule and the ways to sign in. Instance admin only.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import { SignInMethodsForm } from "@/admin/ui/sign-in-form";
import { SignUpRuleForm } from "@/admin/ui/sign-up-form";
import { TenancyForm } from "@/admin/ui/tenancy-form";
import { PageHeader } from "@/ui/page-header";

export const metadata: Metadata = { title: "Setup · Admin" };

export default async function AdminSetupPage() {
  await requireAdmin();
  const settings = await getAdminService().readSettings();
  // Keyed on the saved values, so a form starts again from the server's data after a save.
  const key = JSON.stringify([
    settings.tenancy,
    settings.signUpRule,
    settings.signInMethods,
    settings.workspaceCount,
    settings.githubConfigured,
    settings.mailConfigured,
  ]);
  return (
    <>
      <PageHeader
        title="Setup"
        description="Who can use this instance and how they sign in."
      />
      <section className="settings-section">
        <TenancyForm key={`tenancy-${key}`} settings={settings} />
      </section>
      <section className="settings-section">
        <SignUpRuleForm key={`rule-${key}`} settings={settings} />
      </section>
      <section className="settings-section">
        <SignInMethodsForm key={`methods-${key}`} settings={settings} />
      </section>
    </>
  );
}
