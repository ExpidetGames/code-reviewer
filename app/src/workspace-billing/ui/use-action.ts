// SPDX-License-Identifier: Apache-2.0

"use client";
// What every card of the billing page does when a button is pressed (#505): one call to a route of the workspace, one sentence for
// the result, and a refresh of the page's data after a success, because the balance, the pending payments and the journal come
// from the server. Nothing throws; a failure is a stable code that `messages.ts` turns into a sentence.
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { RequestIssue } from "../../ui/json-request.ts";

export type Outcome =
  | { kind: "ok"; text: string }
  | { kind: "failed"; text: string; issues: RequestIssue[] };

export function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  /** Runs one action. `refresh` asks the server for the page's data again after a success (the default). */
  async function run(
    name: string,
    work: () => Promise<Outcome | null>,
    options: { refresh?: boolean } = {},
  ): Promise<Outcome | null> {
    setPending(name);
    setOutcome(null);
    const result = await work();
    setPending(null);
    setOutcome(result);
    if (result?.kind === "ok" && options.refresh !== false) router.refresh();
    return result;
  }

  return { pending, outcome, run, clear: () => setOutcome(null) };
}

/** The issue of a field in a failed outcome, if the server named one. */
export function issueOf(
  outcome: Outcome | null,
  field: string,
): RequestIssue | undefined {
  return outcome?.kind === "failed"
    ? outcome.issues.find((issue) => issue.field === field)
    : undefined;
}
