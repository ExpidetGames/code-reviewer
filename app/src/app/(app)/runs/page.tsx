import type { Metadata } from "next";
import { requireUser } from "@/auth/session";
import { EmptyState } from "@/ui/empty-state";
import { PageHeader } from "@/ui/page-header";

export const metadata: Metadata = { title: "Runs" };

// A placeholder: the list of review runs comes with the runs tickets.
export default async function RunsPage() {
  await requireUser();
  return (
    <>
      <PageHeader
        title="Runs"
        description="Every review Code Reviewer has started."
      />
      <EmptyState title="No runs yet">
        Reviews of your pull requests will appear here.
      </EmptyState>
    </>
  );
}
