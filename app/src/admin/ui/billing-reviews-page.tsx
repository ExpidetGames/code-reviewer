// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The billing review rows of the admin portal (#603, ADR 0006): the events the webhook recorded as money that moved (or claimed
// to) and changed nothing in the ledger, so a buyer who paid and was not credited is seen here and not only in a log. Open rows
// first, resolved ones on request, 25 to a page, newest first; the state and the page are in the address. Instance admin only.
import Link from "next/link";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import {
  browserBillingReviewApi,
  type BillingReviewApi,
} from "./billing-review-api.ts";
import { BillingReviewRow } from "./billing-review-row.tsx";
import type { BillingReviewListView } from "./billing-review-view.ts";

const BASE = "/admin/billing/reviews";

/** The address of a state and page: the defaults (open, page 1) are left out. */
export function reviewsHref(state: "open" | "resolved", page = 1): string {
  const params = new URLSearchParams();
  if (state === "resolved") params.set("state", "resolved");
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query === "" ? BASE : `${BASE}?${query}`;
}

// No prefetch: Next.js answers a prefetch of a portal page from its prerender, which knows nothing of the address's query, so a
// prefetched `?state=resolved` would show the first page of the open rows (found by the journey, #603-T18).
const LINK_CLASS =
  "rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline";

export function BillingReviewsPage({
  list,
  api = browserBillingReviewApi,
}: {
  list: BillingReviewListView;
  /** Only tests pass this. */
  api?: BillingReviewApi;
}) {
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  return (
    <div className="flex flex-col gap-6">
      <HelpDisclosure label="How this works">
        When Stripe tells this app about a payment, refund or dispute and the
        app cannot apply it as it is (the amount does not fit, or it belongs to
        no top-up of ours), nothing is credited or debited and the event is
        listed here. Closing a row only records that you dealt with it: it
        changes no money. To repair it, credit or correct the workspace by hand
        (the entry is written to the journal with your name, once per row), or
        use Check payment to ask Stripe about the top-up again. The list holds
        ids and a reason, never the payment itself or anything about the buyer;
        look the payment up in the Stripe dashboard.
      </HelpDisclosure>

      <nav aria-label="State of the rows" className="flex items-center gap-4">
        <Link
          prefetch={false}
          href={reviewsHref("open")}
          aria-current={list.state === "open" ? "page" : undefined}
          className={`${LINK_CLASS} ${list.state === "open" ? "underline" : ""}`}
        >
          Open ({list.openTotal})
        </Link>
        <Link
          prefetch={false}
          href={reviewsHref("resolved")}
          aria-current={list.state === "resolved" ? "page" : undefined}
          className={`${LINK_CLASS} ${list.state === "resolved" ? "underline" : ""}`}
        >
          Resolved
        </Link>
      </nav>

      {list.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {list.total > 0
            ? "There are no rows on this page."
            : list.state === "open"
              ? "No payment needs a review."
              : "No review has been closed yet."}
        </p>
      ) : (
        <ul
          aria-label={
            list.state === "open" ? "Open reviews" : "Resolved reviews"
          }
          className="flex flex-col gap-4"
        >
          {list.rows.map((review) => (
            <BillingReviewRow
              key={`${review.provider}:${review.eventId}`}
              review={review}
              api={api}
            />
          ))}
        </ul>
      )}

      {pages > 1 ? (
        <nav
          aria-label="Pages"
          className="flex items-center justify-between gap-4"
        >
          {list.page > 1 ? (
            <Link
              prefetch={false}
              href={reviewsHref(list.state, list.page - 1)}
              className={LINK_CLASS}
            >
              Previous page
            </Link>
          ) : (
            <span />
          )}
          <span className="text-sm text-muted-foreground">
            Page {list.page} of {pages}
          </span>
          {list.page < pages ? (
            <Link
              prefetch={false}
              href={reviewsHref(list.state, list.page + 1)}
              className={LINK_CLASS}
            >
              Next page
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
