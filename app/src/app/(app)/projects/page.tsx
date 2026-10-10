import type { Metadata } from "next";
import { requireUser } from "@/auth/session";
import { EmptyState } from "@/ui/empty-state";
import { PageHeader } from "@/ui/page-header";

export const metadata: Metadata = { title: "Projects" };

// A placeholder: the list of connected repositories comes with the projects tickets.
export default async function ProjectsPage() {
  await requireUser();
  return (
    <>
      <PageHeader
        title="Projects"
        description="The repositories Code Reviewer watches."
      />
      <EmptyState title="No projects yet">
        Repositories you connect will appear here.
      </EmptyState>
    </>
  );
}
