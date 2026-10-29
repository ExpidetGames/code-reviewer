// SPDX-License-Identifier: LicenseRef-Proprietary

// Mail: the mail server (SMTP) and the test mail. Instance admin only. The cards and the danger zone
// (#184); the page itself just stacks them.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import { MailForm } from "@/admin/ui/mail-form";
import { TestMailPanel } from "@/admin/ui/test-mail-panel";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";
import { CODE_REVIEW_COM } from "@/product-identity/code-review-com";

export const metadata: Metadata = { title: "Mail · Admin" };

export default async function AdminMailPage() {
  const user = await requireAdmin();
  const settings = await getAdminService().readSettings();
  return (
    <>
      <PageHeader
        title="Mail"
        breadcrumb={
          <Breadcrumbs
            items={[{ label: "Admin", href: "/admin" }, { label: "Mail" }]}
          />
        }
      />
      <div className="flex max-w-[44rem] flex-col gap-6 pt-6">
        {/* Not keyed on the saved values: the form keeps what was typed (which is what was saved) and its
            "Saved." sentence while the page's data is refreshed; it clears itself after a removal. The
            test mail card is a child so the danger zone stays the last card. */}
        <MailForm product={CODE_REVIEW_COM} settings={settings}>
          <TestMailPanel
            configured={settings.smtp.value !== null}
            adminEmail={user.email}
          />
        </MailForm>
      </div>
    </>
  );
}
