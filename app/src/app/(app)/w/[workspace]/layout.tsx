// SPDX-License-Identifier: LicenseRef-Proprietary

import { Suspense } from "react";
import { balanceBannerFor } from "@/billing/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { BalanceBanner } from "@/workspace-billing/ui/balance-banner";

// The frame of every page of a workspace: above the page, the balance banner for an Owner and an Admin while billing is on and the
// balance is low, zero or below zero (#506, ADR 0006, D9). A Member and a workspace without billing get nothing. The banner reads the
// session and the balance, so it streams in behind its own <Suspense> boundary and never holds the page back. The workspace is the
// one in the address, for a member only (the page checks again). A layout is not rendered again when the person moves between
// pages of the workspace, so the banner is as fresh as the last full load; the billing page and the return from a payment load it
// again.
export default function WorkspaceLayout({
  children,
  params,
}: LayoutProps<"/w/[workspace]">) {
  return (
    <>
      <Suspense fallback={null}>
        <WorkspaceBalanceBanner params={params} />
      </Suspense>
      {children}
    </>
  );
}

async function WorkspaceBalanceBanner({
  params,
}: {
  params: LayoutProps<"/w/[workspace]">["params"];
}) {
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  const view = await balanceBannerFor(
    { id: workspace.id, slug: workspace.slug },
    role,
  );
  return view === null ? null : <BalanceBanner view={view} />;
}
