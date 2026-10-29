// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The two buttons of a request on the Approvals page: approve (links the installation to the workspace) and deny.
// The route decides again; a page that is out of date gets the refusal in words and is reloaded. A refusal is an
// action result, so it is announced politely (role="status"), not as an assertive alert. Each button names the
// account it decides for, so repeated rows stay distinguishable.
import { useProductIdentity } from "../../product-identity/context.tsx";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../../components/button.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import { browserApprovalsApi, type ApprovalsApi } from "./api.ts";
import { describeApprovalFailure } from "./messages.ts";

export function ApprovalActions({
  requestId,
  accountLogin,
  api = browserApprovalsApi,
}: {
  requestId: string;
  accountLogin: string;
  /** Only tests pass this. */
  api?: ApprovalsApi;
}) {
  const product = useProductIdentity();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function decide(decision: "approve" | "deny") {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await api.decide(requestId, decision);
    setBusy(false);
    if (!result.ok) setProblem(describeApprovalFailure(product, result.code));
    // Show what is true now, whatever the answer was.
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        disabled={busy}
        aria-label={`Approve ${accountLogin}`}
        onClick={() => void decide("approve")}
      >
        Approve
      </Button>
      <Button
        variant="secondary"
        disabled={busy}
        aria-label={`Deny ${accountLogin}`}
        onClick={() => void decide("deny")}
      >
        Deny
      </Button>
      <StatusRegion>
        {problem === null ? null : (
          <span className="text-destructive">{problem}</span>
        )}
      </StatusRegion>
    </div>
  );
}
