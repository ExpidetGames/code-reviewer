// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { currentLookup } from "@/auth/session";
import { loginPath } from "@/auth/session-user";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { loadAccountView } from "@/workspaces/account-view";
import { CreateWorkspaceForm } from "@/workspaces/ui/create-workspace-form";

export const metadata: Metadata = { title: "Create a workspace" };

// Another workspace for a person who has one already, or the first one for a person who has none. Only a
// multi-tenant instance lets people create workspaces; on a single-tenant instance this page leads back to
// the start page, and the route refuses with `multi_tenant_required` in any case.
export default async function NewWorkspacePage() {
  await connection();
  const lookup = await currentLookup();
  if (lookup.kind !== "user" && lookup.kind !== "no_workspace")
    redirect(loginPath(lookup));
  const view = await loadAccountView(lookup.user.id);
  if (!view.multiTenant) redirect("/");
  return (
    <>
      <PageHeader
        title="Create a workspace"
        description="You become its Owner and can invite people."
      />
      <Card className="mt-6 max-w-xl">
        <CardContent>
          <CreateWorkspaceForm />
        </CardContent>
      </Card>
    </>
  );
}
