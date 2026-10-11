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
        {/* Keyed on the saved values, so the form starts again from the server's data after a save. */}
        <MailForm key={JSON.stringify(settings.smtp)} settings={settings} />
      </section>
      <section className="settings-section">
        <TestMailPanel
          key={JSON.stringify(settings.smtp)}
          configured={settings.smtp.value !== null}
          adminEmail={user.email}
        />
      </section>
    </>
  );
}
