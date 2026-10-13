// SPDX-License-Identifier: Apache-2.0

// Setup → Sign-up (#181): who may sign up, one form. A rule that cannot work yet is shown above it
// through the shared attention region, so the notice has one owner (notices.tsx). Instance admin only.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import { SignUpSection } from "@/admin/ui/sign-up-section";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Sign-up · Admin" };

export default async function AdminSetupSignUpPage() {
  await requireAdmin();
  const settings = await getAdminService().readSettings();
  return (
    <>
      <PageHeader
        title="Sign-up"
        breadcrumb={
          <Breadcrumbs
            items={[
              { label: "Admin", href: "/admin" },
              { label: "Setup", href: "/admin/setup/instance" },
              { label: "Sign-up" },
            ]}
          />
        }
      />
      <div className="flex max-w-[44rem] flex-col gap-6 pt-6">
        <SignUpSection settings={settings} />
      </div>
    </>
  );
}
