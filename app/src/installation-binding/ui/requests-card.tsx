// SPDX-License-Identifier: Apache-2.0

"use client";
// The Requests card of the Connections page (#176): compact rows for the links that wait for the
// instance admin (GitHub could not check who owns the account), or a single empty line while there is
// nothing to decide. An Owner or Admin sees it; a Member never renders it. The account name comes
// from GitHub: text, truncated, never markup. Status is not told by colour alone; the badge label
// carries the meaning.
import { useId } from "react";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import type { RequestView } from "./connections-page.tsx";
import { REQUEST_STATUS_COPY } from "./messages.ts";

const REQUEST_VARIANT: Record<
  RequestView["status"],
  "success" | "warning" | "neutral"
> = {
  pending: "warning",
  approved: "success",
  denied: "warning",
  withdrawn: "neutral",
};

export function RequestsCard({ requests }: { requests: RequestView[] }) {
  const titleId = useId();
  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle>
          <h2
            id={titleId}
            className="text-lg leading-7 font-semibold tracking-normal"
          >
            Requests
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">No requests waiting.</p>
        ) : (
          <ul
            aria-label="Requests for the instance admin"
            className="flex flex-col divide-y divide-border"
          >
            {requests.map((request) => (
              <li
                key={request.id}
                data-request={request.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-4 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="min-w-0 truncate font-semibold text-foreground">
                    {request.accountLogin}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    Asked{" "}
                    <time dateTime={request.createdAt}>
                      {formatUtc(request.createdAt)}
                    </time>
                  </span>
                </div>
                <Badge variant={REQUEST_VARIANT[request.status]}>
                  {REQUEST_STATUS_COPY[request.status]}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
