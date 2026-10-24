// SPDX-License-Identifier: LicenseRef-Proprietary

// A dense term/description list (run facts, instance facts): a real `<dl>` so assistive technology
// pairs each term with its value. Two columns on a wide screen, one on a narrow one, and the value
// wraps instead of widening the page (a commit hash or a GitHub name is unbroken text). Ours
// (proprietary); the tables of `components/ui/table.tsx` cover lists that need columns and a header
// instead.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function DescriptionList({
  items,
  className,
}: {
  items: readonly { term: ReactNode; description: ReactNode }[];
  className?: string;
}) {
  return (
    <dl className={cn("grid gap-2 text-sm", className)}>
      {items.map((item, index) => (
        <div
          key={index}
          className="grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:gap-x-4"
        >
          <dt className="text-muted-foreground">{item.term}</dt>
          <dd className="min-w-0 break-words text-foreground">
            {item.description}
          </dd>
        </div>
      ))}
    </dl>
  );
}
