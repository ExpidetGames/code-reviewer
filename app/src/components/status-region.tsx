// SPDX-License-Identifier: Apache-2.0

// The polite live region for a result message ("2 new repositories.", "Saved."). shadcn has no
// equivalent; this is a small Apache-2.0 app component. `role="status"` plus `aria-live="polite"`
// means a screen reader announces the change without stealing focus.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function StatusRegion({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn("text-sm text-muted-foreground", className)}
    >
      {children}
    </div>
  );
}
