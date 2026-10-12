// SPDX-License-Identifier: Apache-2.0

"use client";
// The two buttons of a request on the Approvals page: approve (links the installation to the workspace) and deny.
// The route decides again; a page that is out of date gets the refusal in words and is reloaded.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../../ui/button.tsx";
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
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function decide(decision: "approve" | "deny") {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await api.decide(requestId, decision);
    setBusy(false);
    if (!result.ok) setProblem(describeApprovalFailure(result.code));
    // Show what is true now, whatever the answer was.
    router.refresh();
  }

  return (
    <div className="form-actions">
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
      {problem !== null ? (
        <span role="alert" className="field-error">
          {problem}
        </span>
      ) : null}
    </div>
  );
}
