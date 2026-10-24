// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// What every card of the billing page does when a button is pressed (#504): one call to the data route, a sentence for the
// result in a polite live region, and a refresh of the page's data after a success. Nothing throws; a failure is a stable code
// that `billing-messages.ts` turns into a sentence.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { StatusRegion } from "../../components/status-region.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import type { RequestIssue } from "../../ui/json-request.ts";

export type BillingOutcome =
  | { kind: "ok"; text: string }
  | { kind: "failed"; text: string; issues: RequestIssue[]; missing: string[] }
  | null;

/** The items the server named when it refused to switch billing on (`billing_not_ready`), if the answer carries them. */
export function missingOf(details: Record<string, unknown> | undefined) {
  const missing = details?.missing;
  return Array.isArray(missing)
    ? missing.filter((item): item is string => typeof item === "string")
    : [];
}

/** One action at a time per card: the name of the one that runs, and `run`, which shows the outcome and refreshes. */
export function useBillingRun() {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BillingOutcome>(null);

  async function run(
    name: string,
    work: () => Promise<BillingOutcome>,
  ): Promise<BillingOutcome> {
    setPending(name);
    setOutcome(null);
    const result = await work();
    setPending(null);
    setOutcome(result);
    // The page's data comes from the server: a refresh shows the new status, the counts and "last changed".
    if (result?.kind === "ok") router.refresh();
    return result;
  }

  return { pending, outcome, run, clear: () => setOutcome(null) };
}

/** The sentence under a button: green for done, red for refused. */
export function OutcomeNote({
  outcome,
  describeMissing,
}: {
  outcome: BillingOutcome;
  describeMissing?: (item: string) => string;
}) {
  return (
    <StatusRegion>
      {outcome === null ? null : (
        <Alert
          variant={outcome.kind === "ok" ? "success" : "destructive"}
          role="note"
        >
          <AlertDescription>
            {outcome.text}
            {outcome.kind === "failed" &&
            outcome.missing.length > 0 &&
            describeMissing !== undefined ? (
              <ul className="mt-2 list-disc pl-5">
                {outcome.missing.map((item) => (
                  <li key={item}>{describeMissing(item)}</li>
                ))}
              </ul>
            ) : null}
          </AlertDescription>
        </Alert>
      )}
    </StatusRegion>
  );
}
