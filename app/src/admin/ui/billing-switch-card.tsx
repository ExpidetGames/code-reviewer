// SPDX-License-Identifier: Apache-2.0

"use client";
// The switch of billing and the statement of what it does (#504, ADR 0006, 2.14). Billing is off until the admin switches it
// on here; the statement is the server's wording (`enablingNotice`) with the counts of this instance, and the list says what
// still stands between the instance and a billing that can be on. The server judges every step: switching on an incomplete
// setup is refused with the missing items named, switching off is always possible and leaves the journal alone.
import { useId } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { FieldDescription, FieldLabel } from "../../components/ui/field.tsx";
import { Switch } from "../../components/ui/switch.tsx";
import type { BillingApi } from "./billing-api.ts";
import {
  describeBillingFailure,
  describeMissingItem,
} from "./billing-messages.ts";
import { missingOf, OutcomeNote, useBillingRun } from "./billing-run.tsx";
import type { BillingView } from "./billing-view.ts";

export function BillingSwitchCard({
  billing,
  notice,
  api,
}: {
  billing: BillingView;
  /** The paragraphs that say what switching billing on does (`enablingNotice`), made by the server. */
  notice: string[];
  api: BillingApi;
}) {
  const ids = useId();
  const { pending, outcome, run } = useBillingRun();
  const running = billing.on;
  const dormant = billing.enabled && !billing.on;

  function toggle(enabled: boolean) {
    return run("switch", async () => {
      const result = await api.change({ enabled });
      if (result.ok)
        return {
          kind: "ok",
          text: enabled ? "Billing is on." : "Billing is off.",
        };
      return {
        kind: "failed",
        text: describeBillingFailure(result.code),
        issues: result.issues,
        missing: missingOf(result.details),
      };
    });
  }

  return (
    <Card role="region" aria-labelledby={`${ids}-switch`}>
      <CardHeader>
        <CardTitle>
          <h2
            id={`${ids}-switch`}
            className="text-lg font-semibold tracking-tight"
          >
            Billing is {running ? "on" : "off"}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {billing.enabled ? null : (
          <div className="flex flex-col gap-2 text-sm">
            {notice.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        )}
        {dormant ? (
          <Alert variant="warning" role="note">
            <AlertDescription>
              <strong>The switch is on, but billing is not running.</strong>{" "}
              Something it needs is missing or changed, so every review is
              refused and its pull request gets a notice that no review ran.
              Complete the list below, or switch billing off (reviews then run
              without charge).
            </AlertDescription>
          </Alert>
        ) : null}
        {running || billing.missing.length === 0 ? null : (
          <div className="text-sm">
            <p className="font-medium">Before billing can be on:</p>
            <ul className="list-disc pl-5">
              {billing.missing.map((item) => (
                <li key={item}>{describeMissingItem(item)}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex items-center gap-3">
          <Switch
            id={`${ids}-enabled`}
            checked={billing.enabled}
            disabled={pending === "switch"}
            onCheckedChange={(checked) => void toggle(checked)}
          />
          <FieldLabel htmlFor={`${ids}-enabled`}>
            {billing.enabled ? "Billing is switched on" : "Switch billing on"}
          </FieldLabel>
        </div>
        <FieldDescription>
          Switching on needs the factor A, both rates and the AI reserve; with
          Stripe also the API key, the webhook secret, a passing connection
          check and the link to your terms. Switching off is always possible and leaves every balance and
          the journal as they are.
        </FieldDescription>
        <OutcomeNote outcome={outcome} describeMissing={describeMissingItem} />
      </CardContent>
    </Card>
  );
}
