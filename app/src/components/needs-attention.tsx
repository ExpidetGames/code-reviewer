// SPDX-License-Identifier: Apache-2.0

// The one attention region of a screen (#173): the notices a person has to act on, as up to
// `maxRows` rows, and nothing while there is nothing to attend to. Built on the kit's Alert so
// #174 and #178 reuse it under the same accessible name, "Needs attention". The rows beyond
// `maxRows` go behind a HelpDisclosure: the strip stays short, nothing is lost.
"use client";

import { useId, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { HelpDisclosure } from "@/components/help-disclosure";
import { cn } from "@/lib/utils";

export type AttentionNotice = {
  id: string;
  severity: "error" | "warning";
  title: string;
  detail: ReactNode;
};

export function NeedsAttention({
  notices,
  maxRows = 2,
  className,
}: {
  /** What a person must act on, in the order they should read it. */
  notices: readonly AttentionNotice[];
  /** How many rows stay open; the rest go behind a disclosure. */
  maxRows?: number;
  className?: string;
}) {
  const headingId = `${useId()}-attention`;
  if (notices.length === 0) return null;
  const rows = notices.slice(0, maxRows);
  const rest = notices.slice(maxRows);
  return (
    <section
      aria-labelledby={headingId}
      className={cn("flex flex-col gap-3", className)}
    >
      <h2 id={headingId} className="text-sm font-medium text-muted-foreground">
        Needs attention
      </h2>
      {rows.map((notice) => (
        <Alert
          key={notice.id}
          variant={notice.severity === "error" ? "destructive" : "warning"}
        >
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.detail}</AlertDescription>
        </Alert>
      ))}
      {rest.length > 0 ? (
        <HelpDisclosure
          label={`${String(rest.length)} more ${
            rest.length === 1 ? "notice" : "notices"
          }`}
        >
          <ul className="flex flex-col gap-1">
            {rest.map((notice) => (
              <li key={notice.id}>
                <span className="font-medium">{notice.title}</span>
                {" — "}
                <span>{notice.detail}</span>
              </li>
            ))}
          </ul>
        </HelpDisclosure>
      ) : null}
    </section>
  );
}
