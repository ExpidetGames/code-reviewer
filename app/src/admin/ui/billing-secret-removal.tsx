// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// Forgetting a saved Stripe credential (#504), in a confirmed danger zone below the cards: only while billing is off (a removed
// credential would turn a running billing off without a word), and only for a credential that is saved.
import { DangerZone } from "../../components/danger-zone.tsx";
import type { BillingApi } from "./billing-api.ts";
import { describeBillingFailure } from "./billing-messages.ts";
import { OutcomeNote, useBillingRun } from "./billing-run.tsx";
import type { BillingView } from "./billing-view.ts";

export function BillingSecretRemoval({
  billing,
  api,
}: {
  billing: BillingView;
  api: BillingApi;
}) {
  const { outcome, run } = useBillingRun();
  if (billing.adapter !== "stripe" || billing.enabled) return null;
  const secrets = (
    [
      ["apiKey", "API key", billing.stripe.apiKey],
      ["webhookSecret", "webhook secret", billing.stripe.webhookSecret],
    ] as const
  ).filter(([, , secret]) => secret.state !== "not_configured");
  if (secrets.length === 0) return null;
  return (
    <>
      {secrets.map(([which, what]) => (
        <DangerZone
          key={which}
          title={`Remove the ${what}`}
          description={`Only when code-review.com should no longer use this ${what}.`}
          actionLabel={`Remove the ${what}`}
          confirmTitle={`Remove the ${what}?`}
          confirmDescription="Billing stays off until a new one is saved."
          confirmLabel={`Remove the ${what}`}
          onConfirm={() =>
            void run(`remove-${which}`, async () => {
              const removed = await api.change({ removeSecret: which });
              return removed.ok
                ? { kind: "ok", text: "Removed." }
                : {
                    kind: "failed",
                    text: describeBillingFailure(removed.code),
                    issues: [],
                    missing: [],
                  };
            })
          }
        />
      ))}
      <OutcomeNote outcome={outcome} />
    </>
  );
}
