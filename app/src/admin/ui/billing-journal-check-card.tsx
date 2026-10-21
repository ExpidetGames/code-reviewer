// SPDX-License-Identifier: Apache-2.0

// What the daily check of the billing journal found the last time (#626): "Journal check: ok (date)" or "inconsistent (date)". The check
// compares, for every workspace, the cached balance with the journal and looks for holds nobody released; it runs once a day while
// billing is on (a step of the cron sweep, and the timer of a server). Nothing here runs it or changes anything: the page only reports.
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import type { BillingView } from "./billing-view.ts";

export function BillingJournalCheckCard({ billing }: { billing: BillingView }) {
  const check = billing.journalCheck;
  const workspaces = (count: number) =>
    `${String(count)} ${count === 1 ? "workspace" : "workspaces"}`;
  return (
    <Card role="region" aria-labelledby="billing-journal-check">
      <CardHeader>
        <CardTitle>
          <h2
            id="billing-journal-check"
            className="text-lg font-semibold tracking-tight"
          >
            Journal check
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {check.state === "never" || check.checkedAt === null ? (
          <p>Journal check: not run yet</p>
        ) : (
          <p className="font-medium">
            {`Journal check: ${check.state} (${formatUtc(check.checkedAt)})`}
          </p>
        )}
        {check.state === "ok" ? (
          <p className="text-muted-foreground">
            Every balance equals its journal; {workspaces(check.workspaces)}{" "}
            checked.
          </p>
        ) : null}
        {check.state === "inconsistent" ? (
          <Alert variant="warning" role="alert">
            <AlertDescription>
              {String(check.inconsistentWorkspaces)} of{" "}
              {workspaces(check.workspaces)} had a balance that does not equal
              its journal, or a hold nobody released. The log names each one:
              search it for BILLING_JOURNAL_INCONSISTENT.
            </AlertDescription>
          </Alert>
        ) : null}
        <p className="text-muted-foreground">
          The check compares every workspace&apos;s balance with its journal
          once a day while billing is on
          {billing.on ? "." : "; it is paused while billing is off."}
        </p>
      </CardContent>
    </Card>
  );
}
