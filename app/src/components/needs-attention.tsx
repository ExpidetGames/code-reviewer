// SPDX-License-Identifier: LicenseRef-Proprietary

// The one attention region of a screen (#173): the notices a person has to act on, as up to
// `maxRows` rows, and nothing while there is nothing to attend to. Built on the kit's alert look so
// #174 and #178 reuse it under the same accessible name, "Needs attention". The rows are static
// content, so they carry no `role="alert"` — only the labelled region announces them. The rows beyond
// `maxRows` go behind a HelpDisclosure: the strip stays short, nothing is lost.
"use client";

import { useId, type ReactNode } from "react";
import { WarningIcon, XCircleIcon } from "@phosphor-icons/react/dist/ssr";
import {
  AlertDescription,
  AlertTitle,
  alertVariants,
} from "@/components/ui/alert";
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
      // The board's attention card (#633): a surface card, or the todo pair when every notice is a
      // warning; each row carries its symbol next to the words.
      className={cn(
        "flex flex-col gap-4 rounded-2xl border p-6",
        notices.every((notice) => notice.severity === "warning")
          ? "border-warning bg-warning-soft text-warning"
          : "border-border bg-card text-foreground",
        className,
      )}
    >
      <h2 id={headingId} className="text-lg leading-7 tracking-normal">
        Needs attention
      </h2>
      {rows.map((notice) => (
        <div
          key={notice.id}
          data-slot="attention-row"
          className={cn(
            alertVariants({
              variant: notice.severity === "error" ? "destructive" : "warning",
            }),
          )}
        >
          {notice.severity === "error" ? (
            <XCircleIcon aria-hidden="true" />
          ) : (
            <WarningIcon aria-hidden="true" />
          )}
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.detail}</AlertDescription>
        </div>
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
                <span className="font-semibold">{notice.title}</span>
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
