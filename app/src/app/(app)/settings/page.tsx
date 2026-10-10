import type { Metadata } from "next";
import { requireUser } from "@/auth/session";
import { EmptyState } from "@/ui/empty-state";
import { PageHeader } from "@/ui/page-header";

export const metadata: Metadata = { title: "Settings" };

// A placeholder: the settings come with the settings tickets.
export default async function SettingsPage() {
  await requireUser();
  return (
    <>
      <PageHeader title="Settings" description="How Code Reviewer behaves." />
      <EmptyState title="Nothing to configure yet">
        Settings will appear here.
      </EmptyState>
    </>
  );
}
