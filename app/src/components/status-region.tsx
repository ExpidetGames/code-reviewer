// SPDX-License-Identifier: Apache-2.0

// The polite live region for a result message ("2 new repositories.", "Saved."). shadcn has no
// equivalent; this is a small Apache-2.0 app component. `role="status"` plus `aria-live="polite"`
// means a screen reader announces the change without stealing focus. While it is empty it stays in
// the DOM (so the next message is announced) but out of the flow, so it adds no gap to a stacked page.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function StatusRegion({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  /** An accessible name that tells two live regions of one page apart (for example "Updating the run"). */
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      {...(label === undefined ? {} : { "aria-label": label })}
      className={cn("text-sm text-muted-foreground empty:absolute", className)}
    >
      {children}
    </div>
  );
}
