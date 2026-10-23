// SPDX-License-Identifier: Apache-2.0

// The banner of the admin portal while billing is switched on but its setup is not complete (#632). The claim refuses every
// review of the instance then (`billing_rates_incomplete`), which no admin would notice on a page they do not open, so the frame
// of the portal shows it on every page, with what is missing (the stable codes of `src/billing/readiness.ts`, in words) and a
// link to the Billing page. Nothing while nothing is missing. No icon: the words carry it.
import Link from "next/link";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import {
  BILLING_INCOMPLETE_ACTION_LEAD,
  BILLING_INCOMPLETE_ACTION_LINK,
  BILLING_INCOMPLETE_ACTION_TAIL,
  BILLING_INCOMPLETE_DETAIL,
  BILLING_INCOMPLETE_TITLE,
  describeMissingItem,
} from "./billing-messages.ts";

const TITLE_ID = "billing-incomplete-banner-title";

export function BillingIncompleteBanner({
  missing,
}: {
  /** What keeps billing from running, by stable code; empty while nothing does. */
  missing: readonly string[];
}) {
  if (missing.length === 0) return null;
  return (
    <Alert
      variant="destructive"
      role="region"
      aria-labelledby={TITLE_ID}
      className="mb-6"
    >
      <AlertDescription>
        <h2 id={TITLE_ID} className="font-semibold">
          {BILLING_INCOMPLETE_TITLE}
        </h2>
        <p>{BILLING_INCOMPLETE_DETAIL}</p>
        <ul className="list-disc pl-5">
          {missing.map((item) => (
            <li key={item}>{describeMissingItem(item)}</li>
          ))}
        </ul>
        <p>
          {BILLING_INCOMPLETE_ACTION_LEAD}{" "}
          <Link href="/admin/billing" className="underline">
            {BILLING_INCOMPLETE_ACTION_LINK}
          </Link>
          {BILLING_INCOMPLETE_ACTION_TAIL}
        </p>
      </AlertDescription>
    </Alert>
  );
}
