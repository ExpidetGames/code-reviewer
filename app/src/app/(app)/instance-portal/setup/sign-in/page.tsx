// SPDX-License-Identifier: LicenseRef-Proprietary

// Setup → Sign-in (#181): the ways to sign in, one form. Instance admin only.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import { SignInMethodsForm } from "@/admin/ui/sign-in-form";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Sign-in · Admin" };

export default async function AdminSetupSignInPage() {
  await requireAdmin();
  const settings = await getAdminService().readSettings();
  return (
    <>
      <PageHeader
        title="Sign-in"
        breadcrumb={
          <Breadcrumbs
            items={[
              { label: "Admin", href: "/admin" },
              { label: "Setup", href: "/admin/setup/instance" },
              { label: "Sign-in" },
            ]}
          />
        }
      />
      <div className="pt-6">
        <SignInMethodsForm settings={settings} />
      </div>
    </>
  );
}
