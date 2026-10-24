// SPDX-License-Identifier: LicenseRef-Proprietary

// The banner on the pages of a workspace for an Owner and an Admin while the balance is low, zero or below zero (#506, ADR 0006,
// D9): what is the matter, the balance, and a link to the billing page. A Member never gets one; the pull request notice of the
// refusal (#498) is what they see. A server component: no state, no script. The words are in `messages.ts`.
import Link from "next/link";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import type { BalanceBannerView } from "../banner.ts";
import {
  BANNER_BALANCE_LABEL,
  BANNER_COPY,
  BANNER_LINK_TEXT,
} from "../messages.ts";
import { formatMoney } from "../money.ts";

export function BalanceBanner({ view }: { view: BalanceBannerView }) {
  const copy = BANNER_COPY[view.level];
  return (
    <Alert
      variant={view.level === "low" ? "warning" : "destructive"}
      // A low balance is a heads-up, not an interruption; an empty one is what stops reviews.
      role={view.level === "low" ? "status" : "alert"}
      data-slot="balance-banner"
      className="mb-6"
    >
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>
        <p>{copy.body}</p>
        <p>
          {BANNER_BALANCE_LABEL}:{" "}
          <span className="font-semibold tabular-nums">
            {formatMoney(view.balanceMicroUsd)}
          </span>
          {" · "}
          <Link href={view.billingHref} className="underline">
            {BANNER_LINK_TEXT}
          </Link>
        </p>
      </AlertDescription>
    </Alert>
  );
}
