// SPDX-License-Identifier: Apache-2.0

// Mail: the mail server (SMTP) and the test mail. Instance admin only.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import { MailForm } from "@/admin/ui/mail-form";
import { TestMailPanel } from "@/admin/ui/test-mail-panel";
import { PageHeader } from "@/ui/page-header";

export const metadata: Metadata = { title: "Mail · Admin" };

export default async function AdminMailPage() {
  const user = await requireAdmin();
  const settings = await getAdminService().readSettings();
  return (
    <>
      <PageHeader
        title="Mail"
        description="The mail server of this instance."
      />
      <section className="settings-section">
        {/* Not keyed on the saved values: the form keeps what was typed (which is what was saved) and its
            "Saved." sentence while the page's data is refreshed; it clears itself after a removal. */}
        <MailForm settings={settings} />
      </section>
      <section className="settings-section">
        <TestMailPanel
          configured={settings.smtp.value !== null}
          adminEmail={user.email}
        />
      </section>
    </>
  );
}
