// SPDX-License-Identifier: Apache-2.0

// Mail: the mail server (SMTP). A placeholder until the mail issue fills it. Instance admin only.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { Placeholder } from "@/admin/ui/placeholder";
import { PageHeader } from "@/ui/page-header";

export const metadata: Metadata = { title: "Mail · Admin" };

export default async function AdminMailPage() {
  await requireAdmin();
  return (
    <>
      <PageHeader
        title="Mail"
        description="The mail server of this instance."
      />
      <Placeholder title="Mail is not set up yet">
        The settings of the mail server (SMTP) will be here. With a mail server
        people can verify their email address, reset a password and get
        invitations by mail.
      </Placeholder>
    </>
  );
}
