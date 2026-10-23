// SPDX-License-Identifier: Apache-2.0

"use client";
// The billing page of a workspace, `/w/:ws/settings/billing` (ADR 0006, 2.5; #505): the balance, adding credit, the payments on
// their way, the billing details, the invoices, the journal with the price of each review, the monthly limit, and whose key reviews run on. It
// replaces the plan and usage page while billing is on. An Owner or an Admin changes things; a Member reads the balance and the
// journal. The server renders the first view and renders it again after every change (`router.refresh()`); a person who comes back
// from the payment page gets a note, and the page looks again for the credit until it arrives.
import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { SettingsScreen } from "../../workspaces/ui/settings-shell.tsx";
import {
  browserWorkspaceBillingApi,
  type WorkspaceBillingApi,
} from "../api.ts";
import {
  READ_ONLY_TEXT,
  RETURN_CANCELLED,
  RETURN_SUCCESS,
} from "../messages.ts";
import type { WorkspaceBillingView } from "../view.ts";
import { BalanceCard } from "./balance-card.tsx";
import { BillingNotes } from "./billing-notes.tsx";
import { InvoicesCard } from "./invoices-card.tsx";
import { JournalCard } from "./journal-card.tsx";
import { MonthlyLimitCard } from "./monthly-limit-card.tsx";
import { PendingTopUps } from "./pending-top-ups.tsx";
import { ProfileCard } from "./profile-card.tsx";
import { TopUpCard } from "./top-up-card.tsx";

/** How often the page looks again for a payment that was just made, and for how long. */
export const RETURN_REFRESH_MS = 4_000;
export const RETURN_REFRESH_LIMIT_MS = 150_000;

/** After a return from the payment page, asks the server for the page again until nothing is pending (or the time is up). */
function ReturnRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > RETURN_REFRESH_LIMIT_MS) {
        clearInterval(timer);
        return;
      }
      router.refresh();
    }, RETURN_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}

export function BillingPageContent({
  workspaceSlug,
  view,
  returned,
  termsHref,
  privacyHref,
  api: apiProp,
  navigate = (url) => window.location.assign(url),
}: {
  workspaceSlug: string;
  view: WorkspaceBillingView;
  /** The payment page sent the person back with `?topup=success` or `?topup=cancelled`. */
  returned: "success" | "cancelled" | null;
  /** The operator's terms, when the instance has set a link to them; null shows no link. */
  termsHref: string | null;
  /** The operator's privacy statement, when the instance has set a link to it; null shows no link. */
  privacyHref: string | null;
  /** Only tests pass these: a server component cannot hand functions to a client component. */
  api?: WorkspaceBillingApi;
  navigate?: (url: string) => void;
}) {
  // One api for the life of the page: the invoices card asks again when it changes.
  const api = useMemo(
    () => apiProp ?? browserWorkspaceBillingApi(workspaceSlug),
    [apiProp, workspaceSlug],
  );
  return (
    <SettingsScreen workspaceSlug={workspaceSlug} current="billing" showBilling>
      <div className="flex max-w-[64rem] flex-col gap-6">
        {returned === null ? null : (
          <Alert
            variant={returned === "success" ? "info" : "default"}
            role="status"
          >
            <AlertDescription>
              {returned === "success" ? RETURN_SUCCESS : RETURN_CANCELLED}
            </AlertDescription>
          </Alert>
        )}
        <ReturnRefresh
          active={returned === "success" && view.pendingTopUps.length > 0}
        />
        <BalanceCard view={view} />
        {view.canManage ? null : (
          <p className="text-sm text-muted-foreground">{READ_ONLY_TEXT}</p>
        )}
        {view.canManage || !view.topUpAvailable ? (
          <TopUpCard
            view={view}
            api={api}
            navigate={navigate}
            termsHref={termsHref}
            privacyHref={privacyHref}
          />
        ) : null}
        {view.canManage ? (
          <PendingTopUps items={view.pendingTopUps} api={api} />
        ) : null}
        {view.canManage && view.profileRequired ? (
          <ProfileCard profile={view.profile} api={api} />
        ) : null}
        {view.canManage && view.topUpAvailable ? (
          <InvoicesCard api={api} refreshKey={view.balanceMicroUsd} />
        ) : null}
        <JournalCard
          workspaceSlug={workspaceSlug}
          initial={view.journal}
          api={api}
        />
        {view.canManage ? (
          <MonthlyLimitCard
            limitCents={view.monthlyLimitCents}
            chargedMicroUsd={view.chargedThisMonthMicroUsd}
            api={api}
          />
        ) : null}
        <BillingNotes
          workspaceSlug={workspaceSlug}
          keyMode={view.keyMode}
          showInvoices={view.topUpAvailable}
        />
      </div>
    </SettingsScreen>
  );
}
